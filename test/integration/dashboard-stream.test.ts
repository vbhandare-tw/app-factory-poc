/**
 * Live updates end to end (plan Phase 5): a real dashboard on 127.0.0.1, SSE
 * read off a real socket, MockRunner agents. Hosted events come from the tee,
 * `external` / `stopped` events from the event-log tail, and every vault write
 * surfaces as `state_changed` from the vault watcher — each exactly once.
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { runDashboard } from '../../src/cli/dashboard.js';
import type { DashboardSeams, RunningDashboard } from '../../src/cli/dashboard.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { buildProgram } from '../../src/cli/main.js';
import { ChangeBus } from '../../src/dashboard/changeBus.js';
import type { ChangeMessage } from '../../src/dashboard/changeBus.js';
import { WATCH_DEBOUNCE_MS } from '../../src/dashboard/constants.js';
import { TeeEventSink } from '../../src/dashboard/teeEvents.js';
import { toSteps } from '../../src/dashboard/transcriptView.js';
import { fencedBlock } from '../../src/domain/markdown.js';
import type { FeatureFrontmatter } from '../../src/domain/types.js';
import type { EventSink } from '../../src/log/events.js';
import { startOrchestrator } from '../../src/orchestrator/host.js';
import { InstanceLock } from '../../src/orchestrator/lock.js';
import type { Runner } from '../../src/runner/types.js';
import { appendToSection } from '../../src/vault/storage.js';
import { delay } from '../helpers/dashboardFixtures.js';
import { makeFeature } from '../helpers/notes.js';
import { factoryVault, pipelineRunner, readNoteFile, tlPayload } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

const SLUG = 'alpha';
const FEATURE_ID = 'FEAT-ALPHA';
const PAUSED_AT = '2026-09-24T09:00:00.000Z';
const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };
/** Long enough for a debounce window to close and FSEvents' start-up replay to arrive. */
const SETTLE_MS = WATCH_DEBOUNCE_MS + 400;

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

interface SseMessage {
  readonly event: string;
  readonly data: Record<string, unknown>;
  readonly at: number;
}

interface SseClient {
  readonly messages: SseMessage[];
  readonly openedAt: number;
  waitFor(predicate: (message: SseMessage) => boolean, timeoutMs: number, what: string): Promise<SseMessage>;
  close(): void;
}

let vault: FactoryFixture | undefined;
let home: string;
let launched: RunningDashboard[];
let streams: SseClient[];

function request(
  base: string,
  method: 'GET' | 'POST',
  pathname: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Promise<Reply> {
  const url = new URL(pathname, base);
  const body = options.body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          host: url.host,
          connection: 'close',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token === undefined ? {} : { 'x-factory-token': options.token }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Not JSON: `/` is HTML.
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** `GET /api/stream[?run=]`, parsed as it arrives. Resolves once the server says it is subscribed. */
function openStream(base: string, query = ''): Promise<SseClient> {
  const url = new URL(`/api/stream${query}`, base);
  const messages: SseMessage[] = [];
  return new Promise((resolve, reject) => {
    let connected = false;
    let buffer = '';
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: { host: url.host, accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        if (res.statusCode !== 200) {
          let text = '';
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => reject(new Error(`GET ${url.pathname}${url.search} → ${res.statusCode}: ${text}`)));
          return;
        }
        expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) {
                if (!connected && line.includes('connected')) {
                  connected = true;
                  resolve(client);
                }
              } else if (line.startsWith('event: ')) {
                event = line.slice('event: '.length);
              } else if (line.startsWith('data: ')) {
                data.push(line.slice('data: '.length));
              }
            }
            if (data.length > 0) {
              messages.push({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown>, at: Date.now() });
            }
          }
        });
      },
    );
    req.on('error', (error) => {
      if (!connected) reject(error);
    });
    req.end();

    const client: SseClient = {
      messages,
      openedAt: Date.now(),
      async waitFor(predicate, timeoutMs, what) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = messages.find(predicate);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out after ${timeoutMs} ms waiting for ${what}; got ${JSON.stringify(messages.map((m) => m.event))}`,
            );
          }
          await delay(10);
        }
      },
      close: () => req.destroy(),
    };
    streams.push(client);
  });
}

async function tokenOf(base: string): Promise<string> {
  const page = await request(base, 'GET', '/');
  const match = /<meta name="factory-token" content="([0-9a-f]{64})">/.exec(page.text);
  if (match?.[1] === undefined) throw new Error(`no token in GET / (status ${page.status})`);
  return match[1];
}

async function waitFor<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(20);
  }
}

function events(v: FactoryFixture): Record<string, unknown>[] {
  if (!existsSync(v.paths.eventLog())) return [];
  const parsed: Record<string, unknown>[] = [];
  for (const line of readFileSync(v.paths.eventLog(), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A line still being written.
    }
  }
  return parsed;
}

function withoutTs(event: unknown): Record<string, unknown> {
  const { ts: _ts, ...rest } = event as Record<string, unknown>;
  return rest;
}

function feature(v: FactoryFixture): FeatureFrontmatter {
  return readNoteFile(v.paths.featureNote(SLUG)).frontmatter as FeatureFrontmatter;
}

function eventOf(message: SseMessage): Record<string, unknown> {
  return message.data['event'] as Record<string, unknown>;
}

function isEvent(type: string, match: Record<string, unknown> = {}): (message: SseMessage) => boolean {
  return (message) =>
    message.event === 'event' &&
    eventOf(message)['type'] === type &&
    Object.entries(match).every(([key, value]) => eventOf(message)[key] === value);
}

const isApproval = isEvent('item_transitioned', { itemId: FEATURE_ID, from: 'needs_human', actor: 'human' });

function deps(v: FactoryFixture, runner?: Runner): CliDeps {
  return {
    cwd: v.root,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: () => undefined,
    err: () => undefined,
    now: () => new Date().toISOString(),
    ...(runner === undefined ? {} : { runner }),
  };
}

async function launch(v: FactoryFixture, runner?: Runner, seams: DashboardSeams = {}): Promise<RunningDashboard> {
  const dashboard = await runDashboard({ vault: v.root, port: 0, open: false }, deps(v, runner), {
    signals: new EventEmitter(),
    openUrl: () => undefined,
    exit: () => undefined,
    ...seams,
  });
  launched.push(dashboard);
  return dashboard;
}

async function plantFeature(v: FactoryFixture): Promise<void> {
  mkdirSync(v.paths.featureDir(SLUG), { recursive: true });
  await v.storage.writeNote(
    v.paths.featureNote(SLUG),
    makeFeature(
      {
        id: FEATURE_ID,
        slug: SLUG,
        title: SLUG,
        created_at: '2026-09-24T08:00:00.000Z',
        updated_at: '2026-09-24T08:00:00.000Z',
      },
      appendToSection('', SECTION.rawRequirement, fencedBlock('# Add subtract\n', 'markdown')),
    ),
  );
}

async function checkpoint(v: FactoryFixture): Promise<void> {
  mkdirSync(v.paths.featureDir(SLUG), { recursive: true });
  await v.storage.writeNote(
    v.paths.featureNote(SLUG),
    makeFeature({
      id: FEATURE_ID,
      slug: SLUG,
      title: SLUG,
      status: 'needs_human',
      pause_reason: 'checkpoint',
      pause_detail: 'after_pm_refinement',
      resume_to: 'planning',
      reject_to: 'refining',
      paused_at: PAUSED_AT,
    }),
  );
}

/** A line written by a process that is not this one. */
function appendFromAnotherProcess(file: string, text: string): void {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('node:fs').appendFileSync(process.argv[1], process.argv[2])", file, text],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

function foreignLine(cycle: number): string {
  return `${JSON.stringify({ ts: '2026-09-24T10:00:00.000Z', type: 'cycle_started', cycle })}\n`;
}

function say(text: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
}

function delivery(id: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'StructuredOutput', input: {} }] } })}\n`;
}

function echo(id: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Structured output provided successfully' }] },
  })}\n`;
}

/** A run the event log already knows about, with a transcript (two lines unless given). */
function plantRun(v: FactoryFixture, runId: string, transcript = say('one') + say('two')): string {
  const logFile = path.join(v.paths.logsDir(), SLUG, `${FEATURE_ID}-1-pm.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, transcript);
  writeFileSync(
    v.paths.eventLog(),
    `${JSON.stringify({
      ts: '2026-09-24T10:00:00.000Z',
      type: 'run_started',
      runId,
      role: 'pm',
      itemId: FEATURE_ID,
      attempt: 1,
      model: 'sonnet',
      pid: 1,
      logPath: logFile,
    })}\n`,
  );
  return logFile;
}

async function startHosted(dashboard: RunningDashboard, token: string): Promise<void> {
  expect((await request(dashboard.url, 'POST', '/api/factory/start', { token })).status).toBe(202);
}

async function firstCheckpoint(v: FactoryFixture): Promise<void> {
  await waitFor(() => feature(v).status === 'needs_human', 10_000, 'the first checkpoint');
  await waitFor(
    () => events(v).some((event) => event['type'] === 'cycle_finished' && event['cycle'] === 1),
    5_000,
    'cycle 1 to finish',
  );
}

beforeEach(() => {
  vault = undefined;
  home = scratchFactoryHome();
  launched = [];
  streams = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stream of streams) stream.close();
  for (const dashboard of launched) await dashboard.close({ force: true });
  vault?.cleanup();
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('hosted mode', () => {
  it('an HTTP approve → the client receives the approval’s item_transitioned, then state_changed, each exactly once', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    await plantFeature(v);
    // The Tech Lead run the approval releases is slow, so nothing else writes while we watch.
    const dashboard = await launch(v, pipelineRunner({ tl_plan: { structured: tlPayload(), delayMs: 30_000 } }));
    const token = await tokenOf(dashboard.url);
    await startHosted(dashboard, token);
    await firstCheckpoint(v);

    const stream = await openStream(dashboard.url);
    await delay(SETTLE_MS);
    stream.messages.length = 0;

    const approved = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, {
      token,
      body: { note: 'go' },
    });
    expect(approved).toMatchObject({ status: 200, json: { to: 'planning', held: false } });
    await stream.waitFor((m) => m.event === 'state_changed', 5_000, 'state_changed');
    await delay(SETTLE_MS);

    const approvals = stream.messages.filter(isApproval);
    const changes = stream.messages.filter((m) => m.event === 'state_changed');
    expect(approvals).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(stream.messages.indexOf(approvals[0]!)).toBeLessThan(stream.messages.indexOf(changes[0]!));
    expect(approvals[0]!.data).toMatchObject({
      event: { type: 'item_transitioned', itemId: FEATURE_ID, from: 'needs_human', to: 'planning', note: 'approve: go' },
      summary: expect.any(String),
    });
    expect(changes[0]!.data['itemIds']).toContain(FEATURE_ID);
    expect(events(v).filter((event) => event['type'] === 'item_transitioned' && event['actor'] === 'human')).toHaveLength(1);
  });

  it('an HTTP approve’s item_transitioned reaches the bus through the orchestrator’s sink, and is written once', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    await plantFeature(v);
    const dashboard = await launch(v, pipelineRunner({ tl_plan: { structured: tlPayload(), delayMs: 30_000 } }));
    const token = await tokenOf(dashboard.url);
    await startHosted(dashboard, token);
    await firstCheckpoint(v);
    const heard: ChangeMessage[] = [];
    dashboard.host.bus.subscribe((message) => heard.push(message));

    expect((await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, { token })).status).toBe(200);

    // Published by the tee before the handler answered: no waiting.
    const approvals = heard.filter(
      (m) => m.kind === 'event' && m.event.type === 'item_transitioned' && m.event['actor'] === 'human',
    );
    expect(approvals).toMatchObject([{ event: { itemId: FEATURE_ID, from: 'needs_human', to: 'planning' } }]);
    const written = events(v).filter((event) => event['type'] === 'item_transitioned' && event['actor'] === 'human');
    expect(written.map(withoutTs)).toEqual(approvals.map((m) => withoutTs(m.kind === 'event' ? m.event : null)));
  });

  it('a run started after launch is addressable at once: run_started reaches the RunIndex through the runner’s sink', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    await plantFeature(v);
    // No injected runner: the vault's `runner: mock` builds the MockRunner, given the dashboard's sink.
    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);
    const stream = await openStream(dashboard.url);

    await startHosted(dashboard, token);
    const started = await stream.waitFor(isEvent('run_started', { itemId: FEATURE_ID }), 10_000, 'run_started');
    const runId = eventOf(started)['runId'];

    const runs = await request(dashboard.url, 'GET', `/api/items/${FEATURE_ID}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.json['runs']).toContainEqual(expect.objectContaining({ runId, role: 'pm', attempt: 1 }));
    expect(events(v).filter((event) => event['type'] === 'run_started' && event['runId'] === runId)).toHaveLength(1);
  });
});

describe('stopped mode', () => {
  it('a line another process appends reaches the client from the tail; a CLI approve arrives as state_changed from the vault watcher', async () => {
    const v = (vault = factoryVault());
    await checkpoint(v);
    const dashboard = await launch(v);
    const stream = await openStream(dashboard.url);
    await delay(SETTLE_MS);
    stream.messages.length = 0;

    appendFromAnotherProcess(v.paths.eventLog(), foreignLine(901));
    const tailed = await stream.waitFor(isEvent('cycle_started', { cycle: 901 }), 5_000, 'the appended line');
    expect(tailed.data).toMatchObject({
      event: { ts: '2026-09-24T10:00:00.000Z', type: 'cycle_started', cycle: 901 },
      summary: expect.any(String),
    });
    stream.messages.length = 0;

    await buildProgram(deps(v), MANIFEST).parseAsync(['node', 'factory', 'approve', FEATURE_ID, '--vault', v.root]);
    expect(feature(v).status).toBe('planning');
    const changed = await stream.waitFor((m) => m.event === 'state_changed', 5_000, 'state_changed');
    expect(changed.data['itemIds']).toContain(FEATURE_ID);
    await delay(SETTLE_MS);
    // CLI approvals write no event (tech spec §4.2, corrected in Phase 4).
    expect(stream.messages.filter((m) => m.event === 'event')).toEqual([]);
  });
});

describe('across modes', () => {
  it('every event-log line reaches the client exactly once across stopped → hosted → stopped', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    await plantFeature(v);
    const dashboard = await launch(v, pipelineRunner());
    const token = await tokenOf(dashboard.url);
    const stream = await openStream(dashboard.url);

    appendFromAnotherProcess(v.paths.eventLog(), foreignLine(901));
    await stream.waitFor(isEvent('cycle_started', { cycle: 901 }), 5_000, 'the line appended while stopped');

    await startHosted(dashboard, token);
    await firstCheckpoint(v);
    expect((await request(dashboard.url, 'POST', '/api/factory/stop', { token })).status).toBe(202);
    await waitFor(
      async () => (await request(dashboard.url, 'GET', '/api/state')).json['mode'] === 'stopped',
      10_000,
      'the hosted run to stop',
    );

    appendFromAnotherProcess(v.paths.eventLog(), foreignLine(902));
    await stream.waitFor(isEvent('cycle_started', { cycle: 902 }), 5_000, 'the line appended after the hosted run');
    await delay(SETTLE_MS);

    const written = events(v).map(withoutTs);
    const received = stream.messages.filter((m) => m.event === 'event').map((m) => withoutTs(eventOf(m)));
    expect(written.length).toBeGreaterThan(5);
    expect(received).toEqual(written);
  });
});

describe('a Start that loses the lock race (plan Phase 5 review, fix 1)', () => {
  it('still delivers, exactly once, every line the winning terminal factory wrote while our start was failing', async () => {
    const v = (vault = factoryVault());
    let winner: InstanceLock | undefined;
    const dashboard = await launch(v, undefined, {
      // A terminal `factory start` takes the lock after our mode check and before our own attempt, and writes.
      startOrchestrator: async (input) => {
        winner = await InstanceLock.acquire(v.paths, {
          pollIntervalSec: v.config.poll_interval,
          pid: process.pid,
          host: 'another-terminal',
        });
        appendFromAnotherProcess(v.paths.eventLog(), foreignLine(801) + foreignLine(802));
        return await startOrchestrator(input);
      },
    });
    const token = await tokenOf(dashboard.url);
    const stream = await openStream(dashboard.url);

    try {
      const start = await request(dashboard.url, 'POST', '/api/factory/start', { token });
      expect(start.status).toBe(409);
      expect(start.json['message']).toMatch(/^another factory instance holds .* on another-terminal/);

      await stream.waitFor(isEvent('cycle_started', { cycle: 802 }), 5_000, "the winner's second line");
      await delay(SETTLE_MS);
      const received = stream.messages.filter((m) => m.event === 'event').map((m) => eventOf(m)['cycle']);
      expect(received).toEqual([801, 802]);
    } finally {
      await winner?.release();
    }
  });
});

describe('transcripts', () => {
  it('a subscription on a growing transcript receives its new steps in order', async () => {
    const v = (vault = factoryVault());
    const logFile = plantRun(v, 'R1');
    const dashboard = await launch(v);
    const stream = await openStream(dashboard.url, '?run=R1');

    appendFromAnotherProcess(logFile, say('three'));
    await stream.waitFor((m) => m.event === 'transcript_line', 5_000, 'the third line');
    const four = say('four');
    appendFromAnotherProcess(logFile, four.slice(0, 12));
    appendFromAnotherProcess(logFile, four.slice(12) + say('five') + say('six'));
    await waitFor(
      () =>
        stream.messages
          .filter((m) => m.event === 'transcript_line')
          .flatMap((m) => m.data['steps'] as unknown[]).length === 4,
      5_000,
      'four new steps',
    );
    await delay(SETTLE_MS);

    const lines = stream.messages.filter((m) => m.event === 'transcript_line');
    expect(lines.every((m) => m.data['runId'] === 'R1')).toBe(true);
    expect(lines.flatMap((m) => m.data['steps'] as unknown[])).toEqual([
      { kind: 'say', text: 'three' },
      { kind: 'say', text: 'four' },
      { kind: 'say', text: 'five' },
      { kind: 'say', text: 'six' },
    ]);
    const firstLines = lines.map((m) => m.data['firstLine'] as number);
    expect(firstLines[0]).toBe(2);
    expect([...firstLines].sort((a, b) => a - b)).toEqual(firstLines);
    expect(new Set(firstLines).size).toBe(firstLines.length);
  });

  it('live steps continue the paged transcript exactly: a delivery split across chunks is numbered on, its echo hidden (review fix 2)', async () => {
    const v = (vault = factoryVault());
    const initial = delivery('toolu_A') + echo('toolu_A') + say('one');
    const logFile = plantRun(v, 'R1', initial);
    const dashboard = await launch(v);
    const stream = await openStream(dashboard.url, '?run=R1');
    const liveSteps = (): unknown[] =>
      stream.messages.filter((m) => m.event === 'transcript_line').flatMap((m) => m.data['steps'] as unknown[]);

    appendFromAnotherProcess(logFile, delivery('toolu_B'));
    await stream.waitFor((m) => m.event === 'transcript_line', 5_000, 'the second delivery');
    appendFromAnotherProcess(logFile, echo('toolu_B'));
    await delay(SETTLE_MS);
    appendFromAnotherProcess(logFile, say('two'));
    await waitFor(() => liveSteps().length === 2, 5_000, 'the line after the echo');
    await delay(SETTLE_MS);

    expect(liveSteps()).toEqual([
      { kind: 'deliver', attempt: 2 },
      { kind: 'say', text: 'two' },
    ]);
    const paged = await request(dashboard.url, 'GET', '/api/runs/R1/transcript');
    expect(paged.status).toBe(200);
    const initialLines = initial.split('\n').filter((line) => line !== '');
    expect([...toSteps(initialLines), ...liveSteps()]).toEqual(paged.json['steps']);
  });

  it('an unknown run → 404 JSON, and no stream is opened', async () => {
    const v = (vault = factoryVault());
    const dashboard = await launch(v);
    const base = dashboard.host.bus.subscriberCount;

    const reply = await request(dashboard.url, 'GET', '/api/stream?run=NOPE');

    expect(reply.status).toBe(404);
    expect(reply.json['message']).toMatch(/no run/);
    expect(dashboard.host.bus.subscriberCount).toBe(base);
  });
});

describe('connections', () => {
  it('a client disconnect removes its subscriber and releases its transcript tail', async () => {
    const v = (vault = factoryVault());
    plantRun(v, 'R1');
    const dashboard = await launch(v);
    const base = dashboard.host.bus.subscriberCount;
    // The run index is the one subscriber that lives as long as the dashboard.
    expect(base).toBe(1);

    const stream = await openStream(dashboard.url, '?run=R1');
    expect(dashboard.host.bus.subscriberCount).toBe(base + 1);
    expect(dashboard.host.transcripts.isFollowing('R1')).toBe(true);

    stream.close();
    await waitFor(
      () => dashboard.host.bus.subscriberCount === base && !dashboard.host.transcripts.isFollowing('R1'),
      5_000,
      'the server to drop the disconnected client',
    );
    expect(dashboard.host.transcripts.openTails).toBe(0);
  });

  it('closing the dashboard leaves no watcher, timer or socket behind (the Phase 5 done condition)', async () => {
    const v = (vault = factoryVault());
    plantRun(v, 'R1');
    await delay(100);
    const before = process.getActiveResourcesInfo().sort();

    const dashboard = await launch(v);
    for (let i = 0; i < 3; i += 1) await openStream(dashboard.url, '?run=R1');
    const during = process.getActiveResourcesInfo();
    // One OS watcher for the whole host, however many clients follow a transcript.
    expect(during.filter((resource) => resource === 'FSEventWrap')).toHaveLength(1);

    await dashboard.close({ force: true });
    await waitFor(
      () => JSON.stringify(process.getActiveResourcesInfo().sort()) === JSON.stringify(before),
      5_000,
      `only the resources from before launch (${JSON.stringify(before)}) to remain`,
    );
    expect(dashboard.host.transcripts.openTails).toBe(0);
  });

  it('a heartbeat arrives within the heartbeat interval', async () => {
    const v = (vault = factoryVault());
    const heartbeatMs = 200;
    const dashboard = await launch(v, undefined, { sseHeartbeatMs: heartbeatMs });

    const stream = await openStream(dashboard.url);
    const first = await stream.waitFor((m) => m.event === 'heartbeat', 5_000, 'a heartbeat');
    expect(first.at - stream.openedAt).toBeLessThan(heartbeatMs + 800);
    await waitFor(
      () => stream.messages.filter((m) => m.event === 'heartbeat').length >= 2,
      5_000,
      'a second heartbeat',
    );
  });
});

describe('the tee (Section E item 6)', () => {
  /** A MockRunner pipeline run on `v` with a deterministic clock; returns the event log's bytes. */
  async function pipelineRun(v: FactoryFixture, wrapper?: (inner: EventSink) => EventSink): Promise<Buffer> {
    let tick = 0;
    const handle = await startOrchestrator({
      vaultPath: v.root,
      config: v.config,
      deps: {
        env: { PATH: process.env['PATH'] ?? '' },
        now: () => new Date(Date.UTC(2026, 8, 24, 10, 0, 0) + 1000 * tick++).toISOString(),
      },
      ...(wrapper === undefined ? {} : { eventSinkWrapper: wrapper }),
    });
    try {
      await handle.run({ maxCycles: 4, sleep: async () => undefined });
    } finally {
      await handle.shutdown();
    }
    return readFileSync(v.paths.eventLog());
  }

  it('orchestrator.jsonl is byte-identical with and without the tee (a MockRunner pipeline run)', async () => {
    const v = (vault = factoryVault());
    await plantFeature(v);
    const pristine = scratchDir('dash-tee-pristine-');
    cpSync(v.root, pristine, { recursive: true });
    // Durations are wall-clock; frozen so the two runs can match byte for byte.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 24, 12, 0, 0));

    const without = await pipelineRun(v);
    rmSync(v.root, { recursive: true, force: true });
    cpSync(pristine, v.root, { recursive: true });
    const bus = new ChangeBus();
    const heard: ChangeMessage[] = [];
    bus.subscribe((message) => heard.push(message));
    const withTee = await pipelineRun(v, (inner) => new TeeEventSink(inner, bus));

    const types = without
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    // The run exercised the runner's sink as well as the orchestrator's.
    expect(types).toEqual(expect.arrayContaining(['lock_acquired', 'run_started', 'run_finished', 'cycle_finished']));
    expect(withTee.equals(without)).toBe(true);
    const published = heard.map((m) => (m.kind === 'event' ? withoutTs(m.event) : m));
    const lines = withTee
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => withoutTs(JSON.parse(line)));
    expect(published).toEqual(lines);
    removeScratchDir(pristine);
  });
});

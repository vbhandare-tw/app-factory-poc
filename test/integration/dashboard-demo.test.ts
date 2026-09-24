/**
 * `factory demo` end to end (dashboard plan Phase 6): a real copy of the toy
 * app, real worktrees, the toy app's real gates and the scripted `DemoRunner`,
 * driven over HTTP only. No agent process is spawned and nothing is spent.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DashboardSeams, RunningDashboard } from '../../src/cli/dashboard.js';
import { demoLayout, runDemo } from '../../src/cli/demo.js';
import type { DemoOptions } from '../../src/cli/demo.js';
import { CliError, realWorktrees } from '../../src/cli/deps.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { loadConfig } from '../../src/config/load.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { readOwnerRef } from '../../src/config/validate.js';
import { featureTagName } from '../../src/git/paths.js';
import { CHECKPOINTS } from '../../src/orchestrator/checkpoints.js';
import type { CheckpointName } from '../../src/orchestrator/checkpoints.js';
import { DEMO_FEATURE_ID, DEMO_PROJECT_MD, DEMO_SCRIPT, DEMO_SLUG } from '../../src/runner/demoScript.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { delay } from '../helpers/dashboardFixtures.js';
import { cleanupAllScratchDirs, git, removeScratchDir, scratchFactoryHome } from '../helpers/toyRepo.js';

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

interface TicketView {
  readonly id: string;
  readonly status: string;
  readonly pause_reason: string | null;
}

let home: string;
let out: string[];
let opened: string[];
let launched: RunningDashboard[];

function deps(): CliDeps {
  return {
    cwd: home,
    env: { PATH: process.env['PATH'] ?? '', FACTORY_HOME: home },
    registry: new ProjectRegistry(home),
    out: (line) => out.push(line),
    err: (line) => out.push(`ERR ${line}`),
    now: () => new Date().toISOString(),
    workspaceFactory: realWorktrees,
    demoStepDelayMs: 0,
  };
}

/** `factory demo --port 0 --no-open`, in this process, with signals held back. */
async function launch(options: DemoOptions = {}, seams: DashboardSeams = {}): Promise<RunningDashboard> {
  const dashboard = await runDemo({ port: 0, open: false, ...options }, deps(), {
    signals: new EventEmitter(),
    openUrl: (url) => {
      opened.push(url);
    },
    exit: () => undefined,
    ...seams,
  });
  launched.push(dashboard);
  return dashboard;
}

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
        path: url.pathname,
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

async function tokenOf(base: string): Promise<string> {
  const page = await request(base, 'GET', '/');
  const match = /<meta name="factory-token" content="([0-9a-f]{64})">/.exec(page.text);
  if (match?.[1] === undefined) throw new Error(`no token in GET / (status ${page.status})`);
  return match[1];
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(50);
  }
}

/**
 * The feature's frontmatter once it is parked at `checkpoint`. Fails at once,
 * with the reason, if the feature or any ticket stops for anything else: a red
 * gate, a merge conflict or an escalation never turns into a checkpoint.
 */
async function waitForCheckpoint(
  base: string,
  checkpoint: CheckpointName,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      const reply = await request(base, 'GET', `/api/features/${DEMO_SLUG}`);
      if (reply.status !== 200) return undefined;
      const front = reply.json['frontmatter'] as Record<string, unknown>;
      for (const ticket of reply.json['tickets'] as TicketView[]) {
        if (ticket.status !== 'needs_human') continue;
        const item = await request(base, 'GET', `/api/items/${ticket.id}`);
        const detail = (item.json['frontmatter'] as Record<string, unknown> | undefined)?.['pause_detail'];
        const red = eventsOf(new VaultPaths(demoLayout(home).vault).eventLog())
          .filter((event) => event['type'] === 'gate_result' && event['itemId'] === ticket.id)
          .filter((event) => event['status'] === 'fail')
          .map((event) => `${String(event['gate'])} (${String(event['logPath'])})`);
        throw new Error(
          `${ticket.id} parked (${String(ticket.pause_reason)}) before ${checkpoint}: ${String(detail)}\n` +
            `red gates: ${red.length === 0 ? 'none' : red.join(', ')}`,
        );
      }
      if (front['status'] !== 'needs_human') return undefined;
      if (front['pause_reason'] !== 'checkpoint' || front['resume_to'] !== CHECKPOINTS[checkpoint].resumeTo) {
        throw new Error(
          `${DEMO_FEATURE_ID} stopped for ${String(front['pause_reason'])} instead of ${checkpoint}: ` +
            String(front['pause_detail']),
        );
      }
      return front;
    },
    timeoutMs,
    `the ${checkpoint} checkpoint`,
  );
}

/** `waitForCheckpoint` plus the claim released: a write racing `releaseClaim` is lost until that race is fixed. */
async function waitForReleasedCheckpoint(
  base: string,
  checkpoint: CheckpointName,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      const front = await waitForCheckpoint(base, checkpoint, timeoutMs);
      return front['locked_by'] == null ? front : undefined;
    },
    timeoutMs,
    `the ${checkpoint} checkpoint with the claim released`,
  );
}

function eventsOf(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  home = scratchFactoryHome('demo-home-');
  out = [];
  opened = [];
  launched = [];
});

afterEach(async () => {
  for (const dashboard of launched) await dashboard.close({ force: true });
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('factory demo', () => {
  it('creates the repo and the vault, never touches projects.yml, and starts the factory at once', async () => {
    const dashboard = await launch();
    const { root, repo, vault } = demoLayout(home);

    expect(root).toBe(path.join(home, 'demo'));
    expect(git(repo, ['rev-list', '--count', 'main']).trim()).toBe('1');
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\ndist/\n');
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(existsSync(path.join(repo, 'src', 'calc.ts'))).toBe(true);
    expect(await loadConfig(vault)).toMatchObject({ runner: 'demo', target_repo: repo, base_branch: 'main' });
    expect(readOwnerRef(repo)).toBe(vault);
    expect(readFileSync(new VaultPaths(vault).projectFile(), 'utf8')).toBe(DEMO_PROJECT_MD);

    expect(existsSync(new ProjectRegistry(home).file), 'factory demo wrote projects.yml (plan A5)').toBe(false);
    expect(opened).toEqual([]);
    expect(out).toContain(`Dashboard: ${dashboard.url}`);

    expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({ mode: 'hosted', demo: true });
    expect(await waitForCheckpoint(dashboard.url, 'after_pm_refinement', 30_000)).toMatchObject({
      id: DEMO_FEATURE_ID,
      title: 'Expression calculator',
    });
  });

  it(
    'three HTTP approvals take the demo feature from intake to done: tagged in the demo repo, $0 spent',
    async () => {
      const dashboard = await launch();
      const token = await tokenOf(dashboard.url);
      const { repo, vault } = demoLayout(home);

      let acceptedAt = '';
      for (const [checkpoint, next] of [
        ['after_pm_refinement', 'planning'],
        ['after_ticket_breakdown', 'in_development'],
        ['final_acceptance', 'done'],
      ] as const) {
        const front = await waitForCheckpoint(dashboard.url, checkpoint);
        acceptedAt = String(front['paused_at']);
        const approved = await request(dashboard.url, 'POST', `/api/items/${DEMO_FEATURE_ID}/approve`, {
          token,
          body: { note: `demo: ${checkpoint} looks right` },
        });
        expect(approved, checkpoint).toMatchObject({
          status: 200,
          json: { id: DEMO_FEATURE_ID, to: next, held: false },
        });
      }

      const tag = featureTagName(DEMO_SLUG, acceptedAt);
      const finished = await request(dashboard.url, 'GET', `/api/features/${DEMO_SLUG}`);
      expect(finished.json['frontmatter']).toMatchObject({ status: 'done', tag, cost_usd: 0 });
      expect((finished.json['tickets'] as TicketView[]).map((ticket) => ticket.status)).toEqual([
        'done',
        'done',
        'done',
        'done',
      ]);

      expect(git(repo, ['tag']).trim().split('\n')).toEqual([tag]);
      expect(git(repo, ['rev-parse', tag]).trim()).toBe(git(repo, ['rev-parse', 'main']).trim());
      expect(git(repo, ['ls-tree', '--name-only', 'main', 'src/']).trim().split('\n').sort()).toEqual(
        [
          'src/calc.test.ts',
          'src/calc.ts',
          'src/cli.test.ts',
          'src/cli.ts',
          'src/evaluate.test.ts',
          'src/evaluate.ts',
          'src/formatNumber.test.ts',
          'src/formatNumber.ts',
          'src/tokenise.test.ts',
          'src/tokenise.ts',
        ],
      );
      // Tickets run one at a time, so a file two tickets wrote would not conflict: the later one would
      // silently replace the earlier one's work. Main must hold every scripted file byte for byte.
      for (const [key, step] of Object.entries(DEMO_SCRIPT)) {
        for (const [file, contents] of Object.entries(step.write ?? {})) {
          expect(git(repo, ['show', `main:${file}`]), `${key} wrote ${file}`).toBe(contents);
        }
      }

      expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({
        demo: true,
        totalCostUsd: 0,
      });

      // Nothing went wrong on the way: every gate green, no conflict, no escalation, no run repeated.
      const log = eventsOf(new VaultPaths(vault).eventLog());
      const gates = log.filter((event) => event['type'] === 'gate_result');
      expect(gates.length).toBeGreaterThan(0);
      expect(gates.filter((event) => event['status'] !== 'pass')).toEqual([]);
      expect(log.filter((event) => event['type'] === 'merge_conflict')).toEqual([]);
      const escalations = log.filter((event) => event['type'] === 'item_paused' && event['pauseReason'] !== 'checkpoint');
      expect(escalations).toEqual([]);
      const runs = log.filter((event) => event['type'] === 'run_finished');
      expect(runs).toHaveLength(3 + 3 * 4);
      expect(runs.filter((event) => event['ok'] !== true || event['costUsd'] !== 0)).toEqual([]);

      // The last developer run, read through the page's own transcript endpoint.
      const ticketRuns = (await request(dashboard.url, 'GET', `/api/items/${DEMO_FEATURE_ID}-T004/runs`)).json[
        'runs'
      ] as { runId: string; role: string }[];
      const developer = ticketRuns.find((entry) => entry.role === 'developer');
      expect(developer).toBeDefined();
      const transcript = await request(dashboard.url, 'GET', `/api/runs/${developer!.runId}/transcript`);
      const steps = transcript.json['steps'] as { kind: string; name?: string }[];
      expect(steps.filter((entry) => entry.kind === 'unknown')).toEqual([]);
      expect(steps.filter((entry) => entry.kind === 'tool' && entry.name === 'Write')).toHaveLength(2);
      expect(steps.map((entry) => entry.kind)).toContain('deliver');
      expect(steps.at(-1)).toMatchObject({ kind: 'end', ok: true, costUsd: 0 });
    },
    240_000,
  );

  it(
    'sending back at the first checkpoint re-runs the PM with the reason in ## Notes; approving then reaches done',
    async () => {
      const dashboard = await launch();
      const token = await tokenOf(dashboard.url);
      const reason = 'demo: also accept a leading minus, such as -2 + 3';

      const first = await waitForReleasedCheckpoint(dashboard.url, 'after_pm_refinement', 120_000);
      const rejected = await request(dashboard.url, 'POST', `/api/items/${DEMO_FEATURE_ID}/reject`, {
        token,
        body: { reason },
      });
      expect(rejected).toMatchObject({
        status: 200,
        json: { id: DEMO_FEATURE_ID, from: 'needs_human', to: CHECKPOINTS.after_pm_refinement.rejectTo },
      });

      const again = await waitFor(
        async () => {
          const front = await waitForReleasedCheckpoint(dashboard.url, 'after_pm_refinement', 120_000);
          return front['paused_at'] === first['paused_at'] ? undefined : front;
        },
        120_000,
        'the PM to run again and park at after_pm_refinement',
      );
      expect(again['paused_at']).not.toBe(first['paused_at']);

      const feature = await request(dashboard.url, 'GET', `/api/features/${DEMO_SLUG}`);
      const sections = feature.json['sections'] as { heading: string; markdown: string }[];
      expect(sections.find((section) => section.heading === 'Notes')?.markdown).toContain(reason);
      const pmRuns = eventsOf(new VaultPaths(demoLayout(home).vault).eventLog()).filter(
        (event) => event['type'] === 'run_finished' && event['role'] === 'pm',
      );
      expect(pmRuns).toHaveLength(2);

      for (const [checkpoint, next] of [
        ['after_pm_refinement', 'planning'],
        ['after_ticket_breakdown', 'in_development'],
        ['final_acceptance', 'done'],
      ] as const) {
        await waitForReleasedCheckpoint(dashboard.url, checkpoint, 240_000);
        const approved = await request(dashboard.url, 'POST', `/api/items/${DEMO_FEATURE_ID}/approve`, { token });
        expect(approved, checkpoint).toMatchObject({ status: 200, json: { id: DEMO_FEATURE_ID, to: next } });
      }
      const done = await request(dashboard.url, 'GET', `/api/features/${DEMO_SLUG}`);
      expect(done.json['frontmatter']).toMatchObject({ status: 'done' });
    },
    600_000,
  );

  it('resumes the existing demo when run again, and --fresh starts it over from nothing', async () => {
    const first = await launch();
    const { repo, vault } = demoLayout(home);
    const paused = await waitForCheckpoint(first.url, 'after_pm_refinement', 30_000);
    await first.close();
    writeFileSync(path.join(repo, 'MARKER'), 'left by the test\n');
    writeFileSync(path.join(vault, 'MARKER.md'), 'left by the test\n');

    out = [];
    const again = await launch();
    expect(out.join('\n')).toContain('Resuming the demo');
    expect(existsSync(path.join(repo, 'MARKER'))).toBe(true);
    expect(existsSync(path.join(vault, 'MARKER.md'))).toBe(true);
    const resumed = await waitForCheckpoint(again.url, 'after_pm_refinement', 30_000);
    expect(resumed).toMatchObject({ created_at: paused['created_at'], paused_at: paused['paused_at'] });
    await again.close();

    out = [];
    const fresh = await launch({ fresh: true });
    expect(out.join('\n')).toContain('Creating the demo');
    expect(existsSync(path.join(repo, 'MARKER'))).toBe(false);
    expect(existsSync(path.join(vault, 'MARKER.md'))).toBe(false);
    const restarted = await waitForCheckpoint(fresh.url, 'after_pm_refinement', 30_000);
    expect(restarted['created_at']).not.toBe(paused['created_at']);
    expect(existsSync(new ProjectRegistry(home).file), 'factory demo wrote projects.yml (plan A5)').toBe(false);
  });

  it('--fresh refuses while another live process runs the demo, and leaves the demo as it was', async () => {
    const first = await launch();
    await waitForCheckpoint(first.url, 'after_pm_refinement', 30_000);
    await first.close();
    const paths = new VaultPaths(demoLayout(home).vault);
    const at = new Date().toISOString();
    writeFileSync(
      paths.instanceLock(),
      `${JSON.stringify({ pid: 999_999, host: 'another-terminal', startedAt: at, heartbeatAt: at }, null, 2)}\n`,
    );
    const before = readFileSync(paths.featureNote(DEMO_SLUG), 'utf8');

    const error = await launch({ fresh: true }, { isAlive: (pid) => pid === 999_999 }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('pid 999999');
    expect(readFileSync(paths.featureNote(DEMO_SLUG), 'utf8')).toBe(before);
    expect(existsSync(paths.instanceLock())).toBe(true);
  });
});

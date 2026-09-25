/**
 * The dashboard's write API end to end (plan Phase 4): a real server on
 * 127.0.0.1, the real `DashboardHost` and `startOrchestrator`, MockRunner
 * agents, and real git for the final-acceptance merge. The last block drives
 * real dashboard processes built from `dist/`, stopped by their own pid.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { runDashboard } from '../../src/cli/dashboard.js';
import type { RunningDashboard } from '../../src/cli/dashboard.js';
import { fencedBlock } from '../../src/domain/markdown.js';
import type { FeatureFrontmatter } from '../../src/domain/types.js';
import { featureTagName } from '../../src/git/paths.js';
import type { MockRunFixture } from '../../src/runner/mock.js';
import type { Runner } from '../../src/runner/types.js';
import { appendToSection } from '../../src/vault/storage.js';
import { delay } from '../helpers/dashboardFixtures.js';
import { makeFeature } from '../helpers/notes.js';
import {
  factoryVault,
  pipelineRunner,
  pmPayload,
  readNoteFile,
  tlPayload,
} from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  removeScratchDir,
  run,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'alpha';
const FEATURE_ID = 'FEAT-ALPHA';
const FEATURE_BRANCH = 'feature/alpha';
const PAUSED_AT = '2026-09-24T09:00:00.000Z';

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

let vault: FactoryFixture | undefined;
let home: string;
let launched: RunningDashboard[];
let children: ChildProcess[];

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

/** The session token, read the way the page reads it. */
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

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

function feature(v: FactoryFixture, slug = SLUG): FeatureFrontmatter {
  return readNoteFile(v.paths.featureNote(slug)).frontmatter as FeatureFrontmatter;
}

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

/** `factory dashboard --vault <v> --port 0 --no-open`, in this process, with signals held back. */
async function launch(v: FactoryFixture, runner?: Runner): Promise<RunningDashboard> {
  const dashboard = await runDashboard({ vault: v.root, port: 0, open: false }, deps(v, runner), {
    signals: new EventEmitter(),
    openUrl: () => undefined,
    exit: () => undefined,
  });
  launched.push(dashboard);
  return dashboard;
}

/** A MockRunner for the paper pipeline that also records when each run began. */
function timedRunner(overrides: Readonly<Record<string, MockRunFixture>>): {
  runner: Runner;
  starts: { role: string; at: number }[];
} {
  const mock = pipelineRunner(overrides);
  const starts: { role: string; at: number }[] = [];
  return {
    starts,
    runner: {
      run(spec, signal) {
        starts.push({ role: spec.role, at: Date.now() });
        return mock.run(spec, signal);
      },
    },
  };
}

/** The note `factory feature add` writes, planted directly. */
async function plantFeature(v: FactoryFixture, slug = SLUG): Promise<void> {
  const at = new Date().toISOString();
  mkdirSync(v.paths.featureDir(slug), { recursive: true });
  await v.storage.writeNote(
    v.paths.featureNote(slug),
    makeFeature(
      { id: `FEAT-${slug.toUpperCase()}`, slug, title: slug, created_at: at, updated_at: at },
      appendToSection('', SECTION.rawRequirement, fencedBlock('# Add subtract\n', 'markdown')),
    ),
  );
}

async function checkpoint(v: FactoryFixture, slug = SLUG): Promise<void> {
  mkdirSync(v.paths.featureDir(slug), { recursive: true });
  await v.storage.writeNote(
    v.paths.featureNote(slug),
    makeFeature({
      id: `FEAT-${slug.toUpperCase()}`,
      slug,
      title: slug,
      status: 'needs_human',
      pause_reason: 'checkpoint',
      pause_detail: 'after_pm_refinement',
      resume_to: 'planning',
      reject_to: 'refining',
      paused_at: PAUSED_AT,
    }),
  );
}

// --- real git ----------------------------------------------------------------

function sha(repo: string, ref: string): string {
  return git(repo, ['rev-parse', ref]).trim();
}

function tags(repo: string): string[] {
  return git(repo, ['tag'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isAncestor(repo: string, candidate: string, ref: string): boolean {
  return run(repo, 'git', ['merge-base', '--is-ancestor', candidate, ref]).status === 0;
}

function commit(repo: string, branch: string, file: string, contents: string, message: string): string {
  const startedOn = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repo, ['checkout', '--quiet', branch]);
  writeFileSync(path.join(repo, file), contents, 'utf8');
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '--quiet', '-m', message]);
  const made = sha(repo, 'HEAD');
  git(repo, ['checkout', '--quiet', startedOn]);
  return made;
}

/**
 * A feature parked at `final_acceptance` exactly as the feature close leaves
 * it: a verified feature-branch commit that contains the base branch.
 */
async function parkAtFinalAcceptance(v: FactoryFixture): Promise<{ baseTip: string; featureTip: string }> {
  const repo = v.repo.path;
  const baseTip = sha(repo, v.repo.branch);
  git(repo, ['branch', FEATURE_BRANCH, v.repo.branch]);
  const featureTip = commit(repo, FEATURE_BRANCH, 'src/extra.ts', 'export const extra = 1;\n', 'feat(extra): add extra');

  mkdirSync(v.paths.featureDir(SLUG), { recursive: true });
  await v.storage.writeNote(
    v.paths.featureNote(SLUG),
    makeFeature({
      id: FEATURE_ID,
      slug: SLUG,
      title: 'Alpha',
      status: 'needs_human',
      pause_reason: 'checkpoint',
      pause_detail: 'final_acceptance',
      resume_to: 'done',
      reject_to: 'in_development',
      paused_at: PAUSED_AT,
      feature_branch: FEATURE_BRANCH,
      verified_sha: featureTip,
      base_verified_sha: baseTip,
    }),
  );
  return { baseTip, featureTip };
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  vault = undefined;
  home = scratchFactoryHome();
  launched = [];
  children = [];
});

afterEach(async () => {
  for (const dashboard of launched) await dashboard.close({ force: true });
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  vault?.cleanup();
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('the hosted orchestrator over HTTP', () => {
  it('starts, reaches the first checkpoint, and an HTTP approve starts the next run well before the 15 s poll sleep', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    const timed = timedRunner({ tl_plan: { structured: tlPayload(), delayMs: 3_000 } });
    const dashboard = await launch(v, timed.runner);
    const token = await tokenOf(dashboard.url);

    const added = await request(dashboard.url, 'POST', '/api/features', {
      token,
      body: { name: SLUG, requirement: '# Add subtract\n\nThe calculator should subtract.\n' },
    });
    expect(added).toMatchObject({ status: 201, json: { id: FEATURE_ID, slug: SLUG } });

    const started = await request(dashboard.url, 'POST', '/api/factory/start', { token });
    expect(started).toMatchObject({ status: 202, json: { mode: 'hosted' } });
    expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({ mode: 'hosted' });

    await waitFor(() => feature(v).status === 'needs_human', 10_000, 'the first checkpoint');
    expect(feature(v)).toMatchObject({ pause_reason: 'checkpoint', resume_to: 'planning' });
    // Cycle 1 is over, so the loop is sleeping out its 15 s poll interval.
    await waitFor(
      () => events(v).some((event) => event['type'] === 'cycle_finished' && event['cycle'] === 1),
      5_000,
      'cycle 1 to finish',
    );
    expect(readFileSync(v.paths.needsHumanFile(), 'utf8')).toContain(FEATURE_ID);

    const approved = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, {
      token,
      body: { note: 'go' },
    });
    const approvedAt = Date.now();
    expect(approved).toMatchObject({
      status: 200,
      json: { id: FEATURE_ID, kind: 'feature', from: 'needs_human', to: 'planning', held: false },
    });
    // Regenerated by the approval itself; the loop's next write is 3 s away.
    expect(readFileSync(v.paths.needsHumanFile(), 'utf8')).toContain('_Nothing is waiting on you._');

    const techLead = await waitFor(
      () => timed.starts.find((start) => start.role === 'tl_plan'),
      5_000,
      'the Tech Lead run to start',
    );
    expect(techLead.at - approvedAt).toBeLessThan(2_500);
  });

  it('stop during an agent run → 202 at once, other writes still answer, then stopped with no lock and no claim', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    await plantFeature(v);
    const timed = timedRunner({ pm: { structured: pmPayload(), delayMs: 3_000 } });
    const dashboard = await launch(v, timed.runner);
    const token = await tokenOf(dashboard.url);

    expect((await request(dashboard.url, 'POST', '/api/factory/start', { token })).status).toBe(202);
    await waitFor(() => timed.starts.find((start) => start.role === 'pm'), 5_000, 'the PM run to start');
    expect(existsSync(v.paths.instanceLock())).toBe(true);

    const askedAt = Date.now();
    const stop = await request(dashboard.url, 'POST', '/api/factory/stop', { token });
    const resume = await request(dashboard.url, 'POST', '/api/factory/resume', { token });
    expect(stop).toMatchObject({ status: 202, json: { stopping: true, force: false } });
    expect(resume.status).toBe(200);
    expect(Date.now() - askedAt).toBeLessThan(1_000);
    expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({
      mode: 'hosted',
      stopping: true,
    });

    await waitFor(
      async () => (await request(dashboard.url, 'GET', '/api/state')).json['mode'] === 'stopped',
      10_000,
      'the drain to finish',
    );

    expect(existsSync(v.paths.instanceLock())).toBe(false);
    // Drained, not aborted: the PM run finished and its checkpoint was written.
    expect(feature(v)).toMatchObject({ status: 'needs_human', locked_by: null, locked_at: null });
    expect(events(v).map((event) => event['type'])).toContain('claim_released');
    expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({
      mode: 'stopped',
      stopping: false,
      lastError: null,
      startupFailures: [],
    });
  });
});

describe('a hosted orchestrator that crashes', () => {
  it('leaves the server up, mode stopped with lastError, the lock released, and Start usable again', async () => {
    const v = (vault = factoryVault({ config: { poll_interval: 15 } }));
    // Regenerating index.md at the end of the first cycle fails, so run() rejects.
    rmSync(v.paths.indexFile(), { force: true });
    mkdirSync(v.paths.indexFile());
    const dashboard = await launch(v, pipelineRunner());
    const token = await tokenOf(dashboard.url);

    expect((await request(dashboard.url, 'POST', '/api/factory/start', { token })).status).toBe(202);
    const crashed = await waitFor(
      async () => {
        const state = (await request(dashboard.url, 'GET', '/api/state')).json;
        return state['mode'] === 'stopped' ? state : undefined;
      },
      10_000,
      'the crashed loop to be reported',
    );

    expect(crashed['lastError']).toMatch(/EISDIR/);
    expect(existsSync(v.paths.instanceLock())).toBe(false);
    expect((await request(dashboard.url, 'GET', '/')).status).toBe(200);

    rmSync(v.paths.indexFile(), { recursive: true, force: true });
    expect((await request(dashboard.url, 'POST', '/api/factory/start', { token })).status).toBe(202);
    const restarted = (await request(dashboard.url, 'GET', '/api/state')).json;
    expect(restarted).toMatchObject({ mode: 'hosted', lastError: null });
  });
});

describe('final acceptance over HTTP', () => {
  it('approve merges the feature branch into main with --no-ff and creates the tag', async () => {
    const v = (vault = factoryVault());
    const { baseTip, featureTip } = await parkAtFinalAcceptance(v);
    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);

    const result = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, {
      token,
      body: { note: 'ship it' },
    });

    expect(result).toMatchObject({
      status: 200,
      json: { id: FEATURE_ID, kind: 'feature', from: 'needs_human', to: 'done', held: false },
    });
    const repo = v.repo.path;
    const main = v.repo.branch;
    expect(git(repo, ['rev-list', '--parents', '-n', '1', main]).trim().split(/\s+/)).toHaveLength(3);
    expect(isAncestor(repo, featureTip, main)).toBe(true);
    expect(isAncestor(repo, baseTip, main)).toBe(true);
    const tag = featureTagName(SLUG, PAUSED_AT);
    expect(tags(repo)).toEqual([tag]);
    expect(sha(repo, tag)).toBe(sha(repo, main));
    expect(feature(v)).toMatchObject({ status: 'done', tag });
  });

  it('a base branch that moved since the gates ran → 200 held: true, main untouched, no tag', async () => {
    const v = (vault = factoryVault());
    const { featureTip } = await parkAtFinalAcceptance(v);
    const repo = v.repo.path;
    const movedBase = commit(repo, v.repo.branch, 'COLLEAGUE.md', 'hello\n', 'docs: a colleague lands a commit');
    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);

    const result = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, { token });

    expect(result).toMatchObject({
      status: 200,
      json: { id: FEATURE_ID, from: 'needs_human', to: 'awaiting_feature_close', held: true },
    });
    expect(sha(repo, v.repo.branch)).toBe(movedBase);
    expect(tags(repo)).toEqual([]);
    expect(feature(v)).toMatchObject({ status: 'awaiting_feature_close', approved_sha: featureTip });
  });

  it('a feature branch that moved since the gates ran → 409 with the actions.ts refusal, nothing merged', async () => {
    const v = (vault = factoryVault());
    const { baseTip, featureTip } = await parkAtFinalAcceptance(v);
    const repo = v.repo.path;
    const moved = commit(repo, FEATURE_BRANCH, 'src/late.ts', 'export const late = 1;\n', 'feat(late): ungated');
    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);

    const result = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, { token });

    expect(result.status).toBe(409);
    expect(result.json['message']).toMatch(
      /^refusing to close FEAT-ALPHA: feature\/alpha has moved since its gates ran\./,
    );
    expect(result.json['message']).toContain(featureTip);
    expect(result.json['message']).toContain(moved);
    expect(sha(repo, v.repo.branch)).toBe(baseTip);
    expect(tags(repo)).toEqual([]);
    expect(feature(v)).toMatchObject({ status: 'needs_human', resume_to: 'awaiting_feature_close' });
  });

  it('approving again after that refusal → 200 held: false, because no standing approval was recorded (plan Phase 5, ruling i)', async () => {
    const v = (vault = factoryVault());
    const { baseTip } = await parkAtFinalAcceptance(v);
    const repo = v.repo.path;
    commit(repo, FEATURE_BRANCH, 'src/late.ts', 'export const late = 1;\n', 'feat(late): ungated');
    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);

    expect((await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, { token })).status).toBe(409);
    const again = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, { token });

    expect(again).toMatchObject({
      status: 200,
      json: { id: FEATURE_ID, from: 'needs_human', to: 'awaiting_feature_close', held: false },
    });
    expect(feature(v)).toMatchObject({ status: 'awaiting_feature_close', approved_sha: null });
    expect(sha(repo, v.repo.branch)).toBe(baseTip);
    expect(tags(repo)).toEqual([]);
  });
});

describe('dashboard processes', () => {
  interface Spawned {
    readonly child: ChildProcess;
    readonly stdout: () => string;
    readonly stderr: () => string;
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }

  function spawnNode(args: readonly string[], env: NodeJS.ProcessEnv = {}): Spawned {
    const child = spawn(process.execPath, [...args], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let errText = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errText += chunk.toString('utf8');
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, stdout: () => out, stderr: () => errText, exited };
  }

  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(() => {
    // The children import `dist/` (built once by test/globalSetup.ts), because Node's
    // type stripping cannot resolve the `.js` specifiers the sources use.
    const build = inject('distBuild');
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  });

  it('a second SIGINT during a slow MockRunner run aborts it, releases the lock, and the process exits', async () => {
    const v = (vault = factoryVault());
    await plantFeature(v);
    const fixtures = path.join(scratchDir('dashboard-fixtures-'), 'fixtures.json');
    writeFileSync(fixtures, JSON.stringify({ pm: { structured: pmPayload(), delayMs: 60_000 } }));

    const proc = spawnNode([path.join(PROJECT_ROOT, 'test', 'helpers', 'dashboardChild.mjs'), v.root, fixtures, home]);
    await waitFor(() => proc.stdout().includes(`RUN_START pm ${FEATURE_ID}`), 30_000, 'the PM run to start');
    expect(proc.stdout()).toMatch(/Dashboard: http:\/\/127\.0\.0\.1:\d+\//);
    expect(existsSync(v.paths.instanceLock())).toBe(true);

    proc.child.kill('SIGINT');
    await waitFor(
      () => proc.stderr().includes('Stopping after the current agent finishes. Press Ctrl-C again to stop it now.'),
      5_000,
      'the drain message',
    );
    await delay(300);
    expect(proc.child.exitCode, 'the first SIGINT must drain, not exit').toBeNull();
    expect(existsSync(v.paths.instanceLock())).toBe(true);

    proc.child.kill('SIGINT');
    const exit = await withTimeout(proc.exited, 15_000, 'the dashboard process to exit after the second SIGINT');

    expect(exit).toEqual({ code: 0, signal: null });
    expect(proc.stdout()).toContain('RUN_END pm aborted');
    expect(proc.stdout()).toContain('CLOSED');
    expect(existsSync(v.paths.instanceLock())).toBe(false);
    expect(events(v)).toContainEqual(
      expect.objectContaining({ type: 'attempt_forgiven', itemId: FEATURE_ID, failure: 'aborted' }),
    );
    expect(feature(v)).toMatchObject({ locked_by: null, locked_at: null });
    expect(isRunning(proc.child.pid!)).toBe(false);
  });

  it('another process holding the lock → mode external; start and stop refused; approve still works', async () => {
    const v = (vault = factoryVault());
    await checkpoint(v);
    const holder = spawnNode([path.join(PROJECT_ROOT, 'test', 'helpers', 'holdLock.mjs'), v.root]);
    await waitFor(() => holder.stdout().includes('LOCKED'), 30_000, 'the second process to take the lock');
    const holderPid = holder.child.pid!;

    const dashboard = await launch(v);
    const token = await tokenOf(dashboard.url);

    expect((await request(dashboard.url, 'GET', '/api/state')).json).toMatchObject({
      mode: 'external',
      lock: { pid: holderPid },
    });
    const start = await request(dashboard.url, 'POST', '/api/factory/start', { token });
    const stop = await request(dashboard.url, 'POST', '/api/factory/stop', { token });
    expect(start.status).toBe(409);
    expect(start.json['message']).toContain(String(holderPid));
    expect(stop.status).toBe(409);

    const approved = await request(dashboard.url, 'POST', `/api/items/${FEATURE_ID}/approve`, {
      token,
      body: { note: 'from the page' },
    });
    expect(approved).toMatchObject({ status: 200, json: { to: 'planning' } });
    expect(feature(v).status).toBe('planning');
    expect((JSON.parse(readFileSync(v.paths.instanceLock(), 'utf8')) as { pid: number }).pid).toBe(holderPid);

    holder.child.kill('SIGTERM');
    expect(await withTimeout(holder.exited, 10_000, 'the lock holder to exit')).toEqual({ code: 0, signal: null });
  });

  it('`factory dashboard --no-open` prints a 127.0.0.1 URL, serves /api/state, and exits on Ctrl-C leaving no lock', async () => {
    const v = (vault = factoryVault());
    const proc = spawnNode(
      [path.join(PROJECT_ROOT, 'dist', 'cli', 'main.js'), 'dashboard', '--vault', v.root, '--no-open', '--port', '0'],
      { FACTORY_HOME: home },
    );

    const url = await waitFor(
      () => /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(proc.stdout())?.[1],
      30_000,
      'the dashboard URL',
    );
    const state = await request(url, 'GET', '/api/state');
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ mode: 'stopped', lastError: null });

    proc.child.kill('SIGINT');
    expect(await withTimeout(proc.exited, 10_000, 'factory dashboard to exit')).toEqual({ code: 0, signal: null });
    expect(existsSync(v.paths.instanceLock())).toBe(false);
    expect(proc.stderr()).not.toContain('Error');
  });
});

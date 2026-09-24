/**
 * Every read endpoint (tech spec §5, plan Phase 3), over a real fixture vault.
 * Transcripts and gate logs are fetched by id through `RunIndex`, and every
 * recorded path must still pass `confine()`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildStatusReport } from '../../../src/cli/status.js';
import type { VaultScope } from '../../../src/cli/resolve.js';
import { GATE_LOG_CAP_BYTES, TRANSCRIPT_PAGE_LINES } from '../../../src/dashboard/constants.js';
import type { LockView, ReadContext } from '../../../src/dashboard/handlers/read.js';
import { readHandlers, readLockView } from '../../../src/dashboard/handlers/read.js';
import type { HandlerResult, ParsedRequest } from '../../../src/dashboard/router.js';
import { RunIndex } from '../../../src/dashboard/runIndex.js';
import type { FeatureFrontmatter, TicketFrontmatter } from '../../../src/domain/types.js';
import { ShellGit } from '../../../src/git/git.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import { factoryVault } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  scratchDir,
} from '../../helpers/toyRepo.js';

const NOW = '2026-09-24T10:00:00.000Z';
const NO_TRANSCRIPT = 'no transcript for this run (it may not have started)';

let vault: FactoryFixture;
let index: RunIndex;
let lock: LockView;

function scopeOf(v: FactoryFixture): VaultScope {
  const shell = new ShellGit({ repoRoot: v.repo.path });
  return {
    vaultPath: v.root,
    config: v.config,
    paths: v.paths,
    storage: v.storage,
    resolution: { vaultPath: v.root, source: 'flag', projectName: null },
    actionContext: { paths: v.paths, storage: v.storage, config: v.config, now: () => NOW, git: shell },
  };
}

function context(overrides: Partial<ReadContext> = {}): ReadContext {
  return {
    scope: scopeOf(vault),
    lockView: () => Promise.resolve(lock),
    git: new ShellGit({ repoRoot: vault.repo.path }),
    runIndex: index,
    nowMs: () => Date.parse(NOW),
    ...overrides,
  };
}

function req(params: Record<string, string> = {}, query = ''): ParsedRequest {
  return { method: 'GET', path: '/', params, query: new URLSearchParams(query), body: undefined };
}

function json(result: HandlerResult): Record<string, unknown> {
  if (!('json' in result)) throw new Error('expected a JSON result');
  return result.json as Record<string, unknown>;
}

async function feature(
  slug: string,
  status: FeatureFrontmatter['status'],
  overrides: Partial<FeatureFrontmatter> = {},
  body = '',
): Promise<void> {
  mkdirSync(vault.paths.featureDir(slug), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.featureNote(slug),
    makeFeature({ id: `FEAT-${slug.toUpperCase()}`, slug, title: slug, status, ...overrides }, body),
  );
}

async function ticket(
  slug: string,
  ordinal: number,
  status: TicketFrontmatter['status'],
  overrides: Partial<TicketFrontmatter> = {},
  body = '',
): Promise<string> {
  const id = `FEAT-${slug.toUpperCase()}-T00${ordinal}`;
  mkdirSync(vault.paths.ticketsDir(slug), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.ticketPath(slug, id),
    makeTicket({ id, feature: slug, ordinal, title: `Ticket ${ordinal}`, status, ...overrides }, body),
  );
  return id;
}

function runStarted(runId: string, itemId: string, logPath: string): Record<string, unknown> {
  return {
    ts: NOW,
    type: 'run_started',
    runId,
    role: 'developer',
    itemId,
    attempt: 1,
    model: 'sonnet',
    pid: 1,
    logPath,
  };
}

function gateResult(itemId: string, logPath: string): Record<string, unknown> {
  return {
    ts: NOW,
    type: 'gate_result',
    itemId,
    gate: 'tests',
    status: 'fail',
    exitCode: 1,
    durationMs: 10,
    logPath,
  };
}

function writeLog(relative: string, text: string): string {
  const file = path.join(vault.paths.logsDir(), relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function assistantLines(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }),
  ).join('\n');
}

beforeEach(() => {
  vault = factoryVault();
  index = new RunIndex();
  lock = { mode: 'stopped', pid: null, heartbeatAt: null };
});

afterEach(() => {
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('state', () => {
  async function pausedVault(): Promise<void> {
    await feature('alpha', 'needs_human', {
      pause_reason: 'checkpoint',
      pause_detail: 'after_pm_refinement',
      resume_to: 'planning',
      reject_to: 'refining',
      paused_at: NOW,
      cost_usd: 0.5,
    });
    await ticket('alpha', 1, 'done', { cost_usd: 0.25 });
    await feature('bravo', 'in_development', { cost_usd: 1 });
  }

  it('is the status report plus mode, demo, killed, totalCostUsd and needs_human routing', async () => {
    await pausedVault();
    const body = json(await readHandlers(context()).state(req()));
    const report = await buildStatusReport(scopeOf(vault).resolution);

    const { needs_human: reportNeedsHuman, ...reportRest } = report;
    expect(body).toMatchObject(reportRest);
    expect(body).toMatchObject({ mode: 'stopped', demo: false, killed: false, totalCostUsd: 1.75 });
    expect(body['needs_human']).toEqual([
      {
        ...reportNeedsHuman[0],
        kind: 'feature',
        resume_to: 'planning',
        reject_to: 'refining',
        paused_at: NOW,
      },
    ]);
  });

  it('reports the kill switch', async () => {
    writeFileSync(vault.paths.killFile(), 'stop\n');
    expect(json(await readHandlers(context()).state(req()))['killed']).toBe(true);
  });

  it('takes mode and the lock owner from the lock view', async () => {
    lock = { mode: 'external', pid: 999, heartbeatAt: NOW };
    const body = json(await readHandlers(context()).state(req()));
    expect(body).toMatchObject({ mode: 'external', lock: { pid: 999, heartbeatAt: NOW } });
  });

  it('reports demo when the context says so', async () => {
    expect(json(await readHandlers(context({ demo: true })).state(req()))['demo']).toBe(true);
  });
});

describe('readLockView', () => {
  const record = (pid: number): string =>
    JSON.stringify({ pid, host: 'h', startedAt: NOW, heartbeatAt: NOW });

  it('is stopped with no lock file', async () => {
    expect(await readLockView(vault.paths)).toEqual({ mode: 'stopped', pid: null, heartbeatAt: null });
  });

  it('is hosted when this process holds the lock', async () => {
    writeFileSync(vault.paths.instanceLock(), record(4242));
    expect(await readLockView(vault.paths, { selfPid: 4242, isAlive: () => true })).toEqual({
      mode: 'hosted',
      pid: 4242,
      heartbeatAt: NOW,
    });
  });

  it('is external when another live process holds it, whatever the heartbeat age', async () => {
    writeFileSync(
      vault.paths.instanceLock(),
      JSON.stringify({ pid: 7, host: 'h', startedAt: NOW, heartbeatAt: '2000-01-01T00:00:00.000Z' }),
    );
    expect(await readLockView(vault.paths, { selfPid: 1, isAlive: () => true })).toMatchObject({
      mode: 'external',
      pid: 7,
    });
  });

  it('is stopped when the lock owner is dead', async () => {
    writeFileSync(vault.paths.instanceLock(), record(7));
    expect(await readLockView(vault.paths, { selfPid: 1, isAlive: () => false })).toMatchObject({
      mode: 'stopped',
      pid: 7,
    });
  });

  it('is stopped when the lock file is unreadable', async () => {
    writeFileSync(vault.paths.instanceLock(), '{not json');
    expect(await readLockView(vault.paths)).toMatchObject({ mode: 'stopped', pid: null });
  });
});

describe('feature', () => {
  const BODY = '## Raw Requirement\n\nBuild it.\n\n## Notes\n\nn\n\n## History\n\n- 2026-09-24T09:00:00.000Z | intake → refining | orchestrator\n';

  it('returns frontmatter, sections, history, ticket summaries and the tech plan', async () => {
    await feature('alpha', 'in_development', {}, BODY);
    await ticket('alpha', 1, 'in_progress');
    writeFileSync(vault.paths.techPlan('alpha'), '# Tech plan\n');

    const body = json(await readHandlers(context()).feature(req({ slug: 'alpha' })));
    expect(body['frontmatter']).toMatchObject({ id: 'FEAT-ALPHA', slug: 'alpha' });
    expect((body['sections'] as { heading: string }[]).map((s) => s.heading)).toEqual([
      'Raw Requirement',
      'Notes',
      'History',
    ]);
    expect(body['history']).toEqual([
      { ts: '2026-09-24T09:00:00.000Z', from: 'intake', to: 'refining', actor: 'orchestrator', note: null },
    ]);
    expect(body['tickets']).toEqual([
      expect.objectContaining({ id: 'FEAT-ALPHA-T001', title: 'Ticket 1', status: 'in_progress', ordinal: 1 }),
    ]);
    expect(body['techPlan']).toBe('# Tech plan\n');
  });

  it('returns a null tech plan when there is none', async () => {
    await feature('alpha', 'intake');
    expect(json(await readHandlers(context()).feature(req({ slug: 'alpha' })))['techPlan']).toBeNull();
  });

  it('is 404 for an unknown slug', async () => {
    await expect(readHandlers(context()).feature(req({ slug: 'nope' }))).rejects.toMatchObject({ status: 404 });
  });

  it.each(['../alpha', '.hidden', 'a/b', '..', ''])('is 400 for the unsafe slug %j', async (slug) => {
    await expect(readHandlers(context()).feature(req({ slug }))).rejects.toMatchObject({ status: 400 });
  });

  it('is 404 for a feature directory that is a symlink out of the vault', async () => {
    const outside = scratchDir('dash-outside-');
    mkdirSync(path.join(outside, 'evil'));
    await vault.storage.writeNote(
      path.join(outside, 'evil', 'feature.md'),
      makeFeature({ id: 'FEAT-EVIL', slug: 'evil', title: 'evil', status: 'intake' }),
    );
    symlinkSync(path.join(outside, 'evil'), path.join(vault.paths.featuresDir(), 'evil'));

    await expect(readHandlers(context()).feature(req({ slug: 'evil' }))).rejects.toMatchObject({ status: 404 });
  });

  it('is 404 for a feature.md that is a symlink out of the vault', async () => {
    const outside = scratchDir('dash-outside-');
    await vault.storage.writeNote(
      path.join(outside, 'feature.md'),
      makeFeature({ id: 'FEAT-EVIL', slug: 'evil', title: 'evil', status: 'intake' }),
    );
    mkdirSync(vault.paths.featureDir('evil'), { recursive: true });
    symlinkSync(path.join(outside, 'feature.md'), vault.paths.featureNote('evil'));

    await expect(readHandlers(context()).feature(req({ slug: 'evil' }))).rejects.toMatchObject({ status: 404 });
    await expect(readHandlers(context()).item(req({ id: 'FEAT-EVIL' }))).rejects.toMatchObject({ status: 404 });
    await expect(readHandlers(context()).delivery(req({ slug: 'evil' }))).rejects.toMatchObject({ status: 404 });
  });

  it('leaves out tickets under a tickets/ directory that is a symlink out of the vault', async () => {
    await feature('alpha', 'in_development');
    const outside = scratchDir('dash-outside-');
    await vault.storage.writeNote(
      path.join(outside, 'FEAT-ALPHA-T002.md'),
      makeTicket({ id: 'FEAT-ALPHA-T002', feature: 'alpha', ordinal: 2, title: 'leaked', status: 'ready' }),
    );
    symlinkSync(outside, vault.paths.ticketsDir('alpha'));

    const body = json(await readHandlers(context()).feature(req({ slug: 'alpha' })));
    expect(body['tickets']).toEqual([]);
    await expect(readHandlers(context()).item(req({ id: 'FEAT-ALPHA-T002' }))).rejects.toMatchObject({ status: 404 });
  });

  it('returns a null tech plan when tech-plan.md is a symlink out of the vault', async () => {
    await feature('alpha', 'planning');
    const outside = scratchDir('dash-outside-');
    writeFileSync(path.join(outside, 'plan.md'), 'leaked plan\n');
    symlinkSync(path.join(outside, 'plan.md'), vault.paths.techPlan('alpha'));
    expect(json(await readHandlers(context()).feature(req({ slug: 'alpha' })))['techPlan']).toBeNull();
  });
});

describe('item', () => {
  it('returns a ticket note, sectioned', async () => {
    await feature('alpha', 'in_development');
    const id = await ticket('alpha', 1, 'code_review', {}, '## Acceptance Criteria\n\n- works\n');
    const body = json(await readHandlers(context()).item(req({ id })));
    expect(body).toMatchObject({
      kind: 'ticket',
      frontmatter: { id, status: 'code_review' },
      sections: [{ heading: 'Acceptance Criteria', markdown: '- works' }],
      history: [],
    });
  });

  it('returns a feature by its id', async () => {
    await feature('alpha', 'planning');
    expect(json(await readHandlers(context()).item(req({ id: 'FEAT-ALPHA' })))['kind']).toBe('feature');
  });

  it('is 404 for an unknown id and 400 for an unsafe one', async () => {
    await expect(readHandlers(context()).item(req({ id: 'FEAT-NOPE' }))).rejects.toMatchObject({ status: 404 });
    await expect(readHandlers(context()).item(req({ id: '../x' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('itemRuns', () => {
  it("lists an item's runs and gate logs from the index, without their paths", async () => {
    index.apply(runStarted('R1', 'FEAT-A-T001', '/v/logs/a/1.log'));
    index.apply({ type: 'run_finished', runId: 'R1', ok: false, costUsd: 0.1, durationMs: 5 });
    index.apply(gateResult('FEAT-A-T001', '/v/logs/a/g.log'));
    index.apply(runStarted('R2', 'FEAT-A-T002', '/v/logs/a/2.log'));

    const body = json(await readHandlers(context()).itemRuns(req({ id: 'FEAT-A-T001' })));
    expect(body).toEqual({
      runs: [
        {
          runId: 'R1',
          role: 'developer',
          attempt: 1,
          model: 'sonnet',
          startedAt: NOW,
          finished: true,
          ok: false,
          costUsd: 0.1,
          durationMs: 5,
        },
      ],
      gateLogs: [
        { gateLogId: 'FEAT-A-T001:tests:1', gate: 'tests', status: 'fail', exitCode: 1, durationMs: 10, at: NOW },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('/v/logs');
  });

  it('is 400 for an unsafe id', async () => {
    await expect(readHandlers(context()).itemRuns(req({ id: 'a/b' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('activeRuns', () => {
  it('lists .runs entries with elapsed time', async () => {
    mkdirSync(vault.paths.runsDir(), { recursive: true });
    writeFileSync(
      vault.paths.runFile('R1'),
      JSON.stringify({
        runId: 'R1',
        role: 'qa',
        ticket: 'FEAT-A-T001',
        feature: 'a',
        attempt: 2,
        pid: 12,
        startedAt: '2026-09-24T09:59:00.000Z',
        logPath: '/v/logs/a/x.log',
      }),
    );
    writeFileSync(path.join(vault.paths.runsDir(), 'R2.json'), '{half');

    const body = json(await readHandlers(context()).activeRuns(req()));
    expect(body['runs']).toEqual([
      {
        runId: 'R1',
        role: 'qa',
        itemId: 'FEAT-A-T001',
        feature: 'a',
        attempt: 2,
        pid: 12,
        startedAt: '2026-09-24T09:59:00.000Z',
        elapsedMs: 60_000,
      },
      { runId: 'R2', role: null, itemId: null, feature: null, attempt: null, pid: null, startedAt: null, elapsedMs: null },
    ]);
  });

  it('is empty when there is no .runs directory', async () => {
    expect(json(await readHandlers(context()).activeRuns(req()))['runs']).toEqual([]);
  });
});

describe('transcript', () => {
  it('is 404 for an unknown runId, even when a log with a matching name exists', async () => {
    writeLog('alpha/FEAT-ALPHA-1-pm.log', assistantLines(3));
    await expect(
      readHandlers(context()).transcript(req({ runId: 'FEAT-ALPHA-pm-a1-1' })),
    ).rejects.toMatchObject({ status: 404, message: NO_TRANSCRIPT });
  });

  it('returns the last page of steps, and pages back with `before`', async () => {
    const total = TRANSCRIPT_PAGE_LINES + 50;
    const file = writeLog('alpha/FEAT-ALPHA-T001-1-developer.log', `${assistantLines(total)}\n`);
    index.apply(runStarted('R1', 'FEAT-ALPHA-T001', file));

    const last = json(await readHandlers(context()).transcript(req({ runId: 'R1' })));
    expect(last).toMatchObject({ firstLine: 50, lastLine: total, totalLines: total, finished: false });
    const steps = last['steps'] as { kind: string; text: string }[];
    expect(steps).toHaveLength(TRANSCRIPT_PAGE_LINES);
    expect(steps[0]).toEqual({ kind: 'say', text: 'line 50' });
    expect(last['rawLines']).toBeUndefined();

    const earlier = json(await readHandlers(context()).transcript(req({ runId: 'R1' }, 'before=50&raw=1')));
    expect(earlier).toMatchObject({ firstLine: 0, lastLine: 50 });
    expect(earlier['steps']).toHaveLength(50);
    expect((earlier['rawLines'] as string[])[0]).toContain('line 0');
  });

  it.each(['-1', 'abc', '1.5', ''])('is 400 for before=%j', async (before) => {
    const file = writeLog('alpha/x.log', assistantLines(2));
    index.apply(runStarted('R1', 'FEAT-ALPHA', file));
    await expect(
      readHandlers(context()).transcript(req({ runId: 'R1' }, `before=${before}`)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('is 404 with the spec message when the indexed file is missing', async () => {
    index.apply(runStarted('R1', 'FEAT-ALPHA', path.join(vault.paths.logsDir(), 'alpha', 'gone.log')));
    await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({
      status: 404,
      message: NO_TRANSCRIPT,
    });
  });

  describe('refuses a planted run_started whose logPath leaves logs/', () => {
    it('an absolute path to a vault file outside logs/', async () => {
      index.apply(runStarted('R1', 'FEAT-ALPHA', vault.paths.configFile()));
      await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({ status: 404 });
    });

    it('a `..` path that starts inside logs/', async () => {
      index.apply(runStarted('R1', 'FEAT-ALPHA', `${vault.paths.logsDir()}/../config.yml`));
      await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({ status: 404 });
    });

    it('a sibling directory whose name starts with logs', async () => {
      const sibling = `${vault.paths.logsDir()}-evil`;
      mkdirSync(sibling);
      writeFileSync(path.join(sibling, 'x.log'), assistantLines(1));
      index.apply(runStarted('R1', 'FEAT-ALPHA', path.join(sibling, 'x.log')));
      await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({ status: 404 });
    });

    it('a symlink inside logs/ that points out', async () => {
      const link = path.join(vault.paths.logsDir(), 'link.log');
      symlinkSync(vault.paths.configFile(), link);
      index.apply(runStarted('R1', 'FEAT-ALPHA', link));
      await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({ status: 404 });
    });

    it('a relative path', async () => {
      index.apply(runStarted('R1', 'FEAT-ALPHA', 'logs/alpha/x.log'));
      await expect(readHandlers(context()).transcript(req({ runId: 'R1' }))).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('gateLog', () => {
  it('returns the log as plain text', async () => {
    const file = writeLog('alpha/FEAT-ALPHA-T001-1-gate-tests.log', 'FAIL src/a.test.ts\n');
    index.apply(gateResult('FEAT-ALPHA-T001', file));
    const result = await readHandlers(context()).gateLog(req({ gateLogId: 'FEAT-ALPHA-T001:tests:1' }));
    expect(result).toEqual({ status: 200, text: 'FAIL src/a.test.ts\n', contentType: 'text/plain; charset=utf-8' });
  });

  it('caps a large log, keeping the end', async () => {
    const text = `${'a'.repeat(GATE_LOG_CAP_BYTES)}THE END\n`;
    const file = writeLog('alpha/big.log', text);
    index.apply(gateResult('FEAT-ALPHA-T001', file));
    const result = await readHandlers(context()).gateLog(req({ gateLogId: 'FEAT-ALPHA-T001:tests:1' }));
    if (!('text' in result)) throw new Error('expected text');
    expect(result.text.endsWith('THE END\n')).toBe(true);
    expect(result.text.startsWith('[… 8 earlier bytes omitted]\n')).toBe(true);
  });

  it('is 404 for an unknown id', async () => {
    await expect(readHandlers(context()).gateLog(req({ gateLogId: 'X:tests:1' }))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a planted gate_result path outside logs/', async () => {
    index.apply(gateResult('FEAT-ALPHA-T001', vault.paths.configFile()));
    await expect(
      readHandlers(context()).gateLog(req({ gateLogId: 'FEAT-ALPHA-T001:tests:1' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('delivery', () => {
  it('returns commits and numstat of the feature branch against the base branch', async () => {
    const repo = vault.repo.path;
    git(repo, ['checkout', '--quiet', '-b', 'feature/alpha']);
    writeFileSync(path.join(repo, 'NEW.md'), 'one\ntwo\n');
    git(repo, ['add', 'NEW.md']);
    git(repo, ['commit', '--quiet', '-m', 'feat: add NEW']);
    writeFileSync(path.join(repo, 'NEW.md'), 'one\n');
    git(repo, ['commit', '--quiet', '-am', 'fix: trim NEW']);
    git(repo, ['checkout', '--quiet', vault.repo.branch]);

    await feature('alpha', 'awaiting_feature_close');
    index.apply(gateResult('FEAT-ALPHA', path.join(vault.paths.logsDir(), 'g.log')));

    const body = json(await readHandlers(context()).delivery(req({ slug: 'alpha' })));
    expect(body).toMatchObject({ baseBranch: vault.repo.branch, featureBranch: 'feature/alpha' });
    expect((body['commits'] as { subject: string }[]).map((c) => c.subject)).toEqual([
      'fix: trim NEW',
      'feat: add NEW',
    ]);
    expect(body['diffstat']).toEqual([{ file: 'NEW.md', added: 1, removed: 0 }]);
    expect(body['gateResults']).toEqual([
      { gateLogId: 'FEAT-ALPHA:tests:1', gate: 'tests', status: 'fail', exitCode: 1, durationMs: 10, at: NOW },
    ]);
  });

  it('uses the branch recorded on the feature note when there is one', async () => {
    const repo = vault.repo.path;
    git(repo, ['branch', 'custom/alpha']);
    await feature('alpha', 'awaiting_feature_close', { feature_branch: 'custom/alpha' });
    const body = json(await readHandlers(context()).delivery(req({ slug: 'alpha' })));
    expect(body).toMatchObject({ featureBranch: 'custom/alpha', commits: [], diffstat: [] });
  });

  it('is 404 when the feature branch does not exist', async () => {
    await feature('alpha', 'in_development');
    await expect(readHandlers(context()).delivery(req({ slug: 'alpha' }))).rejects.toMatchObject({ status: 404 });
  });

  it('is 404 for an unknown feature and 400 for an unsafe slug', async () => {
    await expect(readHandlers(context()).delivery(req({ slug: 'nope' }))).rejects.toMatchObject({ status: 404 });
    await expect(readHandlers(context()).delivery(req({ slug: '..' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('activity', () => {
  function writeEvents(lines: readonly string[]): void {
    writeFileSync(vault.paths.eventLog(), `${lines.join('\n')}\n`);
  }

  it('returns the last N events newest first, each with a summary', async () => {
    writeEvents([
      JSON.stringify({ ts: '1', type: 'cycle_started', cycle: 1 }),
      '{broken',
      JSON.stringify({ ts: '2', type: 'item_transitioned', itemId: 'FEAT-A', from: 'intake', to: 'refining', actor: 'orchestrator' }),
      JSON.stringify({ ts: '3', type: 'some_future_event' }),
    ]);
    const body = json(await readHandlers(context()).activity(req({}, 'limit=2')));
    expect(body['events']).toEqual([
      { ts: '3', type: 'some_future_event', summary: 'some_future_event' },
      expect.objectContaining({ ts: '2', type: 'item_transitioned', summary: 'FEAT-A: intake → refining' }),
    ]);
  });

  it('defaults to 100 events', async () => {
    writeEvents(Array.from({ length: 150 }, (_, i) => JSON.stringify({ ts: String(i), type: 'cycle_started' })));
    const events = json(await readHandlers(context()).activity(req()))['events'] as { ts: string }[];
    expect(events).toHaveLength(100);
    expect(events[0]?.ts).toBe('149');
  });

  it('is empty when there is no event log yet', async () => {
    expect(json(await readHandlers(context()).activity(req()))['events']).toEqual([]);
  });

  it.each(['0', '-5', 'abc', '1001'])('is 400 for limit=%j', async (limit) => {
    await expect(readHandlers(context()).activity(req({}, `limit=${limit}`))).rejects.toMatchObject({
      status: 400,
    });
  });
});

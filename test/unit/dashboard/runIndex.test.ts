/**
 * `RunIndex` (plan A10): runs are addressed by `runId`, gate logs by
 * `<itemId>:<gate>:<n>`, both built from `orchestrator.jsonl`. The fixture is
 * the real event log from the second acceptance run, paths scrubbed to `<ROOT>`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { RunIndex } from '../../../src/dashboard/runIndex.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'dashboard',
  'orchestrator.jsonl',
);

const realIndex = (): RunIndex => RunIndex.fromText(readFileSync(FIXTURE, 'utf8'));

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('RunIndex over the real acceptance event log', () => {
  it('indexes all 16 runs with the correct role, item and attempt', () => {
    const index = realIndex();
    const runs = index.allRuns().map((r) => [r.runId, r.role, r.itemId, r.attempt]);
    expect(runs).toEqual([
      ['FEAT-CALCULATOR-pm-a1-1', 'pm', 'FEAT-CALCULATOR', 1],
      ['FEAT-CALCULATOR-tl_plan-a1-1', 'tl_plan', 'FEAT-CALCULATOR', 1],
      ['FEAT-CALCULATOR-dl-a1-2', 'dl', 'FEAT-CALCULATOR', 1],
      ['FEAT-CALCULATOR-dl-a2-1', 'dl', 'FEAT-CALCULATOR', 2],
      ['FEAT-CALCULATOR-T001-developer-a1-1', 'developer', 'FEAT-CALCULATOR-T001', 1],
      ['FEAT-CALCULATOR-T001-code_reviewer-a1-2', 'code_reviewer', 'FEAT-CALCULATOR-T001', 1],
      ['FEAT-CALCULATOR-T001-qa-a1-3', 'qa', 'FEAT-CALCULATOR-T001', 1],
      ['FEAT-CALCULATOR-T002-developer-a1-4', 'developer', 'FEAT-CALCULATOR-T002', 1],
      ['FEAT-CALCULATOR-T002-code_reviewer-a1-5', 'code_reviewer', 'FEAT-CALCULATOR-T002', 1],
      ['FEAT-CALCULATOR-T002-qa-a1-6', 'qa', 'FEAT-CALCULATOR-T002', 1],
      ['FEAT-CALCULATOR-T003-developer-a1-7', 'developer', 'FEAT-CALCULATOR-T003', 1],
      ['FEAT-CALCULATOR-T003-code_reviewer-a1-8', 'code_reviewer', 'FEAT-CALCULATOR-T003', 1],
      ['FEAT-CALCULATOR-T003-qa-a1-9', 'qa', 'FEAT-CALCULATOR-T003', 1],
      ['FEAT-CALCULATOR-T004-developer-a1-10', 'developer', 'FEAT-CALCULATOR-T004', 1],
      ['FEAT-CALCULATOR-T004-code_reviewer-a1-11', 'code_reviewer', 'FEAT-CALCULATOR-T004', 1],
      ['FEAT-CALCULATOR-T004-qa-a1-12', 'qa', 'FEAT-CALCULATOR-T004', 1],
    ]);
  });

  it('records the retried Delivery Lead run as a failed attempt 1 and a passing attempt 2', () => {
    const index = realIndex();
    expect(index.run('FEAT-CALCULATOR-dl-a1-2')).toMatchObject({
      attempt: 1,
      finished: true,
      ok: false,
      costUsd: 0.5756852,
      durationMs: 268264,
      logPath: '<ROOT>/.factory-test-repos/orch-vault-yaQxXb/logs/calculator/FEAT-CALCULATOR-1-dl.log',
    });
    expect(index.run('FEAT-CALCULATOR-dl-a2-1')).toMatchObject({
      attempt: 2,
      finished: true,
      ok: true,
      logPath: '<ROOT>/.factory-test-repos/orch-vault-yaQxXb/logs/calculator/FEAT-CALCULATOR-2-dl.log',
    });
  });

  it('carries model and start time from run_started', () => {
    expect(realIndex().run('FEAT-CALCULATOR-pm-a1-1')).toMatchObject({
      model: 'sonnet',
      startedAt: '2026-09-22T09:00:19.000Z',
    });
  });

  it('indexes merge gate logs under the ticket, after its own gate run, in order', () => {
    const logs = realIndex().byItem('FEAT-CALCULATOR-T001').gateLogs;
    expect(logs.map((g) => g.gateLogId)).toEqual([
      'FEAT-CALCULATOR-T001:tests:1',
      'FEAT-CALCULATOR-T001:lint:1',
      'FEAT-CALCULATOR-T001:build:1',
      'FEAT-CALCULATOR-T001:tests:2',
      'FEAT-CALCULATOR-T001:lint:2',
      'FEAT-CALCULATOR-T001:build:2',
    ]);
    expect(logs[0]?.logPath.endsWith('/FEAT-CALCULATOR-T001-1-gate-tests.log')).toBe(true);
    expect(logs[3]?.logPath.endsWith('/FEAT-CALCULATOR-T001-merge-1-gate-tests.log')).toBe(true);
    expect(logs[5]).toMatchObject({ gate: 'build', status: 'pass', exitCode: 0, durationMs: 156 });
  });

  it('indexes close-<sha> gate logs under the feature', () => {
    const item = realIndex().byItem('FEAT-CALCULATOR');
    expect(item.gateLogs.map((g) => [g.gateLogId, path.basename(g.logPath)])).toEqual([
      ['FEAT-CALCULATOR:tests:1', 'FEAT-CALCULATOR-close-cd17de7e-2-gate-tests.log'],
      ['FEAT-CALCULATOR:lint:1', 'FEAT-CALCULATOR-close-cd17de7e-2-gate-lint.log'],
      ['FEAT-CALCULATOR:build:1', 'FEAT-CALCULATOR-close-cd17de7e-2-gate-build.log'],
    ]);
    expect(item.runs.map((r) => r.role)).toEqual(['pm', 'tl_plan', 'dl', 'dl']);
  });

  it('looks a gate log up by its id', () => {
    expect(realIndex().gateLog('FEAT-CALCULATOR-T004:lint:2')?.logPath).toMatch(
      /FEAT-CALCULATOR-T004-merge-1-gate-lint\.log$/,
    );
    expect(realIndex().gateLog('FEAT-CALCULATOR-T004:lint:3')).toBeUndefined();
  });

  it('indexes all 27 gate results', () => {
    const index = realIndex();
    const ids = ['FEAT-CALCULATOR', 'FEAT-CALCULATOR-T001', 'FEAT-CALCULATOR-T002', 'FEAT-CALCULATOR-T003', 'FEAT-CALCULATOR-T004'];
    expect(ids.reduce((n, id) => n + index.byItem(id).gateLogs.length, 0)).toBe(27);
  });

  it('returns empty lists for an item it has never seen', () => {
    expect(realIndex().byItem('FEAT-NOPE')).toEqual({ runs: [], gateLogs: [] });
  });
});

describe('RunIndex.apply', () => {
  const started = {
    ts: '2026-09-24T10:00:00.000Z',
    type: 'run_started',
    runId: 'FEAT-A-pm-a1-1',
    role: 'pm',
    itemId: 'FEAT-A',
    attempt: 1,
    model: 'sonnet',
    pid: 42,
    logPath: '/vault/logs/a/FEAT-A-1-pm.log',
  };

  it('records a new run as unfinished, then updates it when it finishes', () => {
    const index = new RunIndex();
    index.apply(started);
    expect(index.run('FEAT-A-pm-a1-1')).toMatchObject({
      finished: false,
      ok: null,
      costUsd: null,
      durationMs: null,
    });

    index.apply({
      type: 'run_finished',
      runId: 'FEAT-A-pm-a1-1',
      role: 'pm',
      ok: true,
      costUsd: 0.25,
      numTurns: 3,
      durationMs: 1200,
      terminalReason: 'completed',
      structuredOutputCalls: 1,
    });
    expect(index.run('FEAT-A-pm-a1-1')).toMatchObject({
      finished: true,
      ok: true,
      costUsd: 0.25,
      durationMs: 1200,
    });
  });

  it('ignores a run_finished for a run it never saw start', () => {
    const index = new RunIndex();
    index.apply({ type: 'run_finished', runId: 'ghost', ok: true, costUsd: 1, durationMs: 1 });
    expect(index.allRuns()).toEqual([]);
  });

  it('lets a later run_started with the same runId replace the earlier one', () => {
    const index = new RunIndex();
    index.apply(started);
    index.apply({ ...started, ts: '2026-09-24T11:00:00.000Z', logPath: '/vault/logs/a/second.log' });
    expect(index.allRuns()).toHaveLength(1);
    expect(index.run('FEAT-A-pm-a1-1')).toMatchObject({
      startedAt: '2026-09-24T11:00:00.000Z',
      logPath: '/vault/logs/a/second.log',
      finished: false,
    });
  });

  it('ignores events of other types and events with the wrong field types', () => {
    const index = new RunIndex();
    index.apply({ type: 'cycle_started' });
    index.apply({ ...started, logPath: 42 });
    index.apply({ ...started, attempt: 'one' });
    index.apply({ ...started, runId: '' });
    index.apply({ type: 'gate_result', itemId: 'X', gate: 'tests', status: 'pass' });
    index.apply(null);
    index.apply('run_started');
    expect(index.allRuns()).toEqual([]);
    expect(index.byItem('X').gateLogs).toEqual([]);
  });
});

describe('RunIndex.fromText / load', () => {
  it('skips a malformed jsonl line instead of failing', () => {
    const good = JSON.stringify({
      type: 'run_started',
      runId: 'R1',
      role: 'qa',
      itemId: 'FEAT-A-T001',
      attempt: 1,
      model: 'sonnet',
      pid: null,
      logPath: '/v/logs/a/x.log',
    });
    const index = RunIndex.fromText(`{"type":"run_st\n${good}\nnot json at all\n\n[1,2]\n`);
    expect(index.allRuns().map((r) => r.runId)).toEqual(['R1']);
  });

  it('loads an empty index when the event log does not exist yet', async () => {
    const dir = scratchDir('dash-runindex-');
    const index = await RunIndex.load(path.join(dir, 'logs', 'orchestrator.jsonl'));
    expect(index.allRuns()).toEqual([]);
  });

  it('loads the real event log from disk', async () => {
    expect((await RunIndex.load(FIXTURE)).allRuns()).toHaveLength(16);
  });
});

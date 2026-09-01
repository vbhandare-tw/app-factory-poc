/**
 * `MockRunner` end to end (plan Phase 5).
 *
 * Every test above unit level in Phases 7–11 runs on this, so its ergonomics
 * matter as much as its correctness. What is asserted here is not just "does it
 * return the payload" but the properties those later phases will lean on:
 *
 * - a fixture is addressable by role + item, not just by run id
 * - an unmatched run is a loud failure, never a plausible default
 * - the transcript and `.runs` lifecycle behave exactly as the real runner's do,
 *   so a pipeline test that asserts on logs is asserting on real behaviour
 * - an abort beats the fixture, so cancellation paths are testable
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { MemoryEventLog } from '../../src/log/events.js';
import { RunRegistry } from '../../src/log/runs.js';
import { MockRunner, fixtureKey, mockFailure, mockOk } from '../../src/runner/mock.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { testProfile, testSpec } from '../helpers/runnerFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../helpers/toyRepo.js';

afterAll(() => cleanupAllScratchDirs());

function vaultFor(prefix: string): VaultPaths {
  return new VaultPaths(scratchDir(prefix));
}

describe('MockRunner end to end', () => {
  it('spec in, canned output out, transcript written, .runs created and removed', async () => {
    const vault = vaultFor('mock-runner-');
    const runs = new RunRegistry(vault);
    const events = new MemoryEventLog();

    const payload = { outcome: 'ok', summary: 'added the calculator', commit_message: 'feat: add' };
    const runner = new MockRunner({
      fixtures: { [fixtureKey('developer', 'FEAT-DEMO-T001')]: mockOk(payload, { costUsd: 0.42 }) },
      runs,
      events,
      writeTranscripts: true,
    });

    const spec = testSpec({
      role: 'developer',
      itemId: 'FEAT-DEMO-T001',
      featureSlug: 'demo',
      attempt: 1,
      transcriptPath: vault.logPath('demo', 'FEAT-DEMO-T001', 1, 'developer'),
    });

    const result = await runner.run(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.structured).toEqual(payload);
    expect(result.costUsd).toBe(0.42);
    expect(runner.calls).toEqual([spec]);

    // Transcript: real file, valid JSONL, terminal result event last — the same
    // shape a pipeline test would assert against the real runner.
    expect(existsSync(spec.transcriptPath)).toBe(true);
    const lines = readFileSync(spec.transcriptPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[parsed.length - 1]).toMatchObject({ type: 'result', structured_output: payload });

    // The `.runs` entry existed and is gone.
    expect(existsSync(vault.runFile(spec.runId))).toBe(false);
    expect(await runs.list()).toEqual([]);

    expect(events.ofType('run_started')).toHaveLength(1);
    expect(events.ofType('run_finished')[0]).toMatchObject({ ok: true, costUsd: 0.42 });
  });

  it('resolves fixtures by runId, then role:item, then role', async () => {
    const runner = new MockRunner({
      fixtures: {
        'FEAT-DEMO-T001-developer-a1-0': mockOk({ which: 'runId' }),
        [fixtureKey('developer', 'FEAT-DEMO-T002')]: mockOk({ which: 'role:item' }),
        qa: mockOk({ which: 'role' }),
      },
    });
    const signal = new AbortController().signal;

    const byRunId = await runner.run(testSpec({ itemId: 'FEAT-DEMO-T001', attempt: 1 }), signal);
    expect(byRunId.structured).toEqual({ which: 'runId' });

    const byItem = await runner.run(testSpec({ itemId: 'FEAT-DEMO-T002', attempt: 3 }), signal);
    expect(byItem.structured).toEqual({ which: 'role:item' });

    const byRole = await runner.run(testSpec({ role: 'qa', itemId: 'FEAT-DEMO-T009' }), signal);
    expect(byRole.structured).toEqual({ which: 'role' });
  });

  it('throws loudly on an unmatched run rather than inventing a payload', async () => {
    // A plausible default would let a pipeline test pass while the orchestrator
    // dispatched the wrong role at the wrong item — the exact bug those tests
    // exist to catch.
    const runner = new MockRunner({ fixtures: { pm: mockOk({}) } });
    await expect(
      runner.run(testSpec({ role: 'developer', itemId: 'FEAT-X-T001' }), new AbortController().signal),
    ).rejects.toThrow(/no fixture for run .*Tried keys/s);
  });

  it('uses the fallback when one is supplied', async () => {
    const runner = new MockRunner({ fallback: mockOk({ which: 'fallback' }) });
    const result = await runner.run(testSpec(), new AbortController().signal);
    expect(result.structured).toEqual({ which: 'fallback' });
  });

  it('replays each failure mode the real runner can produce', async () => {
    const signal = new AbortController().signal;
    for (const failure of ['timeout', 'crash', 'schema', 'api_error'] as const) {
      const runner = new MockRunner({ fallback: mockFailure(failure) });
      const result = await runner.run(testSpec(), signal);
      expect(result.ok).toBe(false);
      expect(result.failure).toBe(failure);
      expect(result.structured).toBeNull();
    }
  });

  it('lets a test flip a fixture between attempts', async () => {
    // Phase 9 needs exactly this: attempt 1 red, attempt 2 green.
    const key = fixtureKey('developer', 'FEAT-DEMO-T001');
    const runner = new MockRunner({ fixtures: { [key]: mockFailure('schema') } });
    const signal = new AbortController().signal;

    expect((await runner.run(testSpec({ attempt: 1 }), signal)).failure).toBe('schema');
    runner.set(key, mockOk({ outcome: 'ok' }));
    expect((await runner.run(testSpec({ attempt: 2 }), signal)).ok).toBe(true);
  });

  it('honours an abort mid-delay and still tears the run entry down', async () => {
    const vault = vaultFor('mock-runner-abort-');
    const runs = new RunRegistry(vault);
    const runner = new MockRunner({ fallback: mockOk({}, { delayMs: 30_000 }), runs });
    const controller = new AbortController();
    const spec = testSpec();

    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await runner.run(spec, controller.signal);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(false);
    // NOT 'timeout'. An external abort is the orchestrator cancelling, not the
    // agent running over its budget, and `ClaudeCodeRunner` says the same thing
    // for the same stimulus — see `runner-parity.test.ts`.
    expect(result.failure).toBe('aborted');
    expect(existsSync(vault.runFile(spec.runId))).toBe(false);
  });

  it('enforces the profile timeout, exactly as the real runner does', async () => {
    // The mock used to ignore `profile.timeoutMs` entirely, so a Phase 9 test
    // asserting "a slow agent times out" would have hung or passed for the
    // wrong reason.
    const runner = new MockRunner({ fallback: mockOk({}, { delayMs: 30_000 }) });
    const spec = testSpec({ profile: testProfile({ timeoutMs: 400 }) });

    const started = Date.now();
    const result = await runner.run(spec, new AbortController().signal);

    expect(result.failure).toBe('timeout');
    expect(result.ok).toBe(false);
    // Waited the real budget rather than returning instantly, so ordering
    // assertions in later phases see the same sequence as production.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('registers the .runs entry for the duration of a slow run', async () => {
    const vault = vaultFor('mock-runner-live-');
    const runs = new RunRegistry(vault);
    const runner = new MockRunner({ fallback: mockOk({}, { delayMs: 400 }), runs });
    const spec = testSpec({ itemId: 'FEAT-DEMO-T007', featureSlug: 'demo' });

    const pending = runner.run(spec, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Mid-run: this is what M7's "what is running" view reads.
    const live = await runs.list();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      runId: spec.runId,
      role: 'developer',
      ticket: 'FEAT-DEMO-T007',
      feature: 'demo',
      pid: process.pid,
    });

    await pending;
    expect(await runs.list()).toEqual([]);
  });
});

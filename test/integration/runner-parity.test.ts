/**
 * `MockRunner` and `ClaudeCodeRunner` must answer the same stimulus the same way.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * Every test above unit level in Phases 7 through 11 runs on `MockRunner`. That
 * only buys anything if the mock's answers match the real runner's. When they
 * differ, a pipeline test written against the mock passes, is wrong about what
 * production does, and stays wrong until somebody runs the real thing — which
 * is Phase 12.
 *
 * It has already happened once. The mock reported an external `AbortSignal` as
 * `failure: 'timeout'`; `ClaudeCodeRunner` reported the identical stimulus as
 * `failure: 'crash'`. Both were "safe" in that neither advanced a ticket, so
 * nothing went red and nothing would have until a real cancellation.
 *
 * ============================================================================
 * WHY IT IS SHAPED LIKE THIS
 * ============================================================================
 * The obvious fix — assert each runner's behaviour in its own test file — does
 * not hold the line: two separate assertions drift apart exactly as easily as
 * two implementations do, and the suite stays green while they do it. So each
 * case below drives **both** implementations through one stimulus and asserts
 * they agree with *each other*, then that they agree with the expected value.
 *
 * The first assertion catches divergence. The second catches both drifting
 * together. Neither alone is enough.
 *
 * No money is spent: the real runner here talks to the stub `claude`.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { ClaudeCodeRunner } from '../../src/runner/claudeCode.js';
import { MockRunner, mockFailure } from '../../src/runner/mock.js';
import type { MockRunFixture } from '../../src/runner/mock.js';
import type { AgentRunResult, AgentRunSpec, StructuredValidation } from '../../src/runner/types.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { testProfile, testSandboxConfig, testSpec } from '../helpers/runnerFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../helpers/toyRepo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.resolve(HERE, '..', 'helpers', 'stubClaude.mjs');

afterAll(() => cleanupAllScratchDirs());

/** A scratch dir with a `claude` shim on PATH, plus a vault for the transcripts. */
function bench(mode: string): { dir: string; vault: VaultPaths; env: NodeJS.ProcessEnv } {
  const dir = scratchDir('parity-');
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${STUB_SOURCE}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);

  return {
    dir,
    vault: new VaultPaths(path.join(dir, 'vault')),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      STUB_CLAUDE_MODE: mode,
      STUB_CLAUDE_PIDFILE: path.join(dir, 'pids.json'),
    },
  };
}

const onlyOk = (value: unknown): StructuredValidation =>
  (value as { outcome?: string }).outcome === 'ok'
    ? { ok: true }
    : { ok: false, issues: ['outcome must be ok'] };

interface Scenario {
  readonly name: string;
  /** Which stub behaviour drives the real runner. */
  readonly stubMode: string;
  /** The fixture that drives the mock through the equivalent situation. */
  readonly mockFixture: MockRunFixture;
  readonly timeoutMs: number;
  /** Abort this many ms into the run, or never. */
  readonly abortAfterMs?: number;
  readonly validate?: boolean;
  /** `undefined` means "the run succeeded". */
  readonly expected: AgentRunResult['failure'];
  /**
   * How many `StructuredOutput` calls both runners must report.
   *
   * The count is the Phase 7b early warning for a payload approaching the size
   * at which the CLI's delivery starts failing. It is only worth anything if
   * the mock's number is the one production would produce — otherwise every
   * pipeline test asserts against a fiction, which is how `'aborted'` versus
   * `'timeout'` got away from us.
   */
  readonly expectedCalls: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'the caller aborts mid-run',
    stubMode: 'hang',
    // A killed run delivered nothing: the stub emits its init line and then
    // hangs, and the mock must reach the same answer on its own. It used to
    // need `structuredOutputCalls: 0` spelled out here, which was the fixture
    // hiding a real divergence rather than describing one — the mock wrote its
    // whole canned transcript before it simulated any work, so a killed mock
    // run "delivered". Nothing is forced now.
    mockFixture: { delayMs: 30_000 },
    timeoutMs: 60_000,
    abortAfterMs: 300,
    expected: 'aborted',
    expectedCalls: 0,
  },
  {
    name: 'the profile timeout elapses',
    stubMode: 'hang',
    mockFixture: { delayMs: 30_000 },
    timeoutMs: 1_200,
    expected: 'timeout',
    expectedCalls: 0,
  },
  {
    name: 'the run completes cleanly',
    stubMode: 'success',
    mockFixture: { structured: { outcome: 'ok', note: 'from the stub' } },
    timeoutMs: 30_000,
    expected: undefined,
    // One delivery, accepted first time. Neither runner may say 0 here: a
    // payload came back, so a `StructuredOutput` call happened.
    expectedCalls: 1,
  },
];

/** Cases where the mock is told the outcome and the stub is made to produce it. */
const FAILURE_SCENARIOS = [
  {
    name: 'the CLI reports is_error',
    stubMode: 'api_error',
    expected: 'api_error' as const,
    validate: false,
    expectedCalls: 0,
  },
  {
    name: 'the stream is truncated',
    stubMode: 'truncated',
    expected: 'crash' as const,
    validate: false,
    expectedCalls: 0,
  },
  {
    name: 'the payload fails validation',
    stubMode: 'schema_violation',
    expected: 'schema' as const,
    validate: true,
    // The payload was delivered; it was our validator that rejected it.
    expectedCalls: 1,
  },
  {
    // Phase 7b's actual failure: the CLI mangles a parameter boundary, rejects
    // the agent's own payload, retries, and gives up. It arrives as
    // `is_error: true`, which `interpretRun` answers at check 4 and returns
    // from immediately — so this is the case a count computed only on the
    // success path would silently drop, on both implementations at once.
    name: 'delivery retries are exhausted',
    stubMode: 'retried_delivery',
    expected: 'api_error' as const,
    validate: false,
    // Five, not an arbitrary number: it is the CLI's retry cap. Three of the
    // three preserved Phase 7b runs that hit it made exactly five calls, and a
    // fourth run succeeded on its fifth and final permitted try
    // (`.factory-test-repos/pipeline-real-logs/run-2/evaluate/`).
    expectedCalls: 5,
    // The real result event carries `terminal_reason` AND `subtype`, and
    // `readResultFields` reads `terminal_reason` first — so this is what the
    // orchestrator sees, and it matches what the paid `pipeline-real.test.ts`
    // has always said. Asserted because it is the only thing holding the stub
    // to its calibration: without it the stub could drift and nothing would
    // notice.
    expectedTerminalReason: 'structured_output_retry_exhausted',
    mockExtra: {
      terminalReason: 'structured_output_retry_exhausted',
      structuredOutputCalls: 5,
    } as MockRunFixture,
  },
];

async function runReal(scenario: {
  stubMode: string;
  timeoutMs: number;
  abortAfterMs?: number;
  validate?: boolean;
}): Promise<AgentRunResult> {
  const b = bench(scenario.stubMode);
  const runner = new ClaudeCodeRunner({
    config: testSandboxConfig(),
    repoRoot: path.join(b.dir, 'repo'),
    env: b.env,
    killGraceMs: 400,
  });
  const spec = specFor(b.vault, scenario, b.dir);
  const controller = new AbortController();
  if (scenario.abortAfterMs !== undefined) {
    setTimeout(() => controller.abort(), scenario.abortAfterMs);
  }
  return runner.run(spec, controller.signal);
}

async function runMock(
  scenario: { timeoutMs: number; abortAfterMs?: number; validate?: boolean },
  fixture: MockRunFixture,
): Promise<AgentRunResult> {
  const dir = scratchDir('parity-mock-');
  const vault = new VaultPaths(path.join(dir, 'vault'));
  const runner = new MockRunner({ fallback: fixture });
  const spec = specFor(vault, scenario, dir);
  const controller = new AbortController();
  if (scenario.abortAfterMs !== undefined) {
    setTimeout(() => controller.abort(), scenario.abortAfterMs);
  }
  return runner.run(spec, controller.signal);
}

function specFor(
  vault: VaultPaths,
  scenario: { timeoutMs: number; validate?: boolean },
  cwd: string,
): AgentRunSpec {
  return testSpec({
    itemId: 'FEAT-PARITY-T001',
    featureSlug: 'parity',
    // A real, existing directory. The default in `testSpec` does not exist, and
    // spawning there fails ENOENT — which the runner correctly reports as a
    // crash, making every parity case agree on the wrong thing.
    cwd,
    profile: testProfile({ timeoutMs: scenario.timeoutMs }),
    transcriptPath: vault.logPath('parity', 'FEAT-PARITY-T001', 1, 'developer'),
    ...(scenario.validate === true ? { validateStructured: onlyOk } : {}),
  });
}

describe('MockRunner and ClaudeCodeRunner agree on the same stimulus', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} → both report the same failure`, async () => {
      const real = await runReal(scenario);
      const mock = await runMock(scenario, scenario.mockFixture);

      expect(
        mock.failure,
        `MockRunner and ClaudeCodeRunner disagree on "${scenario.name}": the mock says ` +
          `${String(mock.failure)}, the real runner says ${String(real.failure)}. Every pipeline ` +
          'test in Phases 7-11 runs on the mock, so this divergence would be invisible until a ' +
          'real run in Phase 12.',
      ).toBe(real.failure);

      // ...and both must be right, not merely equal to each other.
      expect(real.failure).toBe(scenario.expected);
      expect(mock.ok).toBe(real.ok);
      expect(real.ok).toBe(scenario.expected === undefined);

      expect(
        mock.structuredOutputCalls,
        `MockRunner and ClaudeCodeRunner disagree on how many StructuredOutput calls ` +
          `"${scenario.name}" made: the mock says ${String(mock.structuredOutputCalls)}, the real ` +
          `runner says ${String(real.structuredOutputCalls)}.`,
      ).toBe(real.structuredOutputCalls);
      expect(real.structuredOutputCalls).toBe(scenario.expectedCalls);
    }, 60_000);
  }

  for (const scenario of FAILURE_SCENARIOS) {
    it(`${scenario.name} → both report the same failure`, async () => {
      const shape = { stubMode: scenario.stubMode, timeoutMs: 30_000, validate: scenario.validate };
      const real = await runReal(shape);
      const mock = await runMock(
        shape,
        mockFailure(scenario.expected, 'mockExtra' in scenario ? scenario.mockExtra : {}),
      );

      expect(
        mock.failure,
        `MockRunner and ClaudeCodeRunner disagree on "${scenario.name}"`,
      ).toBe(real.failure);
      expect(real.failure).toBe(scenario.expected);
      expect(mock.ok).toBe(real.ok);

      expect(
        mock.structuredOutputCalls,
        `MockRunner and ClaudeCodeRunner disagree on how many StructuredOutput calls ` +
          `"${scenario.name}" made: the mock says ${String(mock.structuredOutputCalls)}, the real ` +
          `runner says ${String(real.structuredOutputCalls)}.`,
      ).toBe(real.structuredOutputCalls);
      expect(real.structuredOutputCalls).toBe(scenario.expectedCalls);

      if ('expectedTerminalReason' in scenario) {
        expect(real.terminalReason).toBe(scenario.expectedTerminalReason);
        expect(mock.terminalReason).toBe(real.terminalReason);
      }
    }, 60_000);
  }

  it('every AgentFailure kind is reachable through both implementations', () => {
    // Guards the other direction: a new failure kind added to the taxonomy with
    // no parity coverage is a silent gap in exactly the place one already
    // opened. Keeping this list here means adding a kind is a red test, not a
    // quiet omission.
    const covered = new Set<string>([
      ...SCENARIOS.map((s) => s.expected).filter((f): f is NonNullable<typeof f> => f !== undefined),
      ...FAILURE_SCENARIOS.map((s) => s.expected),
    ]);
    expect([...covered].sort()).toEqual(['aborted', 'api_error', 'crash', 'schema', 'timeout']);
  });
});

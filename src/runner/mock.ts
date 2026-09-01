/**
 * The `Runner` every test above unit level runs on (spec §8.1, plan Phase 5).
 *
 * Its ergonomics matter as much as its correctness: Phases 7 through 11 are
 * written against this, so a fixture map that is awkward to express makes every
 * later pipeline test awkward to read.
 *
 * The one deliberate harshness: **an unmatched key throws.** Returning a
 * plausible default payload would let a pipeline test pass while dispatching
 * the wrong role at the wrong item, which is the exact bug those tests exist to
 * catch. Pass `fallback` when a test genuinely does not care which run happens.
 */
import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import type { TranscriptSink } from '../log/transcript.js';
import { TranscriptWriter } from '../log/transcript.js';
import type { AgentFailure, AgentRunResult, AgentRunSpec, Runner } from './types.js';

/** One canned run. Every field is optional; the defaults describe a cheap success. */
export interface MockRunFixture {
  /** The payload handed back as `structured`. Ignored when `failure` is set. */
  readonly structured?: unknown;
  /** Force a failure mode instead of a success. */
  readonly failure?: AgentFailure;
  readonly costUsd?: number;
  readonly numTurns?: number;
  /** Simulated wall clock. Honours the abort signal, so timeout tests work. */
  readonly delayMs?: number;
  /** Lines written to the transcript, so log assertions have something to read. */
  readonly transcript?: readonly string[];
  readonly terminalReason?: string;
  readonly sessionId?: string;
  readonly permissionDenials?: readonly unknown[];
}

export interface MockRunnerOptions {
  /**
   * Keyed by, in resolution order: the exact `runId`, then `<role>:<itemId>`,
   * then `<role>`. The middle form is the one plan Phase 5 specifies and the
   * one most tests want.
   */
  readonly fixtures?: Readonly<Record<string, MockRunFixture>>;
  /** Used when no key matches. Absent means an unmatched run is an error. */
  readonly fallback?: MockRunFixture;
  readonly runs?: RunSink;
  readonly events?: EventSink;
  /** Write real transcript files. Off by default so unit tests need no disk. */
  readonly writeTranscripts?: boolean;
  readonly openTranscript?: (spec: AgentRunSpec) => Promise<TranscriptSink>;
  readonly now?: () => string;
}

/** Convenience: a successful run returning `structured`. */
export function mockOk(structured: unknown, extra: MockRunFixture = {}): MockRunFixture {
  return { structured, ...extra };
}

/** Convenience: a run that fails the given way. */
export function mockFailure(failure: AgentFailure, extra: MockRunFixture = {}): MockRunFixture {
  return { failure, ...extra };
}

/** The key `MockRunner` looks up second — exported so tests build it the same way. */
export function fixtureKey(role: string, itemId: string): string {
  return `${role}:${itemId}`;
}

export class MockRunner implements Runner {
  /** Every spec this runner was handed, in order. The main assertion surface. */
  readonly calls: AgentRunSpec[] = [];
  private readonly fixtures: Map<string, MockRunFixture>;
  private readonly options: MockRunnerOptions;

  constructor(options: MockRunnerOptions = {}) {
    this.options = options;
    this.fixtures = new Map(Object.entries(options.fixtures ?? {}));
  }

  /** Add or replace a fixture mid-test, e.g. to make attempt 2 succeed. */
  set(key: string, fixture: MockRunFixture): this {
    this.fixtures.set(key, fixture);
    return this;
  }

  /** Which key a spec would resolve to, or null. Useful in failure messages. */
  keyFor(spec: Pick<AgentRunSpec, 'runId' | 'role' | 'itemId'>): string | null {
    for (const candidate of [spec.runId, fixtureKey(spec.role, spec.itemId), spec.role]) {
      if (this.fixtures.has(candidate)) return candidate;
    }
    return null;
  }

  async run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult> {
    this.calls.push(spec);
    const startedAtMs = Date.now();
    const now = this.options.now ?? ((): string => new Date().toISOString());

    const key = this.keyFor(spec);
    const fixture = key === null ? this.options.fallback : this.fixtures.get(key);
    if (fixture === undefined) {
      throw new Error(
        `MockRunner has no fixture for run ${spec.runId} (role ${spec.role}, item ${spec.itemId}). ` +
          `Tried keys: ${spec.runId}, ${fixtureKey(spec.role, spec.itemId)}, ${spec.role}. ` +
          'Add one, or pass `fallback` if this test does not care which run happens.',
      );
    }

    const transcript = await this.openTranscript(spec);

    await this.options.runs?.register({
      runId: spec.runId,
      role: spec.role,
      ticket: spec.itemId,
      feature: spec.featureSlug,
      attempt: spec.attempt,
      pid: process.pid,
      startedAt: now(),
      logPath: spec.transcriptPath,
    });

    await this.options.events?.emit({
      type: 'run_started',
      runId: spec.runId,
      role: spec.role,
      itemId: spec.itemId,
      attempt: spec.attempt,
      model: spec.model,
      pid: process.pid,
      logPath: spec.transcriptPath,
    });

    try {
      for (const line of fixture.transcript ?? defaultTranscript(spec, fixture)) {
        await transcript.writeLine(line);
      }
      // The mock enforces the profile timeout for the same reason it honours
      // the abort signal: `ClaudeCodeRunner` does, and a mock that ignores it
      // would let a Phase 9 timeout test pass while the real pipeline hung.
      const interruption = await waitOut(fixture.delayMs ?? 0, spec.profile.timeoutMs, signal);

      const result = buildResult(spec, fixture, interruption, Date.now() - startedAtMs);
      await this.options.events?.emit({
        type: 'run_finished',
        runId: spec.runId,
        role: spec.role,
        ok: result.ok,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        durationMs: result.durationMs,
        terminalReason: result.terminalReason,
      });
      return result;
    } finally {
      await transcript.close().catch(() => undefined);
      await this.options.runs?.complete(spec.runId);
    }
  }

  private openTranscript(spec: AgentRunSpec): Promise<TranscriptSink> {
    if (this.options.openTranscript !== undefined) return this.options.openTranscript(spec);
    if (this.options.writeTranscripts === true) return TranscriptWriter.open(spec.transcriptPath);
    return Promise.resolve(NULL_TRANSCRIPT);
  }
}

const NULL_TRANSCRIPT: TranscriptSink = {
  writeLine: (): Promise<void> => Promise.resolve(),
  close: (): Promise<void> => Promise.resolve(),
};

function buildResult(
  spec: AgentRunSpec,
  fixture: MockRunFixture,
  interruption: Interruption,
  measuredMs: number,
): AgentRunResult {
  const base = {
    costUsd: fixture.costUsd ?? 0.01,
    numTurns: fixture.numTurns ?? 1,
    durationMs: measuredMs,
    sessionId: fixture.sessionId ?? `mock-${spec.runId}`,
    permissionDenials: [...(fixture.permissionDenials ?? [])],
  };

  // An interruption beats the fixture: a test that aborts or times out mid-run
  // is testing the orchestrator's cancellation path, not the canned payload.
  //
  // These two mappings must match `ClaudeCodeRunner` exactly. They are the ones
  // that silently diverged once already, and `runner-parity.test.ts` is what
  // stops it happening again — change either one and that test goes red.
  if (interruption === 'aborted') {
    return { ...base, ok: false, structured: null, failure: 'aborted', terminalReason: 'aborted by caller' };
  }
  if (interruption === 'timeout') {
    return { ...base, ok: false, structured: null, failure: 'timeout', terminalReason: 'timeout' };
  }

  if (fixture.failure !== undefined) {
    return {
      ...base,
      ok: false,
      structured: null,
      failure: fixture.failure,
      terminalReason: fixture.terminalReason ?? fixture.failure,
      ...(fixture.failure === 'schema' ? { rawStructured: fixture.structured ?? null } : {}),
    };
  }

  return {
    ...base,
    ok: true,
    structured: fixture.structured ?? null,
    rawStructured: fixture.structured ?? null,
    terminalReason: fixture.terminalReason ?? 'completed',
  };
}

function defaultTranscript(spec: AgentRunSpec, fixture: MockRunFixture): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', mock: true, session_id: `mock-${spec.runId}` }),
    JSON.stringify({
      type: 'result',
      subtype: fixture.failure ?? 'success',
      is_error: fixture.failure !== undefined,
      structured_output: fixture.structured ?? null,
      total_cost_usd: fixture.costUsd ?? 0.01,
      mock: true,
    }),
  ];
}

/** How a simulated run ended, if it did not simply finish. */
type Interruption = 'completed' | 'aborted' | 'timeout';

/**
 * Simulate `delayMs` of work, racing the caller's abort signal and the
 * profile's own timeout — whichever comes first.
 *
 * The waits are real rather than instant so that a test asserting on ordering
 * (claim released *after* the timeout, say) sees the same sequence it would
 * against the real runner.
 */
function waitOut(delayMs: number, timeoutMs: number, signal: AbortSignal): Promise<Interruption> {
  if (signal.aborted) return Promise.resolve('aborted');

  const timesOut = timeoutMs > 0 && timeoutMs <= delayMs;
  const waitMs = timesOut ? timeoutMs : delayMs;
  const ending: Interruption = timesOut ? 'timeout' : 'completed';

  if (waitMs <= 0) return Promise.resolve(ending);

  return new Promise<Interruption>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(ending);
    }, waitMs);
    function onAbort(): void {
      clearTimeout(timer);
      resolve('aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

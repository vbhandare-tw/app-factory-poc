/**
 * Reading the `--output-format stream-json` JSONL stream (plan resolution A1).
 *
 * Pure and spawn-free so `test/unit/runner/streamParse.test.ts` can feed it
 * recorded fixtures. The shapes here were recorded from a real CLI v2.1.220 run
 * on 2026-09-01 — see `test/fixtures/runner/` and the note in
 * `test/integration/runner-stub.test.ts` about re-calibrating them.
 *
 * The one rule that matters: **a stream without a terminal `result` event is a
 * crash, never a success.** A killed process, a truncated pipe and an OOM all
 * look identical from here, and the safe reading of all three is "we do not
 * know what the agent did".
 */
import type {
  AgentFailure,
  AgentRunResult,
  StructuredValidator,
} from './types.js';

/** `type: "result"` — the terminal event (plan resolution A1). */
export const RESULT_EVENT_TYPE = 'result';

/**
 * Split a byte stream into complete lines.
 *
 * A chunk boundary lands mid-line often enough that doing this by hand in the
 * runner is a guaranteed bug: half a JSON object parsed as a "malformed line",
 * with the other half silently dropped.
 */
export class JsonlLineSplitter {
  private buffer = '';

  /** Complete lines contained in `chunk`, leaving any partial tail buffered. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either '' (chunk ended on a newline) or a partial line.
    this.buffer = lines.pop() ?? '';
    return lines.map(stripCr).filter((line) => line.length > 0);
  }

  /**
   * Whatever is left when the stream closes.
   *
   * A final line with no trailing newline is normal, not an error — the CLI's
   * last `result` event has arrived this way.
   */
  flush(): string[] {
    const rest = stripCr(this.buffer);
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }

  get pending(): string {
    return this.buffer;
  }
}

export interface StreamObservation {
  /** The terminal `result` event, or null if the stream never produced one. */
  readonly resultEvent: Record<string, unknown> | null;
  /** Every line seen, JSON or not. */
  readonly lineCount: number;
  /** Lines that were not parseable JSON — logged, never fatal (plan Phase 5). */
  readonly malformedLines: readonly string[];
}

/**
 * Accumulates what the runner needs from the stream while it is still arriving.
 *
 * Deliberately keeps only the `result` event, not every event: a long developer
 * run emits thousands of lines and holding them all in memory buys nothing —
 * the transcript on disk is the record.
 */
export class StreamCollector {
  private result: Record<string, unknown> | null = null;
  private lines = 0;
  private readonly malformed: string[] = [];

  /** Feed one complete line. Returns the parsed event, or null if unparseable. */
  onLine(line: string): Record<string, unknown> | null {
    this.lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.malformed.push(line);
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.malformed.push(line);
      return null;
    }
    const event = parsed as Record<string, unknown>;
    if (event['type'] === RESULT_EVENT_TYPE) {
      // Last one wins. There is only ever one, but "last" is the safer rule
      // than "first" if the CLI ever emits a retry.
      this.result = event;
    }
    return event;
  }

  observation(): StreamObservation {
    return { resultEvent: this.result, lineCount: this.lines, malformedLines: [...this.malformed] };
  }
}

export interface InterpretInput {
  readonly observation: StreamObservation;
  /** Process exit code, or null if it was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when the runner's own timeout fired, whatever the process then did. */
  readonly timedOut: boolean;
  /**
   * True when the caller's `AbortSignal` fired — an orchestrator shutdown or
   * drain, not an agent failure. Kept separate from `timedOut` because the two
   * mean opposite things about whose fault the run was; see `AgentFailure`.
   */
  readonly aborted?: boolean;
  /** Wall-clock duration measured by the runner, used when the event has none. */
  readonly durationMs: number;
  readonly validateStructured?: StructuredValidator | undefined;
  /** Tail of stderr, folded into `terminalReason` on failure. */
  readonly stderrTail?: string;
}

/**
 * Turn a finished stream into an `AgentRunResult`.
 *
 * The checks run in a fixed order, most-informative first, and every one of
 * them fails closed:
 *
 *   1. timeout    — the runner gave up; nothing the stream says can override it
 *   2. aborted    — the caller cancelled; also not something the stream decides
 *   3. no result  — truncated stream, killed process: `crash`
 *   4. is_error   — the CLI told us it failed: `api_error`
 *   5. exit != 0  — it failed and did not say so: `crash`
 *   6. schema     — payload absent, not an object, or rejected by the validator
 *
 * Timeout is checked before abort, not the other way round: if our own deadline
 * elapsed and the caller then aborted during the SIGTERM grace, the agent still
 * ran over its budget and that is the more useful thing to report. In practice
 * the runner records whichever fired first, so both are rarely set together.
 */
export function interpretRun(input: InterpretInput): AgentRunResult {
  const event = input.observation.resultEvent;
  const base = readResultFields(event, input.durationMs);

  if (input.timedOut) {
    return { ...base, ok: false, structured: null, failure: 'timeout', terminalReason: withStderr('timeout', input) };
  }

  if (input.aborted === true) {
    return {
      ...base,
      ok: false,
      structured: null,
      failure: 'aborted',
      terminalReason: withStderr('aborted by caller', input),
    };
  }

  if (event === null) {
    return {
      ...base,
      ok: false,
      structured: null,
      failure: 'crash',
      terminalReason: withStderr(
        input.signal !== null
          ? `no result event; killed by ${input.signal}`
          : `no result event; exit ${String(input.exitCode)}`,
        input,
      ),
    };
  }

  if (event['is_error'] === true) {
    return { ...base, ok: false, structured: null, failure: 'api_error', terminalReason: withStderr(base.terminalReason, input) };
  }

  if (input.exitCode !== 0) {
    return {
      ...base,
      ok: false,
      structured: null,
      failure: 'crash',
      terminalReason: withStderr(
        `result event reported success but the process exited ${String(input.exitCode)}` +
          (input.signal !== null ? ` (signal ${input.signal})` : ''),
        input,
      ),
    };
  }

  const raw = event['structured_output'];
  const validation = validateStructured(raw, input.validateStructured);
  if (!validation.ok) {
    return {
      ...base,
      ok: false,
      structured: null,
      rawStructured: raw ?? null,
      schemaIssues: validation.issues,
      failure: 'schema',
      terminalReason: base.terminalReason,
    };
  }

  return { ...base, ok: true, structured: raw, rawStructured: raw };
}

function validateStructured(
  raw: unknown,
  validator: StructuredValidator | undefined,
): { ok: true } | { ok: false; issues: string[] } {
  if (raw === null || raw === undefined) {
    return { ok: false, issues: ['result event carried no structured_output'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [`structured_output is ${describe(raw)}, expected an object`] };
  }
  if (validator === undefined) return { ok: true };

  const outcome = validator(raw);
  return outcome.ok ? { ok: true } : { ok: false, issues: [...outcome.issues] };
}

type ResultFields = Omit<AgentRunResult, 'ok' | 'structured' | 'failure' | 'rawStructured' | 'schemaIssues'>;

function readResultFields(event: Record<string, unknown> | null, measuredMs: number): ResultFields {
  return {
    costUsd: numberOr(event?.['total_cost_usd'], 0),
    numTurns: numberOr(event?.['num_turns'], 0),
    durationMs: numberOr(event?.['duration_ms'], measuredMs),
    sessionId: stringOr(event?.['session_id'], ''),
    terminalReason:
      stringOr(event?.['terminal_reason'], '') ||
      stringOr(event?.['subtype'], '') ||
      stringOr(event?.['stop_reason'], '') ||
      'unknown',
    permissionDenials: Array.isArray(event?.['permission_denials']) ? [...(event['permission_denials'] as unknown[])] : [],
  };
}

function withStderr(reason: string, input: InterpretInput): string {
  const tail = (input.stderrTail ?? '').trim();
  return tail.length > 0 ? `${reason}: ${tail}` : reason;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Re-exported so callers can narrow on it without importing `types.js` twice. */
export type { AgentFailure };

/**
 * Reading the JSONL stream, fed recorded fixtures — no spawning (plan Phase 5).
 *
 * The failure taxonomy here decides what the orchestrator does next
 * (spec §9.1), and every mapping is a "fail closed" choice: anything the runner
 * cannot positively confirm as a clean, schema-valid result becomes a failed
 * attempt rather than a silent advance.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  JsonlLineSplitter,
  StreamCollector,
  interpretRun,
} from '../../../src/runner/streamParse.js';
import type { StreamObservation } from '../../../src/runner/streamParse.js';
import { REAL_STREAM_FIXTURE } from '../../helpers/runnerFixtures.js';

/** Feed whole lines through a collector, the way the runner does. */
function observe(lines: readonly string[]): StreamObservation {
  const collector = new StreamCollector();
  for (const line of lines) collector.onLine(line);
  return collector.observation();
}

function linesOf(raw: string): string[] {
  return raw.split('\n').filter((line) => line.length > 0);
}

const REAL_LINES = linesOf(readFileSync(REAL_STREAM_FIXTURE, 'utf8'));

function run(
  observation: StreamObservation,
  overrides: Partial<Parameters<typeof interpretRun>[0]> = {},
): ReturnType<typeof interpretRun> {
  return interpretRun({
    observation,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1234,
    ...overrides,
  });
}

describe('JsonlLineSplitter', () => {
  it('reassembles a JSON object split across chunk boundaries', () => {
    // The single most likely real-world parse bug: half an object treated as a
    // malformed line while the other half is dropped.
    const splitter = new JsonlLineSplitter();
    expect(splitter.push('{"type":"sys')).toEqual([]);
    expect(splitter.push('tem"}\n{"type":"result"')).toEqual(['{"type":"system"}']);
    expect(splitter.push('}')).toEqual([]);
    expect(splitter.flush()).toEqual(['{"type":"result"}']);
  });

  it('handles a final line with no trailing newline, and skips blank lines', () => {
    const splitter = new JsonlLineSplitter();
    expect(splitter.push('a\n\nb\n')).toEqual(['a', 'b']);
    expect(splitter.push('tail')).toEqual([]);
    expect(splitter.flush()).toEqual(['tail']);
    expect(splitter.flush()).toEqual([]);
  });
});

describe('interpretRun', () => {
  it('a well-formed stream yields ok:true, the structured payload and the cost', () => {
    const result = run(observe(REAL_LINES));

    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.structured).toEqual({
      outcome: 'Command executed: node probe.mjs .. returned "PROBE_WRITTEN"',
    });
    // total_cost_usd is extracted — the feature's cost_usd accumulates from it
    // (spec §12) and the run_budget warning depends on it being a real number.
    expect(result.costUsd).toBeCloseTo(0.0211439, 6);
    expect(result.numTurns).toBe(3);
    expect(result.durationMs).toBe(5460);
    expect(result.sessionId).toBe('3e290f77-fe0b-448f-8e10-14b995acf52e');
    expect(result.terminalReason).toBe('completed');
    expect(result.permissionDenials).toEqual([]);
  });

  it('a result event with is_error:true yields failure "api_error"', () => {
    const result = run(
      observe([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          total_cost_usd: 0.004,
          num_turns: 1,
          terminal_reason: 'error',
          structured_output: { outcome: 'ok' },
        }),
      ]),
      { exitCode: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('api_error');
    // A payload arriving alongside is_error is not trusted (spec §5 rule 2).
    expect(result.structured).toBeNull();
    expect(result.costUsd).toBe(0.004);
  });

  it('a stream truncated mid-way yields failure "crash", not a parse exception', () => {
    // The killed-process case. Cut the recorded stream before its result event
    // and slice the last surviving line in half.
    const truncated = REAL_LINES.slice(0, 8);
    const lastIndex = truncated.length - 1;
    truncated[lastIndex] = (truncated[lastIndex] ?? '').slice(0, 40);

    const splitter = new JsonlLineSplitter();
    const collector = new StreamCollector();
    for (const line of splitter.push(`${truncated.join('\n')}`)) collector.onLine(line);
    for (const line of splitter.flush()) collector.onLine(line);

    const observation = collector.observation();
    expect(observation.resultEvent).toBeNull();

    const result = run(observation, { exitCode: null, signal: 'SIGKILL' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('crash');
    expect(result.terminalReason).toContain('no result event');
    expect(result.structured).toBeNull();
  });

  it('a structured_output rejected by the validator yields "schema" and keeps the raw payload', () => {
    const bad = { outcome: 'maybe' };
    const result = run(
      observe([
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          structured_output: bad,
          total_cost_usd: 0.01,
        }),
      ]),
      {
        validateStructured: (value): { ok: false; issues: string[] } => ({
          ok: false,
          issues: [`outcome must be ok|escalate, got ${JSON.stringify((value as { outcome: string }).outcome)}`],
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('schema');
    expect(result.structured).toBeNull();
    // Preserved for the log so a human can see what the agent actually said
    // (spec §9.1: "agent's raw output preserved in the log").
    expect(result.rawStructured).toEqual(bad);
    expect(result.schemaIssues?.[0]).toContain('outcome must be');
  });

  it('a result event with no structured_output at all is a schema failure', () => {
    const result = run(
      observe([JSON.stringify({ type: 'result', subtype: 'success', is_error: false })]),
    );
    expect(result.failure).toBe('schema');
    expect(result.schemaIssues?.[0]).toContain('no structured_output');
  });

  it('a non-JSON line is recorded and skipped, not fatal', () => {
    const collector = new StreamCollector();
    expect(collector.onLine('npm WARN deprecated something')).toBeNull();
    expect(collector.onLine('[1, 2, 3]')).toBeNull();
    collector.onLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { outcome: 'ok' } }),
    );

    const observation = collector.observation();
    expect(observation.malformedLines).toEqual(['npm WARN deprecated something', '[1, 2, 3]']);
    expect(observation.lineCount).toBe(3);

    const result = run(observation);
    expect(result.ok).toBe(true);
    expect(result.structured).toEqual({ outcome: 'ok' });
  });

  it('a timeout beats anything the stream said', () => {
    const result = run(observe(REAL_LINES), { timedOut: true, exitCode: null, signal: 'SIGTERM' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('timeout');
    expect(result.structured).toBeNull();
  });

  it('a caller abort is reported as "aborted", distinct from a timeout and a crash', () => {
    // The two mean opposite things about whose fault the run was: `timeout` is
    // the agent running over `agent_timeout`, `aborted` is the orchestrator
    // shutting down. Phase 7a needs to tell them apart to decide whether the
    // attempt counter moves.
    const result = run(observe([]), { aborted: true, exitCode: null, signal: 'SIGTERM' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('aborted');
    expect(result.terminalReason).toContain('aborted by caller');
  });

  it('a timeout that is followed by an abort still reports as a timeout', () => {
    const result = run(observe([]), { timedOut: true, aborted: true, exitCode: null });
    expect(result.failure).toBe('timeout');
  });

  it('a clean result event with a non-zero exit is a crash, not a success', () => {
    const result = run(observe(REAL_LINES), { exitCode: 137, stderrTail: 'Killed' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('crash');
    expect(result.terminalReason).toContain('137');
  });

  it('an empty stream is a crash', () => {
    const result = run(observe([]), { exitCode: 1, stderrTail: 'claude: command not found' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('crash');
    expect(result.terminalReason).toContain('command not found');
  });
});

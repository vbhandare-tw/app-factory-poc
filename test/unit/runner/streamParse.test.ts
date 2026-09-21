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

/**
 * How many times the agent called `StructuredOutput` (plan Phase 7b debt).
 *
 * Phase 7b established that the binding constraint on agent output is not the
 * model's token ceiling but the CLI's `StructuredOutput` delivery, and that it
 * fails by mangling parameter boundaries: the model emits a correct payload,
 * the CLI glues one field onto the end of the previous one, and the call is
 * rejected for a property the agent actually sent. The CLI then retries, and
 * the orchestrator sees nothing — one attempt charged, retried, no loud break.
 *
 * A count above 1 is the only early warning that a role's payload is
 * approaching the size at which delivery starts failing. It has to come from
 * the live stream rather than from re-reading the transcript, because the
 * transcript is the record and `MockRunner` has no real one to read.
 *
 * The case that matters most is the FAILED one. `terminalReason:
 * "structured_output_retry_exhausted"` arrives as `is_error: true`, which
 * `interpretRun` answers at check 4 and returns from long before the success
 * path. A count that only appeared on `ok: true` would be present on every
 * healthy run and missing on exactly the runs it exists to describe.
 */
describe('interpretRun counts StructuredOutput deliveries', () => {
  /** One assistant turn that calls a tool, in the shape the CLI streams. */
  function toolCall(name: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_${name}`, name, input: { outcome: 'ok' }, ...extra }],
      },
    });
  }

  function successResult(structured: unknown = { outcome: 'ok' }): string {
    return JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: structured,
      total_cost_usd: 0.01,
    });
  }

  it('the recorded real run delivered its payload in exactly one call', () => {
    // The healthy case, measured against a real CLI stream rather than an
    // invented one: one delivery, accepted first time.
    const observation = observe(REAL_LINES);
    expect(observation.structuredOutputCalls).toBe(1);

    const result = run(observation);
    expect(result.ok).toBe(true);
    expect(result.structuredOutputCalls).toBe(1);
  });

  it('several deliveries in one run are all counted — this is the signal', () => {
    const result = run(
      observe([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        toolCall('StructuredOutput'),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }),
        toolCall('StructuredOutput'),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }),
        toolCall('StructuredOutput'),
        successResult(),
      ]),
    );

    expect(result.ok).toBe(true);
    // Two rejected deliveries before the accepted one. The run succeeded and
    // cost one attempt, which is exactly why nothing else reports this.
    expect(result.structuredOutputCalls).toBe(3);
  });

  it('a run with no StructuredOutput call at all reports zero, not one', () => {
    const result = run(
      observe([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        toolCall('Bash'),
        successResult(),
      ]),
    );
    expect(result.structuredOutputCalls).toBe(0);
  });

  it('a run that exhausted its delivery retries still reports its count', () => {
    // THE case this whole signal exists for. `is_error: true` is answered at
    // check 4 of `interpretRun` and returns immediately, so a count computed
    // on the success path would be missing here — present for every healthy
    // run, absent for every run that actually ran out of retries.
    //
    // The result event is transcribed field by field from a real one:
    // `.factory-test-repos/pipeline-real-logs/run-2/evaluate/FEAT-EVALUATE-1-dl.log`
    // (`run-3`'s is identical in every field asserted here). It carries BOTH
    // `terminal_reason` and `subtype`, and `readResultFields` reads
    // `terminal_reason` first — so what the orchestrator actually sees is
    // `structured_output_retry_exhausted`, which is what the paid test
    // `pipeline-real.test.ts` has said all along.
    //
    // Five `StructuredOutput` calls, each answered with
    // `root: must have required property 'tickets'` for a payload that
    // contained them. Five is the cap, and the event says so itself in
    // `errors`. `structured_output` is genuinely absent — not null, absent —
    // which is why nothing here sets it.
    const result = run(
      observe([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        toolCall('StructuredOutput'),
        toolCall('StructuredOutput'),
        toolCall('StructuredOutput'),
        toolCall('StructuredOutput'),
        toolCall('StructuredOutput'),
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          terminal_reason: 'structured_output_retry_exhausted',
          is_error: true,
          stop_reason: 'tool_use',
          num_turns: 8,
          duration_ms: 201707,
          total_cost_usd: 0.5587732,
          session_id: '2068583d-4b7a-46b0-9922-a0bf6351dc89',
          permission_denials: [],
          errors: ['Failed to provide valid structured output after 5 attempts'],
        }),
      ]),
      { exitCode: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('api_error');
    expect(result.terminalReason).toBe('structured_output_retry_exhausted');
    expect(result.costUsd).toBeCloseTo(0.5587732, 6);
    expect(result.durationMs).toBe(201707);
    expect(result.structuredOutputCalls).toBe(5);
  });

  it('falls back to subtype only when terminal_reason is absent — a defensive case, not a recorded one', () => {
    // **Synthetic on purpose, and labelled so.** No recorded terminal event
    // omits `terminal_reason`; every one of the twenty preserved Phase 7b
    // transcripts carries it. This covers `readResultFields`'s fallback chain
    // for a shape the CLI has not been observed to produce, so that a future
    // release which drops the field degrades to the subtype rather than to
    // `'unknown'`. It is NOT evidence about the exhausted-retries failure —
    // that event carries `terminal_reason` and never reaches this branch.
    const result = run(
      observe([
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
        }),
      ]),
      { exitCode: 1 },
    );
    expect(result.terminalReason).toBe('error_max_structured_output_retries');
  });

  it('a truncated stream with no result event reports however many it saw', () => {
    const result = run(
      observe([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        toolCall('StructuredOutput'),
        toolCall('StructuredOutput'),
      ]),
      { exitCode: null, signal: 'SIGKILL' },
    );

    expect(result.failure).toBe('crash');
    expect(result.structuredOutputCalls).toBe(2);
  });

  it('a timeout and a caller abort both still carry the count', () => {
    // Every exit path in `interpretRun` spreads `...base`, and these two are
    // the earliest of the six. A count bolted onto individual returns instead
    // of computed into `base` would be missing here.
    const lines = [toolCall('StructuredOutput'), toolCall('StructuredOutput')];

    const timedOut = run(observe(lines), { timedOut: true, exitCode: null, signal: 'SIGTERM' });
    expect(timedOut.failure).toBe('timeout');
    expect(timedOut.structuredOutputCalls).toBe(2);

    const aborted = run(observe(lines), { aborted: true, exitCode: null, signal: 'SIGTERM' });
    expect(aborted.failure).toBe('aborted');
    expect(aborted.structuredOutputCalls).toBe(2);
  });

  it('a clean result event with a non-zero exit, and a rejected payload, both carry it', () => {
    // Checks 5 and 6. Between them and the three above, all six exits are
    // covered — the success path is the seventh.
    const lines = [toolCall('StructuredOutput'), successResult()];

    const crashed = run(observe(lines), { exitCode: 137, stderrTail: 'Killed' });
    expect(crashed.failure).toBe('crash');
    expect(crashed.structuredOutputCalls).toBe(1);

    const rejected = run(observe(lines), {
      validateStructured: (): { ok: false; issues: string[] } => ({ ok: false, issues: ['nope'] }),
    });
    expect(rejected.failure).toBe('schema');
    expect(rejected.structuredOutputCalls).toBe(1);
  });

  it('counts calls the same way `pipeline-real.test.ts` does, on any event carrying message.content', () => {
    // The paid test's `payloadSizes()` reads `event.message?.content` without
    // filtering on `event.type`, and the production number must not be able to
    // disagree with the number that test prints.
    const observation = observe([
      JSON.stringify({
        type: 'stream_event',
        message: { content: [{ type: 'tool_use', name: 'StructuredOutput' }] },
      }),
    ]);
    expect(observation.structuredOutputCalls).toBe(1);
  });

  it('a shape the parser did not expect is skipped, never thrown on', () => {
    // Everything here has been seen or is one CLI release away: content as a
    // string, blocks that are null or primitives, a message that is not an
    // object at all, a tool_use with no name, a name that is not a string.
    const collector = new StreamCollector();
    const odd = [
      JSON.stringify({ type: 'assistant', message: { content: 'not an array' } }),
      JSON.stringify({ type: 'assistant', message: { content: [null, 'text', 7, []] } }),
      JSON.stringify({ type: 'assistant', message: 'not an object' }),
      JSON.stringify({ type: 'assistant', message: null }),
      JSON.stringify({ type: 'assistant', message: ['not', 'an', 'object'] }),
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 42 }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', name: 'StructuredOutput' }] } }),
    ];
    for (const line of odd) expect(() => collector.onLine(line)).not.toThrow();

    expect(collector.observation().structuredOutputCalls).toBe(0);
    expect(collector.observation().malformedLines).toEqual([]);

    // ...and a real call still counts after all of that.
    collector.onLine(toolCall('StructuredOutput'));
    expect(collector.observation().structuredOutputCalls).toBe(1);
  });
});

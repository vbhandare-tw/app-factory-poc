/**
 * A stand-in for the `claude` executable.
 *
 * It exists so `test/integration/runner-stub.test.ts` can prove argv
 * construction, live streaming, the failure taxonomy and the kill path without
 * spending money or needing a network. It is **only as good as its last
 * calibration against reality** — the JSONL it emits is a recording, and a CLI
 * upgrade that changes the stream shape will not fail this stub. That is what
 * `test/integration/isolation.test.ts` and the fixture-drift check in
 * `runner-stub.test.ts` are for.
 *
 * Behaviour is chosen by `STUB_CLAUDE_MODE`, and every invocation appends a
 * record of its argv, cwd and stdin kind to `STUB_CLAUDE_RECORD`.
 */
import { appendFileSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.env.STUB_CLAUDE_MODE ?? 'success';
const recordPath = process.env.STUB_CLAUDE_RECORD;
const fixturePath = process.env.STUB_CLAUDE_FIXTURE;

function stdinKind() {
  try {
    const stat = fstatSync(0);
    if (stat.isCharacterDevice()) return 'char'; // /dev/null — what 'ignore' gives
    if (stat.isFIFO()) return 'pipe';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'closed';
  }
}

if (recordPath !== undefined) {
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      stdin: stdinKind(),
      gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL ?? null,
      pid: process.pid,
    })}\n`,
    'utf8',
  );
}

const fixtureLines =
  fixturePath === undefined
    ? []
    : readFileSync(fixturePath, 'utf8').split('\n').filter((line) => line.length > 0);

function emit(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Never `process.exit()`.
 *
 * `process.stdout` is a pipe here, so writes are asynchronous and `exit()`
 * discards whatever has not drained — which silently truncated the stream and
 * made the "success" case look like a crash. Setting `exitCode` lets Node flush
 * and then leave on its own.
 */
function finish(code) {
  process.exitCode = code;
}

/**
 * One `StructuredOutput` tool call, in the shape the CLI streams it.
 *
 * Emitted by every mode that goes on to deliver a payload, because a real run
 * that returns `structured_output` always made at least one of these — and
 * `AgentRunResult.structuredOutputCalls` counts them. A stub that skipped the
 * call while still producing the payload would let the real runner report 0 on
 * a healthy run, which is the one number it must never report.
 */
function deliveryLine(input = { outcome: 'ok', note: 'from the stub' }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_stub', name: 'StructuredOutput', input }],
    },
  });
}

function resultLine(overrides) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    duration_ms: 4242,
    session_id: 'stub-session',
    terminal_reason: 'completed',
    total_cost_usd: 0.0123,
    permission_denials: [],
    structured_output: { outcome: 'ok', note: 'from the stub' },
    ...overrides,
  });
}

switch (mode) {
  case 'success': {
    emit(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd() }));
    for (const line of fixtureLines) emit(line);
    // Only when no recorded conversation was supplied. `real-run-2026-09-01.jsonl`
    // already contains a real `StructuredOutput` call, and emitting another on
    // top of it would make every "healthy run" driven from that fixture into a
    // two-delivery run — a retried delivery, which is the one thing a healthy
    // run is not.
    if (fixtureLines.length === 0) emit(deliveryLine());
    emit(resultLine({}));
    finish(0);
    break;
  }

  case 'malformed_line': {
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit('npm WARN this is not JSON at all');
    emit(deliveryLine());
    emit(resultLine({}));
    finish(0);
    break;
  }

  case 'api_error': {
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit(
      resultLine({
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'error',
        structured_output: null,
      }),
    );
    finish(1);
    break;
  }

  case 'truncated': {
    // A stream cut off mid-object, exactly as a SIGKILL would leave it.
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te');
    finish(1);
    break;
  }

  case 'schema_violation': {
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit(deliveryLine({ outcome: 'definitely-not-valid' }));
    emit(resultLine({ structured_output: { outcome: 'definitely-not-valid' } }));
    finish(0);
    break;
  }

  case 'stderr_noise': {
    process.stderr.write('warning: something looked odd\n');
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit(deliveryLine());
    emit(resultLine({}));
    finish(0);
    break;
  }

  case 'retried_delivery': {
    // The Phase 7b failure, transcribed from a real one rather than imagined:
    // `.factory-test-repos/pipeline-real-logs/run-2/evaluate/FEAT-EVALUATE-1-dl.log`.
    // The CLI mangles a parameter boundary, rejects the agent's own payload for
    // a property it did send (`root: must have required property 'tickets'`),
    // retries, and gives up at the cap.
    //
    // **Five calls, not an arbitrary number: five is the cap.** Both preserved
    // runs that reached it made exactly five, one further run succeeded on its
    // fifth and final permitted try, and the event says so itself in `errors`:
    // "Failed to provide valid structured output after 5 attempts".
    //
    // **Every field below is taken verbatim from that recording** (`run-3`'s is
    // identical in all of them but the ids, costs and durations):
    //
    //   type, subtype, terminal_reason, is_error, stop_reason, num_turns,
    //   duration_ms, total_cost_usd, session_id, permission_denials, errors
    //
    // **Deliberately omitted**, because the real event does not have them:
    // `structured_output` — genuinely absent, not null, which is why it is
    // dropped here rather than set (an `undefined` value disappears through
    // `JSON.stringify`).
    //
    // **Also present in the recording and left out as noise**, because nothing
    // in the runner reads them: `usage`, `modelUsage`, `duration_api_ms`,
    // `uuid`, `fast_mode_state`, `fast_mode_disabled_reason`.
    //
    // Note it carries **both** `terminal_reason` and `subtype`.
    // `readResultFields` reads `terminal_reason` first, so what the
    // orchestrator sees is `structured_output_retry_exhausted` — which is what
    // `pipeline-real.test.ts` has asserted since it was written.
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      emit(deliveryLine());
      emit(
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_stub',
                is_error: true,
                content:
                  "Output does not match required schema: root: must have required property 'tickets'",
              },
            ],
          },
        }),
      );
    }
    emit(
      resultLine({
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
        structured_output: undefined,
      }),
    );
    finish(1);
    break;
  }

  case 'hang': {
    // Emits a little, spawns a grandchild, then never exits. Drives the
    // timeout path and the orphan-process assertion.
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    const grandchild = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000)'],
      { stdio: 'ignore' },
    );
    if (process.env.STUB_CLAUDE_PIDFILE !== undefined) {
      writeFileSync(
        process.env.STUB_CLAUDE_PIDFILE,
        JSON.stringify({ stub: process.pid, grandchild: grandchild.pid }),
        'utf8',
      );
    }
    // Ignore SIGTERM so the SIGKILL escalation is what actually ends this.
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 60000);
    break;
  }

  default: {
    process.stderr.write(`stubClaude: unknown STUB_CLAUDE_MODE ${mode}\n`);
    finish(64);
  }
}

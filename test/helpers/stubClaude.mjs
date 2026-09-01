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
    emit(resultLine({}));
    finish(0);
    break;
  }

  case 'malformed_line': {
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit('npm WARN this is not JSON at all');
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
    emit(resultLine({ structured_output: { outcome: 'definitely-not-valid' } }));
    finish(0);
    break;
  }

  case 'stderr_noise': {
    process.stderr.write('warning: something looked odd\n');
    emit(JSON.stringify({ type: 'system', subtype: 'init' }));
    emit(resultLine({}));
    finish(0);
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

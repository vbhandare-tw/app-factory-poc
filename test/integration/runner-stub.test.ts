/**
 * `ClaudeCodeRunner` against a stub `claude` on `PATH` (plan Phase 5).
 *
 * Proves argv construction, live streaming, the failure taxonomy and the
 * kill path — without spending money or needing a network.
 *
 * What it does NOT prove, and cannot: that the sandbox JSON we hand the CLI
 * fences anything. A stub accepts `--settings` and ignores it. That proof lives
 * in `isolation.test.ts` and nowhere else.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { MemoryEventLog } from '../../src/log/events.js';
import { MemoryRunRegistry } from '../../src/log/runs.js';
import { ClaudeCodeRunner } from '../../src/runner/claudeCode.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { REAL_STREAM_FIXTURE, testProfile, testSandboxConfig, testSpec } from '../helpers/runnerFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../helpers/toyRepo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.resolve(HERE, '..', 'helpers', 'stubClaude.mjs');

afterAll(() => cleanupAllScratchDirs());

interface Harness {
  readonly dir: string;
  readonly vault: VaultPaths;
  readonly binDir: string;
  readonly recordPath: string;
  readonly pidFile: string;
  env(mode: string): NodeJS.ProcessEnv;
  records(): { argv: string[]; cwd: string; stdin: string; gitConfigGlobal: string | null; pid: number }[];
}

/** A scratch directory holding a `claude` shim on PATH plus a vault for logs. */
function harness(): Harness {
  const dir = scratchDir('runner-stub-');
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // A real executable named `claude`, so the runner resolves it by bare name
  // off PATH exactly as it will in production.
  const shim = path.join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${STUB_SOURCE}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);

  const recordPath = path.join(dir, 'invocations.jsonl');
  const pidFile = path.join(dir, 'pids.json');

  return {
    dir,
    vault: new VaultPaths(path.join(dir, 'vault')),
    binDir,
    recordPath,
    pidFile,
    env(mode: string): NodeJS.ProcessEnv {
      return {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        STUB_CLAUDE_MODE: mode,
        STUB_CLAUDE_RECORD: recordPath,
        STUB_CLAUDE_PIDFILE: pidFile,
        STUB_CLAUDE_FIXTURE: REAL_STREAM_FIXTURE,
      };
    },
    records() {
      if (!existsSync(recordPath)) return [];
      return readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

function runnerFor(h: Harness, mode: string, extra: Record<string, unknown> = {}): {
  runner: ClaudeCodeRunner;
  events: MemoryEventLog;
  runs: MemoryRunRegistry;
} {
  const events = new MemoryEventLog();
  const runs = new MemoryRunRegistry();
  const runner = new ClaudeCodeRunner({
    config: testSandboxConfig(),
    repoRoot: path.join(h.dir, 'repo'),
    env: h.env(mode),
    events,
    runs,
    ...extra,
  });
  return { runner, events, runs };
}

function specFor(h: Harness, overrides: Record<string, unknown> = {}) {
  return testSpec({
    cwd: h.dir,
    transcriptPath: h.vault.logPath('demo', 'FEAT-DEMO-T001', 1, 'developer'),
    ...overrides,
  });
}

describe('ClaudeCodeRunner against a stub claude', () => {
  it('invokes the CLI with the verified flag shape, from the run cwd, with stdin closed', async () => {
    const h = harness();
    const { runner, events, runs } = runnerFor(h, 'success');
    const spec = specFor(h);

    const result = await runner.run(spec, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.structured).toEqual({ outcome: 'ok', note: 'from the stub' });
    expect(result.costUsd).toBe(0.0123);

    const [record] = h.records();
    expect(record).toBeDefined();
    expect(record!.argv).toContain('--safe-mode');
    expect(record!.argv).toContain('--verbose');
    expect(record!.argv).not.toContain('--bare');
    expect(record!.argv[record!.argv.indexOf('--output-format') + 1]).toBe('stream-json');

    // spec §4.4: stdin must be 'ignore' or /dev/null, otherwise the CLI stalls
    // three seconds waiting for piped input. /dev/null is a character device.
    expect(record!.stdin).toBe('char');
    // The child runs in the worktree — there is no --cwd flag (spec §4.1).
    expect(path.resolve(record!.cwd)).toBe(path.resolve(h.dir));
    // Read-only git needs this or every git command fails EPERM on ~/.gitconfig.
    expect(record!.gitConfigGlobal).toBe('/dev/null');

    // The sandbox settings reach the CLI as one JSON argument.
    const settings = JSON.parse(record!.argv[record!.argv.indexOf('--settings') + 1] ?? 'null');
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.filesystem.denyWrite).toContain(
      path.join(h.dir, 'repo', '.git', 'hooks'),
    );

    expect(runs.registered).toHaveLength(1);
    expect(runs.live.size).toBe(0);
    expect(events.ofType('run_started')).toHaveLength(1);
    expect(events.ofType('run_finished')[0]?.ok).toBe(true);
  });

  it('writes every stream line to the transcript as JSONL', async () => {
    const h = harness();
    const { runner } = runnerFor(h, 'success');
    const spec = specFor(h);

    await runner.run(spec, new AbortController().signal);

    const lines = readFileSync(spec.transcriptPath, 'utf8').split('\n').filter(Boolean);
    // init + the whole recorded fixture + the stub's own result event.
    expect(lines.length).toBeGreaterThan(17);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[lines.length - 1] ?? '').type).toBe('result');
  });

  it('maps is_error onto failure "api_error"', async () => {
    const h = harness();
    const { runner } = runnerFor(h, 'api_error');
    const result = await runner.run(specFor(h), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('api_error');
  });

  it('maps a truncated stream onto failure "crash"', async () => {
    const h = harness();
    const { runner } = runnerFor(h, 'truncated');
    const result = await runner.run(specFor(h), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('crash');
  });

  it('maps a rejected payload onto failure "schema" and keeps the raw output', async () => {
    const h = harness();
    const { runner } = runnerFor(h, 'schema_violation');
    const result = await runner.run(
      specFor(h, {
        validateStructured: (value: unknown) =>
          (value as { outcome: string }).outcome === 'ok'
            ? { ok: true as const }
            : { ok: false as const, issues: ['outcome must be ok'] },
      }),
      new AbortController().signal,
    );
    expect(result.failure).toBe('schema');
    expect(result.rawStructured).toEqual({ outcome: 'definitely-not-valid' });
  });

  it('skips a non-JSON line, logs it, and still succeeds', async () => {
    const h = harness();
    const { runner, events } = runnerFor(h, 'malformed_line');
    const result = await runner.run(specFor(h), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(events.ofType('run_stream_malformed')[0]?.line).toContain('not JSON');
  });

  it('captures stderr into the transcript without breaking JSONL', async () => {
    const h = harness();
    const { runner, events } = runnerFor(h, 'stderr_noise');
    const spec = specFor(h);
    const result = await runner.run(spec, new AbortController().signal);

    expect(result.ok).toBe(true);
    const lines = readFileSync(spec.transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.some((line) => JSON.parse(line).type === 'stderr')).toBe(true);
    expect(events.ofType('run_stderr')[0]?.text).toContain('looked odd');
  });

  it('returns failure "crash" when the executable does not exist, instead of throwing', async () => {
    const h = harness();
    const runner = new ClaudeCodeRunner({
      config: testSandboxConfig(),
      repoRoot: path.join(h.dir, 'repo'),
      command: 'definitely-not-a-real-binary-xyz',
      env: h.env('success'),
    });
    const result = await runner.run(specFor(h), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('crash');
  });

  it('refuses to run at all when the fence cannot be built, leaving no transcript', async () => {
    const h = harness();
    // A repo-touching profile with no repoRoot. The alternative to throwing is
    // a perfectly normal run with no .git fence.
    const runner = new ClaudeCodeRunner({ config: testSandboxConfig(), env: h.env('success') });
    const spec = specFor(h, {
      transcriptPath: h.vault.logPath('demo', 'FEAT-DEMO-T900', 1, 'developer'),
    });
    await expect(runner.run(spec, new AbortController().signal)).rejects.toThrow(
      /\.git write fence/,
    );
    expect(existsSync(spec.transcriptPath)).toBe(false);
    expect(h.records()).toHaveLength(0);
  });
});

describe('timeout and orphan processes', () => {
  it('kills the whole process group on timeout and leaves no orphan behind', async () => {
    const h = harness();
    const { runner, events, runs } = runnerFor(h, 'hang', { killGraceMs: 500 });
    const spec = specFor(h, {
      profile: testProfile({ timeoutMs: 1_500 }),
      transcriptPath: h.vault.logPath('demo', 'FEAT-DEMO-T002', 1, 'developer'),
    });

    const result = await runner.run(spec, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('timeout');
    // SIGTERM first, then SIGKILL after the grace — the stub ignores SIGTERM,
    // so a runner that stopped at SIGTERM would hang here forever.
    const kills = events.ofType('run_killed').map((e) => e.signal);
    expect(kills).toContain('SIGTERM');
    expect(kills).toContain('SIGKILL');

    const pids = JSON.parse(readFileSync(h.pidFile, 'utf8')) as {
      stub: number;
      grandchild: number;
    };
    await waitForDeath(pids.stub);
    await waitForDeath(pids.grandchild);

    expect(isAlive(pids.stub), `stub pid ${pids.stub} survived the timeout`).toBe(false);
    expect(
      isAlive(pids.grandchild),
      `grandchild pid ${pids.grandchild} survived — child.kill() only reaps the CLI, ` +
        'the agent Bash tool spawns its own children',
    ).toBe(false);

    // The .runs entry must not outlive the run it describes.
    expect(runs.live.size).toBe(0);
    expect(runs.completed).toEqual([spec.runId]);
  });

  it('honours an external AbortSignal the same way', async () => {
    const h = harness();
    const { runner } = runnerFor(h, 'hang', { killGraceMs: 500 });
    const controller = new AbortController();
    const spec = specFor(h, {
      profile: testProfile({ timeoutMs: 60_000 }),
      transcriptPath: h.vault.logPath('demo', 'FEAT-DEMO-T003', 1, 'developer'),
    });

    setTimeout(() => controller.abort(), 300);
    const result = await runner.run(spec, controller.signal);

    expect(result.ok).toBe(false);
    // An external abort is an orchestrator cancellation, not an agent failure —
    // it is NOT 'timeout' (the agent did not run over its budget) and NOT
    // 'crash' (nothing went wrong). See the note on `AgentFailure`, and
    // `runner-parity.test.ts` for what keeps the mock saying the same thing.
    expect(result.failure).toBe('aborted');
    const pids = JSON.parse(readFileSync(h.pidFile, 'utf8')) as { stub: number; grandchild: number };
    await waitForDeath(pids.stub);
    await waitForDeath(pids.grandchild);
    expect(isAlive(pids.stub)).toBe(false);
    expect(isAlive(pids.grandchild)).toBe(false);
  });
});

describe('stub fixture calibration', () => {
  it('the recorded fixture still parses as the shape the parser expects', () => {
    // The stub is only as good as this recording. `npm run test:isolation`
    // captures a fresh real stream; if the CLI ever stops emitting a terminal
    // `result` with these fields, this is where it surfaces.
    const lines = readFileSync(REAL_STREAM_FIXTURE, 'utf8').split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = events[events.length - 1];

    expect(last?.['type']).toBe('result');
    for (const key of [
      'is_error',
      'structured_output',
      'total_cost_usd',
      'num_turns',
      'duration_ms',
      'session_id',
      'terminal_reason',
      'permission_denials',
    ]) {
      expect(last, `result event lost the ${key} field`).toHaveProperty(key);
    }
    expect(new Set(events.map((e) => e['type']))).toEqual(
      new Set(['system', 'assistant', 'user', 'rate_limit_event', 'result']),
    );
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Give the OS a moment to reap; SIGKILL is not synchronous. */
async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

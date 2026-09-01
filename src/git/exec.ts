/**
 * Running a child process and capturing everything about how it ended.
 *
 * The orchestrator's own subprocesses — `git`, and the target repo's
 * `setup_command` — run **outside** the sandbox, with the orchestrator's full
 * permissions and its network. That is deliberate (plan resolution A3: a
 * sandboxed agent has no network, so it can never install its own
 * dependencies), and it is the one place in the system where the target repo's
 * own package scripts execute unfenced. Everything here exists to make that
 * boundary survivable:
 *
 * - **Every call has a deadline.** A `setup_command` that hangs would otherwise
 *   hang the whole factory with no diagnosis. `SIGTERM`, then `SIGKILL` after a
 *   grace period, and `timedOut` is reported separately from the exit code so a
 *   caller can tell "your install script is broken" from "your install script
 *   never finishes".
 * - **Output is captured and capped**, never inherited. The tail is what goes
 *   into a `needs_human` note, and an unbounded install log would push
 *   everything else out of the frontmatter.
 * - **Nothing throws on a non-zero exit.** The exit code is data. A caller that
 *   wants an exception says so.
 */
import { spawn } from 'node:child_process';

/** How much of each stream is kept. Enough to see a stack trace, not a whole install log. */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/** How long a killed process gets to die politely before `SIGKILL`. */
export const KILL_GRACE_MS = 5_000;

export interface ExecResult {
  /** The command as a human would type it, for error messages. */
  readonly command: string;
  readonly cwd: string;
  /** `null` when the process was killed by a signal. */
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the deadline fired. Distinct from a non-zero exit. */
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Spawn itself failed — the binary is missing, the cwd does not exist. */
  readonly spawnError: string | null;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Run through a shell. Needed for `setup_command`, which is one config string. */
  readonly shell?: boolean;
  readonly maxOutputChars?: number;
}

/**
 * The seam every caller in `src/git/**` takes its process execution through.
 *
 * A type rather than a hard import so a test can drive a failing
 * `setup_command` without inventing a script that fails for a plausible
 * reason — and, more importantly, so the failure it injects is *exactly* the
 * shape a real failure has.
 */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export function execCapture(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const command = options.shell === true ? file : [file, ...args].join(' ');
  const startedMs = Date.now();

  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let softTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: Omit<ExecResult, 'command' | 'cwd' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      if (softTimer !== undefined) clearTimeout(softTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      resolve({ ...result, command, cwd: options.cwd, durationMs: Date.now() - startedMs });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString('utf8'), maxChars);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString('utf8'), maxChars);
    });

    child.on('error', (error: Error) => {
      finish({
        status: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnError: error.message,
      });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      finish({ status: code, signal, stdout, stderr, timedOut, spawnError: null });
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      softTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // A process that ignores SIGTERM must not keep the factory waiting.
        hardTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        hardTimer.unref?.();
      }, options.timeoutMs);
      softTimer.unref?.();
    }
  });
}

/** Keep the end of a stream: the failure is at the bottom, not the top. */
function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** `git worktree add ...` → one line a human can paste back. */
export function describeExec(result: ExecResult): string {
  const how = result.spawnError !== null
    ? `could not start (${result.spawnError})`
    : result.timedOut
      ? `timed out after ${result.durationMs}ms`
      : result.signal !== null
        ? `died on ${result.signal}`
        : `exited ${String(result.status)}`;
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return `\`${result.command}\` in ${result.cwd} ${how}${output === '' ? '' : `\n${output}`}`;
}

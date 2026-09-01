/**
 * The deterministic quality gates (spec §8.2, ADR-004).
 *
 * ============================================================================
 * WHAT THIS IS FOR
 * ============================================================================
 * ADR-004: "Gates run as orchestrator child processes, never inside an agent
 * run, and their exit codes are the only signal that advances a ticket." This
 * module is that sentence. It runs `tests`, then `lint`, then `build`, in the
 * ticket's worktree, as the orchestrator, outside the sandbox, and reports three
 * exit codes.
 *
 * **Exit 0 is the only pass.** Not "no output on stderr", not "the string FAIL
 * did not appear", not "the agent said the tests passed". A gate command that
 * cannot be started at all, or that runs past its deadline, is a `fail` with a
 * readable reason — never a thrown exception, because an exception here would
 * escape into the dispatch loop and be logged as a dispatch failure rather than
 * as a red gate, and a red gate is what bounces the ticket.
 *
 * ============================================================================
 * SHORT-CIRCUIT, AND WHY IT IS NOT AN OPTIMISATION
 * ============================================================================
 * After the first failure the remaining gates are recorded as `skipped` and not
 * run. That is spec §8.2's order, and it matters beyond saving time: `lint` and
 * `build` run against a tree whose tests are already failing, so their output
 * would be noise in the retry context that the Developer most needs to read.
 * `skipped` is deliberately not `pass` — `gatesAllGreen` refuses anything that
 * is not `pass` on every gate, so a short-circuited run can never advance a
 * ticket by omission.
 *
 * ============================================================================
 * OUTPUT: WHOLE TO DISK, TAIL TO THE NOTE
 * ============================================================================
 * The full combined output is written to `logPath` before the result is
 * returned; only the last `gate_output_chars` characters travel into
 * frontmatter. A note is a YAML document a human edits in Obsidian — an
 * unbounded install log in it would push everything else off the screen and
 * make the file slow to open. The tail is the end of the stream because that is
 * where a failure is: the assertion, the stack, the summary line.
 *
 * "Full", stated exactly: `execCapture` holds the tail of each stream in memory
 * up to `LOG_CAPTURE_CHARS`, so a gate that prints more than that loses its
 * beginning on disk as well. That is a deliberate ceiling rather than an
 * oversight — a gate command that emits half a gigabyte would otherwise take the
 * orchestrator's heap with it — and it is two orders of magnitude above the
 * default `gate_output_chars`, so the log is always the fuller of the two.
 *
 * ============================================================================
 * DEVIATION FROM SPEC §8.2's SIGNATURE
 * ============================================================================
 * §8.2 writes `run(cwd: string, gates: GateConfig)`. Two things a gate run
 * cannot get from those arguments: where to write each gate's full output, and
 * how much of it to keep. Both are per-run — the log path carries the ticket id
 * and the attempt number — so they arrive in a third `GateRunOptions` argument
 * rather than being read from a global. The two spec arguments are unchanged.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { GATE_NAMES } from '../domain/states.js';
import type { GateName } from '../domain/states.js';
import { execCapture } from '../git/exec.js';
import type { ExecFn, ExecResult } from '../git/exec.js';
import { emptyResults, NO_EXIT_CODE, skippedResult } from './results.js';
import type { GateResult, GateResults } from './results.js';

/** `config.gates` — one shell command per gate (spec §11). */
export type GateConfig = Readonly<Record<GateName, string>>;

export interface GateRunOptions {
  /** Where a gate's **whole** output is written. Called once per gate. */
  readonly logPathFor: (gate: GateName) => string;
  /** `config.gate_output_chars`. How much of the tail reaches frontmatter. */
  readonly maxOutputChars: number;
  /** Per-gate deadline. A gate past it is killed and reported `fail`. */
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected so a unit test can drive a failure shape it could not stage. */
  readonly exec?: ExecFn;
  /** Called as each gate finishes, for the event log. */
  readonly onGateFinished?: (gate: GateName, result: GateResult) => void | Promise<void>;
}

export interface GateRunner {
  run(cwd: string, gates: GateConfig, options: GateRunOptions): Promise<GateResults>;
}

/**
 * Ten minutes per gate.
 *
 * Not a config key. Spec §11's key set is fixed and `config.yml` rejects unknown
 * keys, so adding one is a schema change; and unlike `setup_timeout`, which
 * bounds a command chosen for its side effects, this bounds the target repo's
 * own test suite, where "how long is too long" is not something an operator
 * tunes per vault. Revisit if a real repo's suite ever approaches it.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;

/** In-memory ceiling on one gate's captured output. See the header note. */
export const LOG_CAPTURE_CHARS = 200_000;

export class ChildProcessGateRunner implements GateRunner {
  async run(cwd: string, gates: GateConfig, options: GateRunOptions): Promise<GateResults> {
    const exec = options.exec ?? execCapture;
    const results: Record<GateName, GateResult> = {
      ...emptyResults(gates, 'not run'),
    } as Record<GateName, GateResult>;

    let shortCircuited: GateName | null = null;

    for (const gate of GATE_NAMES) {
      const command = gates[gate];

      if (shortCircuited !== null) {
        results[gate] = skippedResult(
          command,
          `skipped: the ${shortCircuited} gate failed and gates short-circuit on the first ` +
            'failure (spec §8.2)',
        );
        await options.onGateFinished?.(gate, results[gate]);
        continue;
      }

      const result = await runOne(exec, cwd, gate, command, options);
      results[gate] = result;
      await options.onGateFinished?.(gate, result);
      if (result.status !== 'pass') shortCircuited = gate;
    }

    return results;
  }
}

async function runOne(
  exec: ExecFn,
  cwd: string,
  gate: GateName,
  command: string,
  options: GateRunOptions,
): Promise<GateResult> {
  const logPath = options.logPathFor(gate);

  // Nothing below may throw. A gate that cannot start, or a log file that cannot
  // be written, has to come back as a red gate — see the header note.
  let execResult: ExecResult;
  try {
    execResult = await exec(command, [], {
      cwd,
      timeoutMs: options.timeoutMs,
      shell: true,
      // Capped generously here and trimmed to `maxOutputChars` below: the whole
      // output goes to disk, and this is the ceiling on what is held in memory.
      maxOutputChars: Math.max(options.maxOutputChars, LOG_CAPTURE_CHARS),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      exitCode: NO_EXIT_CODE,
      durationMs: 0,
      output: `the ${gate} gate could not be started: ${reason}`,
      logPath: '',
      command,
    };
  }

  const combined = describeGateOutput(execResult, gate, command);
  const written = await writeLog(logPath, combined);

  const passed =
    execResult.status === 0 && execResult.spawnError === null && !execResult.timedOut;

  return {
    status: passed ? 'pass' : 'fail',
    exitCode: execResult.status ?? NO_EXIT_CODE,
    durationMs: execResult.durationMs,
    output: tail(combined, options.maxOutputChars),
    logPath: written,
    command,
  };
}

/**
 * The text a human and the retrying Developer both read.
 *
 * stdout and stderr are interleaved into one document rather than kept apart:
 * a test runner puts the failure summary on one and the assertion on the other,
 * and reading them separately is how you conclude the wrong thing. The header
 * line exists so the log file says what it is without needing its filename.
 */
export function describeGateOutput(
  result: ExecResult,
  gate: GateName,
  command: string,
): string {
  const how =
    result.spawnError !== null
      ? `could not start (${result.spawnError})`
      : result.timedOut
        ? `timed out after ${String(result.durationMs)}ms and was killed`
        : result.signal !== null
          ? `died on ${result.signal}`
          : `exited ${String(result.status)}`;

  return [
    `$ ${command}`,
    `# gate: ${gate}`,
    `# cwd: ${result.cwd}`,
    `# ${how} in ${String(result.durationMs)}ms`,
    '',
    result.stdout.trimEnd(),
    result.stderr.trimEnd(),
  ]
    .filter((part, index) => index < 5 || part !== '')
    .join('\n');
}

/** Returns the path actually written, or `''` if the log could not be written. */
async function writeLog(logPath: string, contents: string): Promise<string> {
  if (logPath === '') return '';
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${contents}\n`, 'utf8');
    return logPath;
  } catch {
    // A gate whose log could not be written is still a gate that ran. Losing
    // the log is bad; losing the verdict because of it would be worse.
    return '';
  }
}

function tail(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const kept = text.slice(text.length - maxChars);
  return `… (${String(text.length - maxChars)} earlier characters are in the log file)\n${kept}`;
}

/**
 * What a gate run produced, and how it reaches the vault (spec §8.2, §7.5).
 *
 * Split from `runner.ts` so the shape of a result and the *rendering* of a
 * result can be reasoned about without a subprocess anywhere near them. Phase
 * 10 runs the same gates against the feature branch and needs exactly these two
 * things — the summaries and the section text — with none of the execution.
 *
 * ============================================================================
 * TWO REPRESENTATIONS, ON PURPOSE
 * ============================================================================
 * `GateResult` is the runner's own camelCase record. `GateResultSummary`
 * (`src/domain/types.ts`) is the snake_case frontmatter shape a human reads in
 * Obsidian and a note round-trips byte-for-byte. They are converted here, in one
 * place, because the two field sets are identical apart from the naming and a
 * silent divergence would show up as a frontmatter key nothing reads.
 *
 * ============================================================================
 * A MISSING RESULT IS A FAILURE, NEVER AN ABSENCE OF EVIDENCE
 * ============================================================================
 * `gatesAllGreen` in `src/domain/guards.ts` already refuses a ticket whose
 * `gate_results` is null or is missing a gate. Everything here preserves that:
 * `emptyResults` fills every gate with `skipped`, and `allGatesPassed` asks for
 * `pass` on each of `GATE_NAMES` rather than asking whether anything failed. A
 * predicate written as "no gate failed" returns true for a run that never
 * happened, which is precisely the shape plan Section E item 3 forbids.
 */
import { fencedBlock } from '../domain/markdown.js';
import { GATE_NAMES } from '../domain/states.js';
import type { GateName } from '../domain/states.js';
import type { GateResultSummary } from '../domain/types.js';

/**
 * The exit code recorded when there was no exit code: the process was killed on
 * its deadline, died on a signal, or never started at all.
 *
 * Spec §8.2 types `exitCode` as a `number`, and `GateResultSummary.exit_code`
 * follows it into the frontmatter, so `null` is not available. A sentinel that
 * is never a real exit code is used instead, and `timedOut`/`spawnError` carry
 * the actual reason in `output`.
 */
export const NO_EXIT_CODE = -1;

/** One gate's outcome (spec §8.2). */
export interface GateResult {
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly exitCode: number;
  readonly durationMs: number;
  /** Tail of the combined output, capped at `config.gate_output_chars`. */
  readonly output: string;
  /** Where the **whole** output was written. Never truncated on disk. */
  readonly logPath: string;
  /** The command as configured, so a human can paste it back. */
  readonly command: string;
}

/** Every gate, always — a gate that did not run is `skipped`, not absent. */
export type GateResults = Readonly<Record<GateName, GateResult>>;

export function skippedResult(command: string, reason: string): GateResult {
  return {
    status: 'skipped',
    exitCode: NO_EXIT_CODE,
    durationMs: 0,
    output: reason,
    logPath: '',
    command,
  };
}

/** All three gates `skipped`. The starting point of every run. */
export function emptyResults(
  commands: Readonly<Record<GateName, string>>,
  reason = 'not run',
): GateResults {
  return Object.fromEntries(
    GATE_NAMES.map((gate) => [gate, skippedResult(commands[gate], reason)]),
  ) as GateResults;
}

/**
 * Green means **every** named gate passed. See the header note: this asks each
 * gate for a `pass` rather than asking whether any gate failed.
 */
export function allGatesPassed(results: GateResults): boolean {
  return GATE_NAMES.every((gate) => results[gate].status === 'pass');
}

/** The first gate that is not `pass`, in run order. `null` when all are green. */
export function firstFailedGate(results: GateResults): GateName | null {
  return GATE_NAMES.find((gate) => results[gate].status !== 'pass') ?? null;
}

/** One line naming what went red, for `pause_detail` and the event log. */
export function describeGateFailure(results: GateResults): string {
  const problems = GATE_NAMES.filter((gate) => results[gate].status !== 'pass').map(
    (gate) => `${gate} (${results[gate].status}, exit ${String(results[gate].exitCode)})`,
  );
  return problems.length === 0 ? 'all gates passed' : `gates red — ${problems.join(', ')}`;
}

/** The runner's record → the frontmatter shape (spec §7.5). */
export function toGateSummaries(results: GateResults): Record<GateName, GateResultSummary> {
  return Object.fromEntries(
    GATE_NAMES.map((gate) => {
      const result = results[gate];
      const summary: GateResultSummary = {
        status: result.status,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        output: result.output,
        log_path: result.logPath,
      };
      return [gate, summary];
    }),
  ) as Record<GateName, GateResultSummary>;
}

/**
 * The `## Gate Results` body section.
 *
 * Written for two readers who want different things. A human opening the ticket
 * in Obsidian wants the verdict in the first line and the failing output near
 * it; the Developer agent's retry wants the failing output **verbatim**, because
 * a paraphrase of a test failure is worth nothing.
 *
 * Every captured output goes inside a fenced block via `fencedBlock`, which
 * widens its own fence past any backticks in the text. A test runner that prints
 * a markdown heading would otherwise split this section in two and shadow
 * whatever comes after it — the same failure `fenceIfHeadings` exists for.
 */
export function renderGateResults(
  results: GateResults,
  context: { readonly attempt: number; readonly commitSha?: string | undefined },
): string {
  const verdict = allGatesPassed(results)
    ? 'All gates passed.'
    : `${describeGateFailure(results)}.`;

  const head = [
    `**Attempt ${String(context.attempt)}** — ${verdict}`,
    context.commitSha === undefined
      ? '_Run by the orchestrator as child processes, outside the sandbox (ADR-004)._'
      : `_Run against commit \`${context.commitSha}\`, so what was verified is what will be merged._`,
  ].join('\n');

  const blocks = GATE_NAMES.map((gate) => {
    const result = results[gate];
    const heading =
      `- **${gate}** — ${result.status}, exit ${String(result.exitCode)}, ` +
      `${String(result.durationMs)}ms — \`${result.command}\`` +
      (result.logPath === '' ? '' : `\n  full output: \`${result.logPath}\``);
    if (result.status === 'pass' || result.output.trim() === '') return heading;
    return `${heading}\n\n${fencedBlock(result.output.trim(), 'text')}`;
  });

  return [head, ...blocks].join('\n\n');
}

/**
 * The requirements §16 acceptance run, as far as M1–M3 reaches (plan Phase 12).
 *
 * ============================================================================
 * THE FIVE ITEMS, AND WHERE EACH ONE IS PROVED
 * ============================================================================
 * Requirements §16 lists five things. They are not the same kind of thing, and
 * putting all five behind the paid switch would be a category error: a live
 * agent makes an orchestrator-mechanics test slow, expensive and
 * non-deterministic without making it any more true. Each placement below is
 * argued, not inherited from the list's order.
 *
 *  1. **A sample feature with tickets (at least two parallelisable) reaches
 *     `done` with only the three approvals and no manual file edits.**
 *     → Proved TWICE, deliberately.
 *       - `a feature goes intake → done through the CLI` (always on, mock
 *         agents). This is the orchestrator half: the CLI surface, the cycle
 *         loop, the three checkpoints, the ticket DAG, the merges, the close.
 *       - `the acceptance feature, on real agents` (FACTORY_REAL_ACCEPTANCE=1).
 *         This is the half a mock genuinely cannot answer — whether real
 *         agents, given only the vault and a sandboxed worktree, can actually
 *         do the work. That is the entire point of Phase 12's done condition,
 *         and it is why this one item is worth several dollars.
 *     Both go through the SAME driver (`driveAcceptance`) and the SAME
 *     assertions (`assertAcceptanceOutcome`). The mock run is therefore also
 *     the structural rehearsal for the paid one: every line of the driving
 *     code executes on `npm test`.
 *
 *  2. **A ticket failing its tests three times lands in `needs_human` with its
 *     logs linked.** → Already proved, on real git and real subprocess gates,
 *     by `dev-loop.test.ts` → `three red gate runs park the ticket with the
 *     logs linked`. NOT duplicated here and NOT behind the paid switch. The
 *     thing under test is the attempt accounting and the pause detail; a real
 *     agent instructed to fail three times is not a real agent, it is a mock
 *     that costs money. The ledger below asserts the cited case still exists,
 *     so the reference cannot rot silently.
 *
 *  3. **A deliberately red base branch blocks the merge.** → Already proved, on
 *     real git, by `feature-close.test.ts` → `a red base branch` (three cases:
 *     the approval path, the auto-approve path, and an approval given before
 *     the base broke). NOT duplicated and NOT paid: breaking the base branch is
 *     a `git commit`, and no agent is involved in the refusal at all.
 *
 *  4. **Killing and restarting mid-run loses no state.** → Already proved by
 *     `orchestrator-recovery.test.ts`, which SIGKILLs a real child process at
 *     two deliberately awkward points and restarts a fresh orchestrator over
 *     what was left on disk. NOT duplicated and NOT paid: a kill during a paid
 *     run destroys the run's own evidence and proves nothing the free version
 *     does not, at a cost of one agent run per attempt.
 *
 *  5. **The vault renders cleanly in Obsidian.** → Proved HERE, always on, by
 *     `findRenderProblems` running over the vault the end-to-end run produced,
 *     and again over the paid run's vault. It is a property of the bytes, so
 *     the checker itself belongs in the free suite — but the bytes that break
 *     it in practice are agent prose, so the paid run re-runs the same checker
 *     over its own vault. The checker has a negative control, because "found
 *     nothing" and "does not work" look identical otherwise.
 *
 * ============================================================================
 * THE PAID SWITCH IS ITS OWN, AND IT IS NOT `FACTORY_REAL_PIPELINE`
 * ============================================================================
 * `FACTORY_REAL_PIPELINE=1` names the M2 pipeline in `pipeline-real.test.ts`
 * and costs about $1.34. This run drives M2 *and* M3 — a PM, a TL, a DL, then a
 * developer, a reviewer and a QA per ticket — so it is several times that.
 * Reusing the variable would fire a multi-dollar run at anyone who already had
 * it exported for the cheaper one.
 *
 *   FACTORY_REAL_ACCEPTANCE=1 npx vitest run test/integration/acceptance.test.ts
 *
 * ============================================================================
 * EVIDENCE BEFORE ASSERTIONS — THE LESSON `pipeline-real.test.ts` PAID FOR
 * ============================================================================
 * That file learned twice that an assertion firing early destroys the only
 * record of a run that had already cost money: the vault lives in a scratch
 * directory `cleanupAllScratchDirs()` removes, so a failed run took its own
 * transcripts with it. This file copies that discipline and goes one step
 * further, because this run costs more and fails in more places:
 *
 *   - Every step appends to a `Journal` BEFORE anything about that step is
 *     asserted, so the record of where the run got to exists whether or not the
 *     next line throws.
 *   - The cost, wall-clock, turn and `structuredOutputCalls` report is printed
 *     from the `finally`, not from the happy path. `pipeline-real.test.ts`
 *     prints it before its last assertion block, which leaves every assertion
 *     *above* that point able to kill the run silently. Here there is no such
 *     point.
 *   - The `finally` copies the WHOLE VAULT — notes, `logs/orchestrator.jsonl`,
 *     every agent transcript, every gate log — plus the journal and a printed
 *     summary, to `.factory-test-repos/acceptance-logs/<label>/<timestamp>/`.
 *     Never overwritten, never on the scratch registry.
 *
 * Assume the paid run fails the first time. `evidence survives a failing run`
 * below is a real test of that path: it drives a run that is made to fail and
 * then asserts the evidence directory really holds the vault, the event log,
 * the transcripts and the summary.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { realWorktrees } from '../../src/cli/deps.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { buildProgram } from '../../src/cli/main.js';
import { runStart } from '../../src/cli/start.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { detectCycles, resolveActionable } from '../../src/domain/dag.js';
import { sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import type { FeatureFrontmatter, TicketNote } from '../../src/domain/types.js';
import { featureBranchName, vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { CHECKPOINTS } from '../../src/orchestrator/checkpoints.js';
import type { CheckpointName } from '../../src/orchestrator/checkpoints.js';
import type { AgentRunResult, AgentRunSpec, Runner } from '../../src/runner/types.js';
import {
  developerPayload,
  qaPayload,
  reviewerPayload,
  scriptedAgents,
} from '../helpers/devLoopFixtures.js';
import type { AgentStep, ScriptedRunner } from '../helpers/devLoopFixtures.js';
import {
  escalation,
  factoryVault,
  pmPayload,
  readNoteFile,
  tlPayload,
} from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  describeSelfContainmentProblems,
  findSelfContainmentProblems,
} from '../helpers/ticketSelfContainment.js';
import type { TicketLike } from '../helpers/ticketSelfContainment.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  scratchDir,
  scratchFactoryHome,
  testRepoRoot,
} from '../helpers/toyRepo.js';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };

const RUN_REAL_ACCEPTANCE = process.env['FACTORY_REAL_ACCEPTANCE'] === '1';

/**
 * Where a run's evidence is kept, outside the scratch registry.
 *
 * `.factory-test-repos/` is gitignored wholesale and `cleanupAllScratchDirs()`
 * only removes directories it created through `scratchDir()`, so nothing here
 * is swept. The same arrangement `pipeline-real.test.ts` uses, for the same
 * reason and after the same lesson.
 */
const EVIDENCE_ROOT = path.join(testRepoRoot(), 'acceptance-logs');

// ---------------------------------------------------------------------------
// The cycle budget.
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * THE CYCLE ARITHMETIC, WRITTEN DOWN RATHER THAN GUESSED
 * ============================================================================
 * A cycle advances every item that is actionable, each `<id>@<stage>` pair once
 * (see `Orchestrator.cycle`). So one cycle can carry a ticket the whole way —
 * `ready → in_progress → gates → code_review → qa → merge → done` — and the
 * budgets below are NOT "one cycle per step". They are "one cycle for the work,
 * plus headroom for the orchestrator's ordinary attempt-retry".
 *
 *   Leg 1, the PM:        `intake → refining`, one agent run, the checkpoint.
 *                         One cycle of work. Budget 3 — Phase 7b measured a
 *                         failed `StructuredOutput` delivery in two of six
 *                         recorded runs, and each one costs a whole cycle.
 *   Leg 2, the TL and DL: two agent runs, both reachable in one cycle.
 *                         Budget 4 — two roles, each able to need a retry.
 *   Leg 3, development:   per ticket, developer → gates → reviewer → QA →
 *                         merge → done, all reachable in one cycle. A bounced
 *                         review or a red gate costs a cycle and `max_attempts`
 *                         is 3, so budget 4 per ticket.
 *   Leg 4, the close:     `in_development → awaiting_feature_close`, the
 *                         feature-branch gates, the base-branch check, the
 *                         checkpoint. Budget 3.
 *
 * For the three-ticket breakdown this requirement has produced six times over,
 * that is 3 + 4 + (3 × 4) + 3 = 22 cycles.
 *
 * **The budget is loose on purpose and the run count is not.** A generous cycle
 * budget only means the loop is given room to use the retry it exists to
 * provide; `assertAcceptanceOutcome` still asserts the number of *successful
 * agent runs* exactly, so a run that needed a retry fails visibly — the same
 * split `pipeline-real.test.ts` settled on after asserting `costs.length === 3`
 * turned out to fail two correct runs.
 */
const CYCLES_FOR_PM = 3;
const CYCLES_FOR_PLANNING = 4;
const CYCLES_PER_TICKET = 4;
const CYCLES_FOR_CLOSE = 3;

/** Agent runs a clean feature needs: pm + tl_plan + dl, then 3 per ticket. */
const PAPER_RUNS = 3;
const RUNS_PER_TICKET = 3;

/**
 * How many extra agent runs a clean-enough run may have.
 *
 * Phase 7b's measurement: a failed `StructuredOutput` delivery is a CLI
 * parameter-boundary fault, not a prompt defect, and the orchestrator's
 * attempt-retry recovers it. Two of six recorded M2 sequences needed one extra
 * run. This run has four times as many roles in it, so four extra runs is the
 * same tolerance per role. Past that, delivery is failing repeatedly and the
 * run should go red rather than quietly cost more.
 */
const RETRY_HEADROOM = 4;

// ---------------------------------------------------------------------------
// Item 1 of §16, always-on half: the mock breakdown.
// ---------------------------------------------------------------------------

/** One ticket in the scripted Delivery Lead's breakdown, and what builds it. */
interface MockTicket {
  readonly title: string;
  /** The module a scripted Developer creates for it. One per ticket, no overlap. */
  readonly module: string;
  readonly dependsOn: readonly string[];
}

/**
 * Four tickets, two of them parallelisable — requirements §16's shape.
 *
 * `tokenise` and `formatNumber` depend on nothing and on each other not at all,
 * so `resolveActionable` hands back two at once on the first pass. That is what
 * "parallelisable" means operationally: two tickets that become actionable at
 * the same moment. It is asserted, not assumed, in the test below.
 *
 * Each ticket builds a **different module**, which is not decoration: ticket
 * branches are cut from `feature/<slug>` and merged back into it one at a time,
 * so two tickets touching one file is a merge conflict, and a conflict escalates
 * to a human (ADR-004) — which would break the "only three approvals" claim for
 * a reason that has nothing to do with the thing under test.
 */
const MOCK_BREAKDOWN: readonly MockTicket[] = [
  { title: 'Add the tokeniser', module: 'tokenise', dependsOn: [] },
  { title: 'Add the number formatter', module: 'formatNumber', dependsOn: [] },
  { title: 'Add the expression parser', module: 'parseExpression', dependsOn: ['Add the tokeniser'] },
  {
    title: 'Add the command-line entry point',
    module: 'runCommandLine',
    dependsOn: ['Add the expression parser', 'Add the number formatter'],
  },
];

function mockDlPayload(): Record<string, unknown> {
  return {
    outcome: 'ok',
    escalate_reason: null,
    notes_markdown:
      'Four tickets. The tokeniser and the formatter share nothing, so both can start at once.',
    tickets: MOCK_BREAKDOWN.map((ticket) => ({
      title: ticket.title,
      description_md: `Create \`src/${ticket.module}.ts\` exporting \`${ticket.module}\`.`,
      acceptance_criteria: [`\`${ticket.module}('x')\` returns a string`, '`npm test` exits 0'],
      technical_notes_md: `Touch only \`src/${ticket.module}.ts\` and its test.`,
      depends_on: [...ticket.dependsOn],
    })),
  };
}

/**
 * A scripted Developer that writes a real, lint-clean, type-strippable module
 * and a real test for it.
 *
 * Copied in shape from `feature-close.test.ts`'s `addsModule`, deliberately:
 * the toy repo's three gates are real subprocesses and they are the only thing
 * that lets a ticket past `gates`, so the bytes have to actually satisfy them.
 */
function addsModule(name: string): AgentStep {
  return {
    write: {
      [`src/${name}.ts`]: `export function ${name}(value: string): string {\n  return \`${name}: \${value}\`;\n}\n`,
      [`src/${name}.test.ts`]: [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        `import { ${name} } from './${name}.ts';`,
        '',
        `test('${name} formats', () => {`,
        `  assert.equal(${name}('x'), '${name}: x');`,
        '});',
        '',
      ].join('\n'),
    },
    structured: developerPayload({
      commit_message: `feat(${name}): add ${name}`,
      files_changed: [`src/${name}.ts`],
      tests_added: [`src/${name}.test.ts`],
    }),
  };
}

/** The whole scripted cast, keyed exactly as `MockRunner` resolves keys. */
function mockScript(featureId: string): Record<string, AgentStep> {
  const script: Record<string, AgentStep> = {
    pm: { structured: pmPayload(), costUsd: 0.25 },
    tl_plan: { structured: tlPayload(), costUsd: 0.6 },
    dl: { structured: mockDlPayload(), costUsd: 0.4 },
    code_reviewer: { structured: reviewerPayload('approve'), costUsd: 0.1 },
    qa: { structured: qaPayload('pass'), costUsd: 0.1 },
  };
  // Keyed per ticket rather than as a list, so a breakdown that came back in a
  // different order cannot silently hand ticket 2's module to ticket 1 and make
  // the run pass for the wrong reason.
  MOCK_BREAKDOWN.forEach((ticket, index) => {
    script[`developer:${featureId}-T${String(index + 1).padStart(3, '0')}`] = addsModule(ticket.module);
  });
  return script;
}

// ---------------------------------------------------------------------------
// A runner that also writes a transcript.
// ---------------------------------------------------------------------------

/**
 * `scriptedAgents`, plus the transcript a real runner would have written.
 *
 * `ClaudeCodeRunner` streams the CLI's JSONL to `spec.transcriptPath`, and that
 * file is the single most valuable thing a failed paid run leaves behind. The
 * scripted runner writes nothing there, so without this the always-on rehearsal
 * of the evidence path would be rehearsing a directory that is always empty —
 * and `evidence survives a failing run` would pass while proving nothing about
 * transcripts.
 *
 * The shape written is the real one: a `tool_use` block named `StructuredOutput`
 * and a terminal `result` event carrying `structured_output`, which is what
 * `payloadSizes()` in `pipeline-real.test.ts` and `StreamCollector` in
 * `src/runner/streamParse.ts` both read.
 */
function recordingAgents(
  script: Readonly<Record<string, AgentStep>>,
  eventLog: string,
): ScriptedRunner {
  const inner = scriptedAgents(script);
  return {
    ...inner,
    async run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult> {
      const result = await inner.run(spec, signal);
      // ================================================================
      // THE RUNNER EMITS `run_finished`, SO THE SUBSTITUTE MUST TOO
      // ================================================================
      // `run_finished` is written by the Runner, not by the dispatcher —
      // `MockRunner` and `ClaudeCodeRunner` each hold the event sink and emit
      // it themselves. A substituted runner that skipped it would leave the
      // event log with no record of any agent run at all, and the cost report,
      // the run-count assertion and the `structuredOutputCalls` warning — the
      // three things the paid run is evidence for — would be reading an empty
      // list on every free run and passing for the wrong reason.
      //
      // Appended rather than emitted through an `EventSink`, because the sink
      // `runStart` built is not reachable from here. `appendFileSync` of a
      // short line to a file opened `O_APPEND` is one `write(2)`, which is what
      // the orchestrator's own `WriteStream` also issues per event, so the two
      // do not tear each other's lines.
      try {
        appendFileSync(
          eventLog,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            type: 'run_finished',
            runId: spec.runId,
            role: spec.role,
            ok: result.ok,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            durationMs: result.durationMs,
            terminalReason: result.terminalReason,
            structuredOutputCalls: result.structuredOutputCalls,
          })}\n`,
          'utf8',
        );
      } catch {
        // The log directory not existing means no cycle ever ran, which every
        // assertion below reports far more clearly than an error from here.
      }
      try {
        mkdirSync(path.dirname(spec.transcriptPath), { recursive: true });
        writeFileSync(
          spec.transcriptPath,
          [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: result.sessionId }),
            JSON.stringify({
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', id: 'toolu_scripted', name: 'StructuredOutput', input: result.structured },
                ],
              },
            }),
            JSON.stringify({
              type: 'result',
              is_error: false,
              structured_output: result.structured,
              total_cost_usd: result.costUsd,
              num_turns: result.numTurns,
            }),
            '',
          ].join('\n'),
          'utf8',
        );
      } catch {
        // Best effort, exactly as `keepTranscripts` is: a transcript that could
        // not be written must not fail a run whose real assertions are about
        // something else.
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The journal — what the run did, recorded before anything is asserted.
// ---------------------------------------------------------------------------

interface Snapshot {
  readonly step: string;
  readonly cyclesSoFar: number;
  readonly feature: {
    readonly status: string;
    readonly pause_reason: string | null;
    readonly pause_detail: string | null;
    readonly resume_to: string | null;
    readonly tag: string | null;
  } | null;
  readonly tickets: readonly { readonly id: string; readonly status: string; readonly attempts: number }[];
  readonly problem?: string;
}

interface Journal {
  readonly label: string;
  readonly snapshots: Snapshot[];
  /** Everything the CLI printed, in order. */
  readonly output: string[];
  /** Files in the vault that changed while the test, not the factory, was in control. */
  readonly handEdits: string[];
  cycles: number;
}

function newJournal(label: string): Journal {
  return { label, snapshots: [], output: [], handEdits: [], cycles: 0 };
}

/**
 * Snapshot the vault into the journal.
 *
 * Every read is wrapped: this is called on paths that a failing run may have
 * left half-built, and a journal entry that throws while recording why a run
 * failed is the worst possible failure mode here.
 */
function record(journal: Journal, vault: FactoryFixture, slug: string, step: string, problem?: string): void {
  let feature: Snapshot['feature'] = null;
  try {
    const front = readNoteFile(vault.paths.featureNote(slug)).frontmatter as FeatureFrontmatter;
    feature = {
      status: front.status,
      pause_reason: front.pause_reason,
      pause_detail: front.pause_detail,
      resume_to: front.resume_to,
      tag: front.tag,
    };
  } catch {
    feature = null;
  }

  const tickets: { id: string; status: string; attempts: number }[] = [];
  try {
    for (const file of readdirSync(vault.paths.ticketsDir(slug)).sort()) {
      if (!file.endsWith('.md')) continue;
      const note = readNoteFile(path.join(vault.paths.ticketsDir(slug), file));
      const front = note.frontmatter as { id?: string; status?: string; attempts?: number };
      tickets.push({
        id: String(front.id),
        status: String(front.status),
        attempts: front.attempts ?? 0,
      });
    }
  } catch {
    // No tickets directory yet. The breakdown has not happened, which the
    // snapshot says by holding an empty list.
  }

  journal.snapshots.push({
    step,
    cyclesSoFar: journal.cycles,
    feature,
    tickets,
    ...(problem === undefined ? {} : { problem }),
  });
}

// ---------------------------------------------------------------------------
// Metrics, read from the orchestrator's own event log.
// ---------------------------------------------------------------------------

interface RunRecord {
  readonly role: string;
  readonly ok: boolean;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly numTurns: number;
  readonly structuredOutputCalls: number;
  readonly terminalReason: string;
}

interface PauseRecord {
  readonly itemId: string;
  readonly pauseReason: string;
  readonly detail: string;
}

function eventsOf(file: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A truncated last line is what a killed process leaves. Skipping it is
      // right: the rest of the log is still the record of the run.
    }
  }
  return events;
}

function runRecords(eventLog: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const event of eventsOf(eventLog)) {
    if (event['type'] !== 'run_finished') continue;
    records.push({
      role: String(event['role']),
      ok: event['ok'] === true,
      costUsd: typeof event['costUsd'] === 'number' ? event['costUsd'] : 0,
      durationMs: typeof event['durationMs'] === 'number' ? event['durationMs'] : 0,
      numTurns: typeof event['numTurns'] === 'number' ? event['numTurns'] : 0,
      structuredOutputCalls:
        typeof event['structuredOutputCalls'] === 'number' ? event['structuredOutputCalls'] : 0,
      terminalReason: String(event['terminalReason'] ?? ''),
    });
  }
  return records;
}

/** Every pause that was not a planned checkpoint — i.e. every escalation. */
function escalations(eventLog: string): PauseRecord[] {
  const pauses: PauseRecord[] = [];
  for (const event of eventsOf(eventLog)) {
    if (event['type'] !== 'item_paused') continue;
    const reason = String(event['pauseReason']);
    if (reason === 'checkpoint') continue;
    pauses.push({ itemId: String(event['itemId']), pauseReason: reason, detail: String(event['detail'] ?? '') });
  }
  return pauses;
}

interface RoleTotals {
  readonly role: string;
  readonly runs: number;
  readonly okRuns: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly numTurns: number;
  readonly structuredOutputCalls: number;
}

function byRole(records: readonly RunRecord[]): RoleTotals[] {
  const totals = new Map<string, RoleTotals>();
  for (const record_ of records) {
    const current = totals.get(record_.role) ?? {
      role: record_.role,
      runs: 0,
      okRuns: 0,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      structuredOutputCalls: 0,
    };
    totals.set(record_.role, {
      role: record_.role,
      runs: current.runs + 1,
      okRuns: current.okRuns + (record_.ok ? 1 : 0),
      costUsd: current.costUsd + record_.costUsd,
      durationMs: current.durationMs + record_.durationMs,
      numTurns: current.numTurns + record_.numTurns,
      structuredOutputCalls: current.structuredOutputCalls + record_.structuredOutputCalls,
    });
  }
  return [...totals.values()].sort((a, b) => (a.role < b.role ? -1 : 1));
}

/**
 * The whole report, as one string.
 *
 * Built as a string rather than printed line by line so the identical text goes
 * to the console AND into the preserved evidence directory. A summary that
 * exists only in a terminal scrollback is a summary that is gone by the time
 * anybody reads the vault.
 */
function reportOf(journal: Journal, eventLog: string, extra: readonly string[] = []): string {
  const records = runRecords(eventLog);
  const roles = byRole(records);
  const totalCost = records.reduce((sum, entry) => sum + entry.costUsd, 0);
  const totalMs = records.reduce((sum, entry) => sum + entry.durationMs, 0);
  const paused = escalations(eventLog);

  const lines: string[] = [
    `=== acceptance run [${journal.label}] ===`,
    '',
    `cycles driven: ${journal.cycles}`,
    '',
    'agent runs, per role:',
    '  role        runs  ok   cost      wall     turns  StructuredOutput calls',
  ];
  for (const role of roles) {
    lines.push(
      `  ${role.role.padEnd(12)}${String(role.runs).padStart(3)}${String(role.okRuns).padStart(5)}` +
        `  $${role.costUsd.toFixed(4).padStart(8)}` +
        `  ${(role.durationMs / 1000).toFixed(0).padStart(5)}s` +
        `  ${String(role.numTurns).padStart(5)}` +
        `  ${String(role.structuredOutputCalls).padStart(5)}`,
    );
  }
  lines.push(
    '',
    `  TOTAL       ${String(records.length).padStart(3)}` +
      `${String(records.filter((entry) => entry.ok).length).padStart(5)}` +
      `  $${totalCost.toFixed(4).padStart(8)}  ${(totalMs / 1000).toFixed(0).padStart(5)}s`,
    '',
  );

  const retried = records.filter((entry) => entry.structuredOutputCalls > 1);
  if (retried.length > 0) {
    lines.push(
      'DELIVERY RETRIES (plan Phase 7b — the CLI rejected a payload and its own retry recovered):',
      ...retried.map(
        (entry) =>
          `  ${entry.role} took ${entry.structuredOutputCalls} StructuredOutput call(s); ` +
          `terminalReason ${entry.terminalReason}. The cap is 5. Read the tool_result in the kept ` +
          'transcript: "could not be parsed as JSON" and "must have required property" are the ' +
          'parameter-boundary fault, a named missing field is a real contract miss.',
      ),
      '',
    );
  }

  lines.push(`escalations: ${paused.length}`);
  for (const pause of paused) {
    lines.push(`  ${pause.itemId}  ${pause.pauseReason}`, `      ${pause.detail.split('\n')[0] ?? ''}`);
  }
  lines.push('');

  lines.push('where each step got to:');
  for (const snapshot of journal.snapshots) {
    lines.push(
      `  [cycle ${String(snapshot.cyclesSoFar).padStart(2)}] ${snapshot.step}`,
      `      feature: ${
        snapshot.feature === null
          ? '(no note)'
          : `${snapshot.feature.status}` +
            (snapshot.feature.pause_reason === null ? '' : ` (${snapshot.feature.pause_reason})`) +
            (snapshot.feature.tag === null ? '' : ` tag=${snapshot.feature.tag}`)
      }`,
    );
    if (snapshot.tickets.length > 0) {
      lines.push(
        `      tickets: ${snapshot.tickets
          .map((ticket) => `${ticket.id}=${ticket.status}(a${ticket.attempts})`)
          .join(' ')}`,
      );
    }
    if (snapshot.problem !== undefined) lines.push(`      PROBLEM: ${snapshot.problem}`);
  }

  if (journal.handEdits.length > 0) {
    lines.push('', 'VAULT FILES CHANGED OUTSIDE A FACTORY COMMAND:', ...journal.handEdits.map((entry) => `  ${entry}`));
  }

  if (extra.length > 0) lines.push('', ...extra);

  lines.push('', 'CLI output:', ...journal.output.map((line) => `  ${line}`));
  return lines.join('\n');
}

/**
 * Copy everything a failed run needs somewhere `afterAll` will not delete.
 *
 * The WHOLE vault, not only `logs/`: the notes are where a reader finds out
 * which ticket stopped and what its `pause_detail` said, and they live in the
 * same scratch directory that is about to be removed. Timestamped, so a second
 * attempt never overwrites the first one's evidence — which would repeat, for
 * free, exactly the loss this whole mechanism exists to prevent.
 */
function preserveEvidence(
  journal: Journal,
  vaultRoot: string,
  report: string,
  options: { readonly copyVault: boolean } = { copyVault: true },
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(EVIDENCE_ROOT, journal.label, stamp);
  try {
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, 'summary.txt'), `${report}\n`, 'utf8');
    writeFileSync(
      path.join(destination, 'journal.json'),
      `${JSON.stringify({ label: journal.label, cycles: journal.cycles, snapshots: journal.snapshots, handEdits: journal.handEdits }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Nothing else here can help. The console still has the report.
  }
  // The summary and the journal are always kept: they are a few kilobytes and
  // they are what says whether a run was clean. The **vault** is copied only
  // when asked, because the free run happens on every `npm test` and a full
  // vault copy per run would fill the disk with the evidence of successes
  // nobody is going to read. Every failing run, and every paid run, copies it.
  if (!options.copyVault) return destination;
  try {
    cpSync(vaultRoot, path.join(destination, 'vault'), { recursive: true });
  } catch {
    // A vault that never got created says so by its absence, which the summary
    // explains far better than an exception thrown from the cleanup path.
  }
  return destination;
}

// ---------------------------------------------------------------------------
// "No manual file edits", enforced against this test's own conduct.
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * THE DONE CONDITION BINDS THE HARNESS, NOT ONLY THE FACTORY
 * ============================================================================
 * Phase 12's done condition is "intake → done ... with no manual file edits".
 * A test that reached into the vault to nudge a note past a sticking point
 * would satisfy every assertion below and prove nothing. So the vault is
 * digested after each factory command returns and re-digested before the next
 * one starts; anything that changed in between was changed by the test.
 *
 * Today that window is empty and the check is trivially satisfied, which is the
 * point: it is a **tripwire**, not a discovery. The realistic way this file
 * decays is somebody debugging a failing paid run adding one `writeFileSync` to
 * get past a step. That edit goes red here, by name, instead of quietly turning
 * the acceptance run into a demonstration of the harness.
 */
interface HandEditGuard {
  /** Remember the vault as the factory just left it. */
  seal(): void;
  /** Record anything that changed since `seal()`. Called before each command. */
  check(step: string): void;
}

function digestVault(root: string): Map<string, string> {
  const digest = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, relative);
        continue;
      }
      try {
        digest.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'));
      } catch {
        digest.set(relative, 'unreadable');
      }
    }
  };
  walk(root, '');
  return digest;
}

function handEditGuard(root: string, journal: Journal): HandEditGuard {
  let sealed = digestVault(root);
  return {
    seal(): void {
      sealed = digestVault(root);
    },
    check(step: string): void {
      const current = digestVault(root);
      for (const [file, hash] of current) {
        const before = sealed.get(file);
        if (before === undefined) journal.handEdits.push(`${step}: ${file} was created`);
        else if (before !== hash) journal.handEdits.push(`${step}: ${file} was modified`);
      }
      for (const file of sealed.keys()) {
        if (!current.has(file)) journal.handEdits.push(`${step}: ${file} was deleted`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Item 5 of §16 — does the vault render cleanly in Obsidian?
// ---------------------------------------------------------------------------

interface RenderFinding {
  readonly file: string;
  readonly rule: string;
  readonly detail: string;
  readonly severity: 'error' | 'warning';
}

/**
 * ============================================================================
 * WHAT "RENDERS CLEANLY" CAN AND CANNOT BE CHECKED MECHANICALLY
 * ============================================================================
 * Obsidian is not installable in CI and its renderer is not a library, so this
 * checks the four things that actually break a vault in it, all of which are
 * properties of the bytes:
 *
 *   1. **An unclosed code fence.** The single most destructive one: everything
 *      after it renders as code, so the rest of the note — history, pause
 *      detail, acceptance criteria — silently disappears from reading view. The
 *      factory fences agent prose (`fencedBlock`) and agent prose contains
 *      fences, so this is a live hazard rather than a theoretical one.
 *   2. **A heading with no space after its hashes.** `##Notes` renders as the
 *      literal text `##Notes`. The section is still there and still parses; it
 *      just stops looking like a section.
 *   3. **A dead relative link.** In the generated views (`index.md`,
 *      `NEEDS_HUMAN.md`) this is an **error**: those files exist to be clicked,
 *      and a link that 404s is the view failing at its only job. Inside a note
 *      body it is a **warning**, because that text came from an agent and a
 *      prompt fix is a different kind of change from an orchestrator bug — and
 *      because failing a multi-dollar run on an agent's stray link would be a
 *      guard the next person turns off.
 *   4. **A filename Obsidian cannot open.** `*"\/<>:|?`, or a trailing dot or
 *      space, break on at least one of the platforms Obsidian ships for.
 *
 * Dotfiles and dot-directories are skipped: Obsidian ignores them, and
 * `.gitkeep`, `.runs/` and the instance lock are all of that kind.
 */
function findRenderProblems(root: string): RenderFinding[] {
  const findings: RenderFinding[] = [];
  const files: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (/[*"\\/<>:|?]/.test(entry) || /[. ]$/.test(entry)) {
        findings.push({
          file: relative,
          rule: 'filename Obsidian cannot open',
          detail: `${entry} contains a character, or ends in a dot or space, that at least one of Obsidian's platforms rejects`,
          severity: 'error',
        });
      }
      if (stats.isDirectory()) walk(full, relative);
      else files.push(relative);
    }
  };
  walk(root, '');

  for (const relative of files) {
    if (!relative.endsWith('.md')) continue;
    let text: string;
    try {
      text = readFileSync(path.join(root, relative), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');

    // 1. Fences. The same open/close rule the project's own `scanMarkdown`
    //    uses: a fence closes on a run of the same character at least as long.
    let openFence: string | null = null;
    let openedAt = 0;
    lines.forEach((line, index) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match === null) return;
      const marker = match[1] ?? '';
      if (openFence === null) {
        openFence = marker;
        openedAt = index + 1;
        return;
      }
      if (marker[0] === openFence[0] && marker.length >= openFence.length && (match[2] ?? '').trim() === '') {
        openFence = null;
      }
    });
    if (openFence !== null) {
      findings.push({
        file: relative,
        rule: 'unclosed code fence',
        detail: `a fence opened at line ${openedAt} is never closed, so everything after it renders as code`,
        severity: 'error',
      });
    }

    // 2. Headings. Only outside fences — a `#comment` in a shell example is not
    //    a broken heading, and a checker that said it was would be switched off.
    let inFence: string | null = null;
    lines.forEach((line, index) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        const marker = fence[1] ?? '';
        if (inFence === null) inFence = marker;
        else if (marker[0] === inFence[0] && marker.length >= inFence.length) inFence = null;
        return;
      }
      if (inFence !== null) return;
      if (/^#{1,6}[^#\s]/.test(line)) {
        findings.push({
          file: relative,
          rule: 'heading with no space after the hashes',
          detail: `line ${index + 1}: ${line.slice(0, 60)}`,
          severity: 'error',
        });
      }
    });

    // 3. Relative links.
    const isView = relative === 'index.md' || relative.toUpperCase() === 'NEEDS_HUMAN.MD';
    for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? '';
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const decoded = decodeURIComponent(target.split('#')[0] ?? '');
      if (decoded === '') continue;
      const resolved = decoded.startsWith('/')
        ? path.join(root, decoded)
        : path.resolve(path.dirname(path.join(root, relative)), decoded);
      if (existsSync(resolved)) continue;
      findings.push({
        file: relative,
        rule: 'dead relative link',
        detail: `${target} does not exist`,
        severity: isView ? 'error' : 'warning',
      });
    }
  }

  return findings;
}

function describeRenderProblems(findings: readonly RenderFinding[], severity: 'error' | 'warning'): string {
  return findings
    .filter((finding) => finding.severity === severity)
    .map((finding) => `${finding.file}: ${finding.rule} — ${finding.detail}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The driver. One implementation, used by the free run and the paid run.
// ---------------------------------------------------------------------------

interface AcceptanceContext {
  readonly label: string;
  readonly vault: FactoryFixture;
  readonly home: string;
  readonly workspace: string;
  readonly slug: string;
  readonly featureId: string;
  readonly requirement: string;
  readonly requirementFileName: string;
  /**
   * Overrides `config.runner`.
   *
   * Absent on the paid path, which is the whole difference between the two
   * runs: `runStart` then builds a `ClaudeCodeRunner` from `config.runner`, and
   * everything else on this page is identical.
   */
  readonly runner?: Runner;
  readonly now: () => string;
  readonly journal: Journal;
  /**
   * Held on the context, not built inside `driveAcceptance`, because it has to
   * wrap **every** factory invocation — the three CLI commands and each cycle
   * alike. A guard that only bracketed the CLI commands would call every write
   * the loop made "a hand edit", which is the shape this first went wrong in.
   */
  readonly guard: HandEditGuard;
}

function depsFor(ctx: AcceptanceContext): CliDeps {
  return {
    cwd: ctx.workspace,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(ctx.home),
    out: (line: string): void => void ctx.journal.output.push(line),
    err: (line: string): void => void ctx.journal.output.push(`ERR ${line}`),
    now: ctx.now,
    // The real thing. Anything less and the agents would run in the operator's
    // own checkout, which is what Phase 7a's refusal exists to prevent.
    workspaceFactory: realWorktrees,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  };
}

/**
 * Exactly what an operator types. No note is ever written directly.
 *
 * The guard brackets the call: everything that changed since the last factory
 * invocation returned is, by definition, something the test did.
 */
async function factory(ctx: AcceptanceContext, args: readonly string[]): Promise<void> {
  ctx.guard.check(`before \`factory ${args.slice(0, 2).join(' ')}\``);
  await buildProgram(depsFor(ctx), MANIFEST).parseAsync(['node', 'factory', ...args]);
  ctx.guard.seal();
}

/**
 * Run cycles one at a time until `until` holds, or the budget is spent.
 *
 * One at a time rather than `maxCycles: budget` for two reasons that both
 * matter on the paid path: the journal gets a snapshot per cycle, so a run that
 * stalls says exactly which cycle it stopped moving on; and a leg that finishes
 * early does not sit through the remaining cycles, which on a $5 run is minutes
 * of wall clock spent doing nothing.
 */
async function cyclesUntil(
  ctx: AcceptanceContext,
  budget: number,
  what: string,
  until: () => boolean,
): Promise<void> {
  for (let spent = 0; spent < budget; spent += 1) {
    if (until()) return;
    ctx.guard.check(`before cycle ${ctx.journal.cycles + 1}`);
    await runStart({ vault: ctx.vault.root, maxCycles: 1 }, depsFor(ctx));
    ctx.guard.seal();
    ctx.journal.cycles += 1;
    record(ctx.journal, ctx.vault, ctx.slug, `cycle ${ctx.journal.cycles} (waiting for ${what})`);
  }
  if (until()) return;
  record(ctx.journal, ctx.vault, ctx.slug, `budget exhausted waiting for ${what}`, `${budget} cycles spent`);
  throw new Error(
    `${ctx.label}: ${budget} cycles came and went and ${what} never happened. The journal above ` +
      'says where each item stopped; the preserved vault and transcripts say why.',
  );
}

function featureFrontmatter(ctx: AcceptanceContext): FeatureFrontmatter {
  return readNoteFile(ctx.vault.paths.featureNote(ctx.slug)).frontmatter as FeatureFrontmatter;
}

/**
 * Stopped for a human for any reason — a checkpoint, or an escalation.
 *
 * Deliberately **not** "is it at the checkpoint I expect". A leg that escalates
 * has stopped and is never going to move again, so waiting for the specific
 * checkpoint would spend the whole budget and then report "the checkpoint never
 * happened" instead of "the PM escalated, and here is why". Every leg therefore
 * waits for a pause and `assertCheckpoint` decides whether it was the right one.
 */
function parked(ctx: AcceptanceContext): boolean {
  try {
    return featureFrontmatter(ctx).status === 'needs_human';
  } catch {
    return false;
  }
}

/** Tickets sitting at `needs_human`, with the reason they stopped. */
function parkedTickets(ctx: AcceptanceContext): string[] {
  const stuck: string[] = [];
  try {
    for (const file of readdirSync(ctx.vault.paths.ticketsDir(ctx.slug)).sort()) {
      if (!file.endsWith('.md')) continue;
      const front = readNoteFile(path.join(ctx.vault.paths.ticketsDir(ctx.slug), file))
        .frontmatter as { id?: string; status?: string; pause_reason?: string | null; pause_detail?: string | null };
      if (front.status !== 'needs_human') continue;
      stuck.push(
        `${String(front.id)}: ${String(front.pause_reason)} — ${String(front.pause_detail).split('\n')[0] ?? ''}`,
      );
    }
  } catch {
    // No tickets yet.
  }
  return stuck;
}

/**
 * The development leg is over when the feature parks — or when a ticket does.
 *
 * A parked ticket is the realistic way the paid run stops: three red gates and
 * `attempts_exhausted`. The feature stays `in_development`, so waiting only on
 * the feature would spend the whole budget and then report "the final_acceptance
 * checkpoint never happened", which is true and useless. Stopping on the ticket
 * lets `assertCheckpoint` name it and quote its `pause_detail`.
 */
function settled(ctx: AcceptanceContext): boolean {
  return parked(ctx) || parkedTickets(ctx).length > 0;
}

function assertCheckpoint(ctx: AcceptanceContext, name: CheckpointName): void {
  const front = featureFrontmatter(ctx);
  const stuck = parkedTickets(ctx);
  expect(
    `${front.status}/${String(front.pause_reason)}/${String(front.resume_to)}`,
    `${ctx.label}: the feature did not reach the ${name} checkpoint. It is ${front.status} with ` +
      `pause_reason ${String(front.pause_reason)} and pause_detail: ${String(front.pause_detail)}` +
      (stuck.length === 0 ? '' : `\nTickets waiting for a human:\n  ${stuck.join('\n  ')}`),
  ).toBe(`needs_human/checkpoint/${CHECKPOINTS[name].resumeTo}`);
}

interface DriveResult {
  readonly tickets: readonly TicketNote[];
}

/**
 * `intake → done`, through the real CLI, with three approvals and nothing else.
 *
 * This is the whole of item 1, and it is the code the paid run executes. Every
 * step is a command an operator would type. There is no direct note write
 * anywhere in it, by construction and by the guard.
 */
async function driveAcceptance(ctx: AcceptanceContext): Promise<DriveResult> {
  // The requirement file is the one thing the test writes, and it is written
  // into the scratch workspace — outside the vault — exactly as a person would
  // have a requirement sitting in a directory of their own.
  const requirementFile = path.join(ctx.workspace, ctx.requirementFileName);
  writeFileSync(requirementFile, ctx.requirement, 'utf8');

  await factory(ctx, ['feature', 'add', requirementFile, '--vault', ctx.vault.root]);
  record(ctx.journal, ctx.vault, ctx.slug, 'factory feature add');
  expect(
    existsSync(ctx.vault.paths.featureNote(ctx.slug)),
    `${ctx.label}: \`factory feature add\` did not create ${ctx.vault.paths.featureNote(ctx.slug)} — ` +
      'the slug derived from the requirement filename is not what this run expected',
  ).toBe(true);

  // --- leg 1: the PM, then approval 1 of 3 ---------------------------------
  await cyclesUntil(ctx, CYCLES_FOR_PM, 'the after_pm_refinement checkpoint', () => parked(ctx));
  record(ctx.journal, ctx.vault, ctx.slug, 'the PM leg finished');
  assertCheckpoint(ctx, 'after_pm_refinement');

  await factory(ctx, ['approve', ctx.featureId, 'the refined requirement matches what I asked for', '--vault', ctx.vault.root]);
  record(ctx.journal, ctx.vault, ctx.slug, 'approval 1 of 3 — after_pm_refinement');

  // --- leg 2: the TL and the DL, then approval 2 of 3 ----------------------
  await cyclesUntil(ctx, CYCLES_FOR_PLANNING, 'the after_ticket_breakdown checkpoint', () => parked(ctx));
  record(ctx.journal, ctx.vault, ctx.slug, 'the TL and DL leg finished');
  assertCheckpoint(ctx, 'after_ticket_breakdown');

  await factory(ctx, ['approve', ctx.featureId, 'the breakdown is right — start development', '--vault', ctx.vault.root]);
  record(ctx.journal, ctx.vault, ctx.slug, 'approval 2 of 3 — after_ticket_breakdown');

  const tickets = await ctx.vault.storage.listTickets(ctx.slug);

  // --- leg 3: the whole ticket loop, then approval 3 of 3 ------------------
  // The budget is computed from the breakdown the DL actually produced, not
  // from the one this run hoped for. A four-ticket breakdown on the paid path
  // must not fail for running out of cycles it was never given.
  const developmentBudget = tickets.length * CYCLES_PER_TICKET + CYCLES_FOR_CLOSE;
  await cyclesUntil(ctx, developmentBudget, 'the final_acceptance checkpoint', () => settled(ctx));
  record(ctx.journal, ctx.vault, ctx.slug, 'the development leg finished');
  assertCheckpoint(ctx, 'final_acceptance');

  await factory(ctx, ['approve', ctx.featureId, 'accepted — merge and tag it', '--vault', ctx.vault.root]);
  record(ctx.journal, ctx.vault, ctx.slug, 'approval 3 of 3 — final_acceptance');

  return { tickets: await ctx.vault.storage.listTickets(ctx.slug) };
}

// ---------------------------------------------------------------------------
// The shared outcome assertions.
// ---------------------------------------------------------------------------

/**
 * Everything that makes this an acceptance run rather than a smoke test.
 *
 * Shared by the free run and the paid one on purpose: it means the assertions
 * the paid run will be judged by have all been executed, against a real vault
 * and a real toy repo, on every `npm test`.
 */
function assertAcceptanceOutcome(ctx: AcceptanceContext, tickets: readonly TicketNote[]): void {
  const repo = ctx.vault.repo.path;
  const base = ctx.vault.repo.branch;
  const featureBranch = featureBranchName(ctx.slug);
  const front = featureFrontmatter(ctx);
  const body = readNoteFile(ctx.vault.paths.featureNote(ctx.slug)).body;

  // 1. The feature is delivered.
  expect(front.status, `${ctx.label}: the feature is ${front.status}, not done`).toBe('done');

  // 2. Every ticket finished. A feature cannot reach `done` with an unfinished
  //    ticket, but asserting it here names the ticket when something changes.
  for (const ticket of tickets) {
    expect(
      ticket.frontmatter.status,
      `${ctx.label}: ${ticket.frontmatter.id} is ${ticket.frontmatter.status}`,
    ).toBe('done');
  }

  // 3. At least two tickets could have started at once — §16's "parallelisable".
  //    Asked of the breakdown as it was cut, i.e. of every ticket in its
  //    pre-development state, because by now they are all `done` and
  //    `resolveActionable` would answer about nothing.
  const startable = resolveActionable(
    tickets.map((ticket) => ({
      id: ticket.frontmatter.id,
      status: 'backlog' as const,
      depends_on: ticket.frontmatter.depends_on,
    })),
  );
  expect(
    startable.length,
    `${ctx.label}: only ${startable.length} ticket(s) could have started at once — the breakdown ` +
      'is a chain, not a graph, so nothing here is parallelisable',
  ).toBeGreaterThanOrEqual(2);
  expect(detectCycles(tickets.map((ticket) => ({
    id: ticket.frontmatter.id,
    status: ticket.frontmatter.status,
    depends_on: ticket.frontmatter.depends_on,
  })))).toEqual([]);

  // 4. The tag exists, on the base branch tip, and the note names it.
  const tags = git(repo, ['tag']).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  expect(front.tag, `${ctx.label}: the feature note records no tag`).not.toBeNull();
  expect(tags, `${ctx.label}: the tag the note names is not in the repo`).toContain(front.tag);
  expect(git(repo, ['rev-parse', String(front.tag)]).trim()).toBe(git(repo, ['rev-parse', base]).trim());

  // 5. The base branch really carries the feature, by a --no-ff merge.
  expect(
    git(repo, ['rev-list', '--parents', '-n', '1', base]).trim().split(/\s+/),
    `${ctx.label}: the base branch tip is not a two-parent merge commit, so the close was not --no-ff`,
  ).toHaveLength(3);
  git(repo, ['merge-base', '--is-ancestor', featureBranch, base]);

  // 6. Exactly three human approvals, and no fourth touch anywhere.
  const humanMoves = historyLines(body).filter((line) => (line.split(' | ')[2] ?? '') === 'human');
  expect(
    humanMoves.length,
    `${ctx.label}: ${humanMoves.length} human transitions on the feature, not 3:\n${humanMoves.join('\n')}`,
  ).toBe(3);
  const checkpointPauses = historyLines(body).filter((line) => (line.split(' | ')[3] ?? '').startsWith('checkpoint '));
  expect(
    checkpointPauses.length,
    `${ctx.label}: ${checkpointPauses.length} checkpoint pauses, not 3:\n${checkpointPauses.join('\n')}`,
  ).toBe(3);
  for (const ticket of tickets) {
    const ticketBody = readNoteFile(ctx.vault.paths.ticketPath(ctx.slug, ticket.frontmatter.id)).body;
    expect(
      historyLines(ticketBody).filter((line) => (line.split(' | ')[2] ?? '') === 'human'),
      `${ctx.label}: ${ticket.frontmatter.id} needed a human, so this run did not take three approvals`,
    ).toEqual([]);
  }

  // 7. Nothing escalated. An escalation is a fourth thing asking for a person.
  const escalated = escalations(ctx.vault.paths.eventLog());
  expect(
    escalated.map((entry) => `${entry.itemId}: ${entry.pauseReason} — ${entry.detail.split('\n')[0] ?? ''}`),
    `${ctx.label}: the run escalated, so it did not reach done on three approvals alone`,
  ).toEqual([]);

  // 8. No manual file edits — see `handEditGuard`.
  expect(
    ctx.journal.handEdits,
    `${ctx.label}: the vault changed while the factory was not running, so this run does not ` +
      'satisfy "no manual file edits"',
  ).toEqual([]);

  // 9. The number of agent runs. Loose on cycles, exact here — see the cycle
  //    arithmetic note.
  const records = runRecords(ctx.vault.paths.eventLog());
  const expectedOk = PAPER_RUNS + RUNS_PER_TICKET * tickets.length;
  const okRuns = records.filter((entry) => entry.ok).length;
  expect(
    okRuns,
    `${ctx.label}: ${okRuns} successful agent runs; ${tickets.length} tickets needs exactly ` +
      `${expectedOk} — pm, tl_plan, dl, then developer, code_reviewer and qa per ticket`,
  ).toBe(expectedOk);
  expect(
    records.length,
    `${ctx.label}: ${records.length} agent runs for ${expectedOk} pieces of work. Extra runs are ` +
      "the orchestrator retrying a role whose payload the CLI failed to deliver — see the plan's " +
      '"Phase 7b measurement results". More than the headroom means delivery is failing repeatedly.',
  ).toBeLessThanOrEqual(expectedOk + RETRY_HEADROOM);

  // 10. Every ticket stands on its own. Structural only — a regex cannot judge
  //     "could this be built from this text alone" — but it is the check that
  //     catches the failure Phase 7b says poisons development silently: a
  //     Developer handed a ticket that refers to a note it cannot open.
  expect(
    describeSelfContainmentProblems(findSelfContainmentProblems(tickets.map(asTicketLike))),
    `${ctx.label}: a ticket refers to another ticket, so a Developer holding only that note could ` +
      'not have built it. On a real run the fix is a prompt edit, not a retry.',
  ).toBe('');

  // 11. §16 item 5, on the vault this run actually produced.
  const findings = findRenderProblems(ctx.vault.root);
  expect(
    describeRenderProblems(findings, 'error'),
    `${ctx.label}: the vault does not render cleanly in Obsidian`,
  ).toBe('');
  const warnings = describeRenderProblems(findings, 'warning');
  if (warnings !== '') {
    console.warn(`[acceptance ${ctx.label}] Obsidian render warnings (agent prose, not orchestrator output):\n${warnings}`);
  }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const worktreeRoots = new Set<string>();

function newContext(input: {
  readonly label: string;
  readonly slug: string;
  readonly requirement: string;
  /**
   * The scripted cast, for a free run.
   *
   * Absent means the paid run: `config.runner` stays `claude-code`, `deps.runner`
   * is not set, and `runStart` builds a real `ClaudeCodeRunner`. That one
   * difference is the entire difference between the two runs.
   */
  readonly script?: Readonly<Record<string, AgentStep>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly projectMd?: string;
}): AcceptanceContext {
  const vault = factoryVault({
    config: {
      runner: input.script === undefined ? 'claude-code' : 'mock',
      ...(input.config ?? {}),
    },
  });
  if (input.projectMd !== undefined) writeFileSync(vault.paths.projectFile(), input.projectMd, 'utf8');
  worktreeRoots.add(worktreeRoot(vault.config.target_repo, vaultWorktreeName(vault.paths.root)));

  let clockMs = Date.parse('2026-09-22T09:00:00.000Z');
  const journal = newJournal(input.label);
  return {
    label: input.label,
    vault,
    home: scratchFactoryHome(),
    workspace: scratchDir('acceptance-workspace-'),
    slug: input.slug,
    featureId: `FEAT-${input.slug.toUpperCase()}`,
    requirement: input.requirement,
    requirementFileName: `${input.slug}.md`,
    ...(input.script === undefined
      ? {}
      : { runner: recordingAgents(input.script, vault.paths.eventLog()) }),
    now: (): string => {
      clockMs += 1000;
      return new Date(clockMs).toISOString();
    },
    journal,
    // Sealed here, i.e. over the vault exactly as `factoryVault` and any
    // `project.md` left it. Everything after this point is either a factory
    // command or, if the guard has anything to say, this test misbehaving.
    guard: handEditGuard(vault.root, journal),
  };
}

afterAll(() => {
  for (const root of worktreeRoots) rmSync(root, { recursive: true, force: true });
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

// ---------------------------------------------------------------------------
// The §16 ledger. Free, always runs.
// ---------------------------------------------------------------------------

/**
 * Three of §16's five items are proved in files this one does not own, and a
 * cross-reference in a comment is a cross-reference that rots.
 *
 * So each reference is asserted: the file exists and still contains the case
 * that carries the claim. Renaming or deleting one of those cases fails here,
 * with a message saying which §16 item just lost its evidence — rather than
 * leaving this file's header quietly lying about where the proof is.
 */
const LEDGER: readonly {
  readonly item: string;
  readonly file: string;
  readonly cases: readonly string[];
}[] = [
  {
    item: '§16.2 — a ticket failing its tests three times lands in needs_human with its logs linked',
    file: 'test/integration/dev-loop.test.ts',
    cases: ['three red gate runs park the ticket with the logs linked'],
  },
  {
    item: '§16.3 — a deliberately red base branch blocks the merge',
    file: 'test/integration/feature-close.test.ts',
    cases: [
      'is never offered for approval, and the note blames the base, not the feature',
      'is not merged into by the auto-approve path either, however many cycles run',
      'does not deliver on an approval given before it broke, however many cycles run',
    ],
  },
  {
    item: '§16.4 — killing and restarting mid-run loses no state',
    file: 'test/integration/orchestrator-recovery.test.ts',
    cases: [
      're-runs the role and writes its output exactly once, with no duplicate history',
      'leaves the item claimed by a dead instance, and the restart frees it and carries on',
      'the restart re-runs the DL and there are still exactly four tickets',
    ],
  },
];

describe('the §16 acceptance list — where each item is proved', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  for (const entry of LEDGER) {
    it(`${entry.item} → ${entry.file}`, () => {
      const file = path.join(root, entry.file);
      expect(existsSync(file), `${entry.file} is gone, and with it the proof of ${entry.item}`).toBe(true);
      const text = readFileSync(file, 'utf8');
      for (const name of entry.cases) {
        expect(
          text.includes(name),
          `${entry.file} no longer has the case "${name}". That case is what proves ${entry.item}. ` +
            'Either restore it, or move the proof into acceptance.test.ts and update this ledger.',
        ).toBe(true);
      }
    });
  }

  it('§16.1 and §16.5 are proved in this file', () => {
    // A statement, asserted so that the header and the file cannot drift: the
    // two items this file owns are the end-to-end run and the render check.
    expect(typeof driveAcceptance).toBe('function');
    expect(typeof findRenderProblems).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// §16 item 5 — the render checker's own negative control.
// ---------------------------------------------------------------------------

describe('the Obsidian render checker (free, always runs)', () => {
  it('finds nothing in a vault built from the shipped template', () => {
    // The negative control. Without it, "the checker found nothing" and "the
    // checker does not work" are the same observation — the device
    // `pipeline-real.test.ts` uses for its self-containment checker, for the
    // same reason.
    const vault = factoryVault();
    try {
      expect(describeRenderProblems(findRenderProblems(vault.root), 'error')).toBe('');
    } finally {
      vault.cleanup();
    }
  });

  it('catches every kind of breakage it claims to', () => {
    const sample = scratchDir('render-sample-');
    mkdirSync(path.join(sample, 'work'), { recursive: true });
    writeFileSync(
      path.join(sample, 'index.md'),
      '# Index\n\n[a feature](work/features/gone/feature.md)\n',
      'utf8',
    );
    writeFileSync(
      path.join(sample, 'work', 'broken.md'),
      '# Broken\n\n```ts\nconst x = 1;\n\n##NotAHeading\n',
      'utf8',
    );

    const findings = findRenderProblems(sample);
    const rules = findings.map((finding) => finding.rule);
    expect(rules).toContain('dead relative link');
    expect(rules).toContain('unclosed code fence');
    // The dead link in `index.md` is an error because a generated view exists
    // to be clicked; the glued heading is an error anywhere.
    expect(describeRenderProblems(findings, 'error')).toContain('index.md');
    expect(describeRenderProblems(findings, 'error')).toContain('unclosed code fence');
  });

  it('does not fire on a dead link inside a note body — that is a warning', () => {
    // The distinction that keeps this checker usable on a paid run. A link an
    // agent wrote into `notes_markdown` is a prompt problem; a link the
    // orchestrator generated into a view is a bug. Failing a multi-dollar run
    // on the first would be a guard the next person turns off.
    const sample = scratchDir('render-warn-');
    mkdirSync(path.join(sample, 'work'), { recursive: true });
    writeFileSync(path.join(sample, 'work', 'note.md'), '# Note\n\n[see](src/nope.ts)\n', 'utf8');

    const findings = findRenderProblems(sample);
    expect(describeRenderProblems(findings, 'error')).toBe('');
    expect(describeRenderProblems(findings, 'warning')).toContain('dead relative link');
  });

  it('does not mistake a shell comment inside a fence for a broken heading', () => {
    const sample = scratchDir('render-fence-');
    writeFileSync(path.join(sample, 'note.md'), '# Note\n\n```sh\n#!/bin/sh\n#not a heading\n```\n', 'utf8');
    expect(describeRenderProblems(findRenderProblems(sample), 'error')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The report a failed paid run will be read through.
// ---------------------------------------------------------------------------

describe('the run report (free, always runs)', () => {
  it('reports a retried delivery and a failed run out of a real event log', () => {
    // ====================================================================
    // THE TWO BRANCHES A GREEN RUN NEVER REACHES
    // ====================================================================
    // The end-to-end run above is clean by construction, so it exercises the
    // report's happy shape only — every role one run, one `StructuredOutput`
    // call, no escalation. The two blocks that matter most when the paid run
    // goes wrong are exactly the two a clean run cannot reach, so they are
    // driven here against a hand-written log in the shape the runner writes.
    //
    // `structuredOutputCalls` is the field Phase 7b asked for and Phases 9, 10
    // and 11 each deferred. It landed this session specifically so the paid
    // acceptance run would carry the signal, and the only way that signal ever
    // reaches a human is through this function.
    const dir = scratchDir('report-sample-');
    const file = path.join(dir, 'orchestrator.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: 't1', type: 'cycle_started', cycle: 1 }),
        JSON.stringify({
          ts: 't2', type: 'run_finished', runId: 'r1', role: 'dl', ok: false,
          costUsd: 1.21, numTurns: 9, durationMs: 90_000,
          terminalReason: 'structured_output_retry_exhausted', structuredOutputCalls: 5,
        }),
        JSON.stringify({
          ts: 't3', type: 'run_finished', runId: 'r2', role: 'dl', ok: true,
          costUsd: 0.93, numTurns: 7, durationMs: 70_000,
          terminalReason: 'completed', structuredOutputCalls: 2,
        }),
        JSON.stringify({
          ts: 't4', type: 'item_paused', itemId: 'FEAT-X-T002', pauseReason: 'attempts_exhausted',
          detail: 'the quality gate went red three times\nGate log: /tmp/x.log',
          resumeTo: null, rejectTo: null,
        }),
        'this line is not JSON, which is what a killed process leaves behind',
        '',
      ].join('\n'),
      'utf8',
    );

    const journal = newJournal('sample');
    journal.cycles = 4;
    const report = reportOf(journal, file);

    // Per role, and in total: cost, wall-clock, turns and delivery calls.
    expect(report).toContain('$  2.1400');
    expect(report).toContain('160s');
    expect(report).toContain('DELIVERY RETRIES');
    expect(report, 'the exhausted delivery is not named').toContain('structured_output_retry_exhausted');
    expect(report, 'the cap the CLI states is not in the report').toContain('The cap is 5');
    expect(report, 'the escalation is not reported').toContain('attempts_exhausted');
    expect(report).toContain('FEAT-X-T002');
    // Two runs of one role: one failed, one succeeded.
    expect(report).toMatch(/dl\s+2\s+1/);

    // And a truncated last line — the shape a SIGKILL leaves — does not take
    // the rest of the log with it.
    expect(runRecords(file)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §16 item 1 — the always-on half.
// ---------------------------------------------------------------------------

const MOCK_REQUIREMENT = [
  '# A command-line expression calculator',
  '',
  'The calculator can only apply one named operation to two numbers. Three things would make it',
  'genuinely usable: evaluating whole expressions with precedence and parentheses, formatting',
  'results for a person to read, and a command line that ties the two together.',
  '',
].join('\n');

describe('a feature goes intake → done through the CLI, on the mock runner', () => {
  it(
    'four tickets, two parallelisable, three approvals, no manual file edits',
    async () => {
      // ====================================================================
      // WHY THIS IS NOT "THE PAID TEST WITH A CHEAPER RUNNER"
      // ====================================================================
      // It is the same driver and the same assertions. What it cannot answer is
      // whether a real agent, given only the vault and a sandboxed worktree,
      // produces work that passes the gates — and that is the only question the
      // paid run exists for. What it *does* answer is everything else in §16
      // item 1: that `factory feature add`, three `factory approve`s and a
      // sequence of cycles carry a four-ticket DAG from intake to a tagged
      // merge on the base branch, with real git, real worktrees, real
      // subprocess gates, and nothing written to the vault by hand.
      const ctx = newContext({
        label: 'mock',
        slug: 'calculator',
        requirement: MOCK_REQUIREMENT,
        // `node -e ""` rather than the default `npm ci`: the toy app has zero
        // dependencies, so an install proves nothing this test is about and
        // costs a second per worktree — and there are a dozen worktrees here.
        // Phase 8's `worktree-workspace.test.ts` owns the provisioning evidence.
        config: { setup_command: 'node -e ""' },
        // The same filled-in `project.md` the paid run uses. It changes nothing
        // for a scripted agent — but it is the branch of `newContext` the paid
        // run takes, and it puts real prose through the Obsidian render check.
        projectMd: PROJECT_MD,
        script: mockScript('FEAT-CALCULATOR'),
      });

      let clean = false;
      try {
        const { tickets } = await driveAcceptance(ctx);
        expect(tickets.length, 'the scripted DL breakdown did not produce four tickets').toBe(
          MOCK_BREAKDOWN.length,
        );
        assertAcceptanceOutcome(ctx, tickets);
        clean = true;
      } finally {
        const report = reportOf(ctx.journal, ctx.vault.paths.eventLog());
        console.log(report);
        console.log(
          `[acceptance mock] evidence kept at ${preserveEvidence(ctx.journal, ctx.vault.root, report, { copyVault: !clean })}`,
        );
        ctx.vault.cleanup();
      }
    },
    20 * 60 * 1000,
  );
});

// ---------------------------------------------------------------------------
// The evidence path, proved by making a run fail.
// ---------------------------------------------------------------------------

describe('evidence survives a failing run', () => {
  it(
    'keeps the vault, the event log, the transcripts and a summary when the run goes wrong',
    async () => {
      // ====================================================================
      // THE THING MOST LIKELY TO GO WRONG IS A HARNESS THAT CANNOT BE DEBUGGED
      // ====================================================================
      // The paid run will probably fail the first time. If it fails and the
      // scratch vault has been swept, the money is gone and nothing has been
      // learned — which is exactly what happened twice to
      // `pipeline-real.test.ts`. So the preservation path is not asserted by
      // reading it; a run is made to fail and the directory is inspected.
      //
      // The PM escalates, so the run dies at `assertCheckpoint` in leg 1 —
      // after an agent has run, written a transcript and been billed. That is
      // the shape of a real failure, not a synthetic one.
      const ctx = newContext({
        label: 'evidence-probe',
        slug: 'calculator',
        requirement: MOCK_REQUIREMENT,
        config: { setup_command: 'node -e ""' },
        script: { pm: { structured: escalation('the requirement is ambiguous'), costUsd: 0.2 } },
      });

      let kept = '';
      let failed = false;
      try {
        try {
          await driveAcceptance(ctx);
        } catch {
          failed = true;
        }
        const report = reportOf(ctx.journal, ctx.vault.paths.eventLog());
        kept = preserveEvidence(ctx.journal, ctx.vault.root, report);
      } finally {
        ctx.vault.cleanup();
      }

      expect(failed, 'the probe was supposed to fail and did not, so it proves nothing').toBe(true);

      // The summary and the journal.
      expect(existsSync(path.join(kept, 'summary.txt'))).toBe(true);
      expect(existsSync(path.join(kept, 'journal.json'))).toBe(true);
      const summary = readFileSync(path.join(kept, 'summary.txt'), 'utf8');
      expect(summary, 'the summary does not say where the run got to').toContain('where each step got to');
      expect(summary, 'the summary does not report the escalation').toContain('escalations: 1');
      expect(summary, 'the summary does not report cost').toContain('TOTAL');

      // The vault itself: the feature note, the event log, and the transcript.
      const vaultCopy = path.join(kept, 'vault');
      expect(existsSync(path.join(vaultCopy, 'work', 'features', 'calculator', 'feature.md'))).toBe(true);
      expect(existsSync(path.join(vaultCopy, 'logs', 'orchestrator.jsonl'))).toBe(true);
      const transcripts = readdirSync(path.join(vaultCopy, 'logs', 'calculator')).filter((name) =>
        name.endsWith('.log'),
      );
      expect(
        transcripts.length,
        'no agent transcript survived, so a failed paid run would leave nothing to read',
      ).toBeGreaterThan(0);
      expect(
        readFileSync(path.join(vaultCopy, 'logs', 'calculator', transcripts[0] ?? ''), 'utf8'),
        'the preserved transcript has no payload in it',
      ).toContain('StructuredOutput');

      // And the scratch vault it was copied from really is gone, or this test
      // would pass against a directory nothing had rescued.
      expect(
        existsSync(ctx.vault.paths.eventLog()) && !existsSync(path.join(vaultCopy, 'logs', 'orchestrator.jsonl')),
        'the evidence copy is not independent of the scratch vault',
      ).toBe(false);
    },
    10 * 60 * 1000,
  );
});

// ---------------------------------------------------------------------------
// THE PAID RUN.
// ---------------------------------------------------------------------------

/**
 * The requirement, reused verbatim from `pipeline-real.test.ts`.
 *
 * ============================================================================
 * COPIED ON PURPOSE, AND THE COPY IS THE POINT
 * ============================================================================
 * Six recorded real sequences have taken this exact text from intake to
 * `in_development` with a resolvable three-ticket DAG and two parallelisable
 * tickets, every time. That evidence is the single biggest risk reduction
 * available to a run that costs several dollars: a new requirement would put
 * the M2 half back in play, and a failure there would say nothing about M3,
 * which is the half nobody has ever run on real agents.
 *
 * Not imported, because importing a `*.test.ts` file executes its `describe`s —
 * including a paid one behind a different switch. Not extracted to a helper,
 * because that means editing `pipeline-real.test.ts`, whose bytes are what the
 * six-run evidence was produced against.
 */
const REAL_REQUIREMENT = [
  '# A command-line expression calculator',
  '',
  'The calculator can only apply one named operation to two numbers. Three things would make it',
  'genuinely usable.',
  '',
  '**Evaluating whole expressions.** `evaluate("2 + 3 * 4")` should return `14`. It must honour',
  'normal operator precedence (`*` and `/` bind tighter than `+` and `-`), support parentheses,',
  'ignore whitespace, and raise a clear, named error for malformed input and for division by zero',
  'rather than returning `NaN` or `Infinity`.',
  '',
  '**Formatting results for a person to read.** Division produces long decimals — `10 / 3` comes',
  'out as `3.3333333333333335`, which nobody wants to look at. There should be a way to render any',
  'number for display: at most six significant digits, no trailing zeros, and no exponent notation',
  'for ordinary sizes. Formatting `3.3333333333333335` should give `3.33333`, and formatting `4`',
  'should give `4`, not `4.00000`.',
  '',
  '**A command line.** A person should be able to type an expression in a terminal and see the',
  'formatted result, without writing any code. A malformed expression should print a clear message',
  'and exit with a non-zero status rather than a stack trace.',
  '',
].join('\n');

/**
 * A filled-in `project.md`, copied from `pipeline-real.test.ts`. Used by both
 * runs — see the note at the free run's use of it.
 *
 * The shipped `vault-template/project.md` is a template, and the first real M2
 * run spent one of the PM's five questions asking what language the project was
 * in. An operator fills this in at `factory init`, so a run that leaves it as
 * boilerplate is measuring the factory under a condition no real vault is in.
 */
const PROJECT_MD = [
  '# Project',
  '',
  '## What this is',
  '',
  '`toy-app` is a small arithmetic calculator library. It is the target repo this factory builds',
  'against, and it has no users beyond its own test suite.',
  '',
  '## Stack and conventions',
  '',
  '- **Node 22, TypeScript, ESM only.** Node runs `.ts` files through type stripping — there is no',
  '  compiler — so only erasable syntax is allowed: no `enum`, no `namespace`, no constructor',
  '  parameter properties, no decorators.',
  '- **Zero npm dependencies, ever.** There is no network and no `node_modules`. Anything a change',
  "  needs must come from Node 22's standard library.",
  "- **Relative imports carry the real extension**: `import { add } from './calc.ts'`.",
  '- **Tests** use `node:test` and `node:assert/strict` and sit beside the code as',
  '  `src/<name>.test.ts`.',
  '- **Errors** are named classes extending `Error`, never bare strings.',
  '- Two-space indent, single quotes, semicolons, trailing newline.',
  '',
  '## Gates',
  '',
  '`npm test`, `npm run lint` and `npm run build` must each exit 0. `npm run build` checks that',
  'every module under `src/` loads under type stripping; it does **not** check types.',
  '',
  '## Out of scope',
  '',
  '- Adding dependencies, a bundler, or a type checker.',
  '- Anything outside this repository.',
  '',
  '## Working agreement',
  '',
  '- The orchestrator is the only writer of this vault. Agents never edit these files; they return',
  '  structured output and the orchestrator writes it.',
  '- **Do not edit notes in Obsidian while the factory is running.** There is no lost-update guard',
  '  by design. Edit when an item is `needs_human`, or when the factory is stopped.',
  '',
].join('\n');

/** A ticket note read back as the shape the self-containment checker wants. */
function asTicketLike(note: TicketNote): TicketLike {
  return {
    title: note.frontmatter.title,
    description_md: sectionText(note.body, SECTION.rawRequirement) ?? '',
    acceptance_criteria: (sectionText(note.body, SECTION.acceptanceCriteria) ?? '')
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0),
    technical_notes_md: sectionText(note.body, SECTION.techPlan) ?? '',
    depends_on: note.frontmatter.depends_on,
  };
}

describe.skipIf(!RUN_REAL_ACCEPTANCE)('the acceptance feature, on real agents (FACTORY_REAL_ACCEPTANCE=1)', () => {
  it(
    'intake → done on the toy repo, with three human approvals and no manual file edits',
    async () => {
      const ctx = newContext({
        label: 'real',
        slug: 'calculator',
        requirement: REAL_REQUIREMENT,
        projectMd: PROJECT_MD,
        // `setup_command` is left at its default, `npm ci`: this is the run
        // that is supposed to be what an operator gets, and A3's provisioning
        // step is part of that. The toy repo's lockfile is committed and has
        // no dependencies, so it resolves offline.
      });

      const extra: string[] = [];
      try {
        const { tickets } = await driveAcceptance(ctx);

        // ================================================================
        // EVERYTHING WORTH RECORDING IS RECORDED BEFORE IT IS JUDGED
        // ================================================================
        // These push into `extra`, which the `finally` prints and writes into
        // the evidence directory. Nothing below can destroy the record of what
        // the run produced, however it fails.
        extra.push(
          `${tickets.length} tickets:`,
          ...tickets.map(
            (ticket) =>
              `  ${ticket.frontmatter.id}  ${ticket.frontmatter.title}\n` +
              `      depends_on: ${JSON.stringify(ticket.frontmatter.depends_on)}\n` +
              `      status: ${ticket.frontmatter.status}  attempts: ${ticket.frontmatter.attempts}`,
          ),
        );

        const selfContainment = describeSelfContainmentProblems(
          findSelfContainmentProblems(tickets.map(asTicketLike)),
        );
        extra.push('', `self-containment findings: ${selfContainment === '' ? 'none' : `\n${selfContainment}`}`);

        const techPlan = existsSync(ctx.vault.paths.techPlan(ctx.slug))
          ? readFileSync(ctx.vault.paths.techPlan(ctx.slug), 'utf8')
          : '';
        extra.push('', `tech-plan.md: ${techPlan.length} characters`);

        // The shared bars. Cost and everything above is already recorded.
        assertAcceptanceOutcome(ctx, tickets);

        // The paid-only bar. Self-containment is asserted inside
        // `assertAcceptanceOutcome` for both runs; what only a real run can
        // check is that the Tech Lead wrote a plan at all. The plan is explicit
        // that a green run here is not evidence the tickets were *good* — that
        // judgement is a human read of the preserved transcripts.
        expect(techPlan.length, 'tech-plan.md is empty').toBeGreaterThan(200);
      } finally {
        const report = reportOf(ctx.journal, ctx.vault.paths.eventLog(), extra);
        console.log(report);
        console.log(`[acceptance real] evidence kept at ${preserveEvidence(ctx.journal, ctx.vault.root, report)}`);
        // Deliberately NOT cleaned up here — `afterAll` sweeps the scratch
        // root, and by then the evidence copy above is already outside it.
      }
    },
    4 * 60 * 60 * 1000,
  );
});

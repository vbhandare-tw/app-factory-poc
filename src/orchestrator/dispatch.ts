/**
 * Loop steps 8–10 (spec §9): claim an item, run the role its state calls for,
 * validate what comes back, apply the transition, persist, regenerate the vault
 * views, release the claim.
 *
 * ============================================================================
 * ONE ATOMIC WRITE PER TRANSITION
 * ============================================================================
 * Crash recovery rests on two properties (spec §9.1): every write is atomic,
 * and every transition is idempotent. The second one is *this file's* job, and
 * it is easy to lose without noticing.
 *
 * The obvious implementation appends the agent's body sections with
 * `storage.appendSection(...)`, then appends a history line with
 * `storage.appendHistory(...)`, then writes the new status. That is three
 * writes. A crash between any two of them leaves the note half-updated, and the
 * re-run after restart appends the same sections and the same history line a
 * second time. A note whose history shows one transition twice looks like a
 * real double-transition to every later reader — the human debugging a stuck
 * ticket, and the context recipes that feed history to agents.
 *
 * So the whole update — body sections, the transition, the history line, the
 * frontmatter fields — is composed **in memory** and written **once**. A crash
 * before the write leaves the note exactly as it was and the role re-runs
 * cleanly; a crash after it leaves the note fully advanced. There is no third
 * state.
 *
 * Files that are not notes (`tech-plan.md`, the ticket notes the DL creates)
 * are written before that single note write, and every one of them is a full
 * overwrite at a deterministic path. A re-run rewrites the same bytes to the
 * same place rather than appending to what a crashed run left behind.
 *
 * ============================================================================
 * SPREAD, NEVER REBUILD
 * ============================================================================
 * Every frontmatter update here goes through `composeNote`, which spreads.
 * `Note<T>` has no type slot for a human's Obsidian-added keys, so a
 * field-by-field rebuild would delete them with no type error at all.
 *
 * ============================================================================
 * COMMIT, THEN GATE — THE PHASE 9 ORDERING
 * ============================================================================
 * The Developer leaves a dirty tree and proposes a message; the orchestrator
 * stages and commits after the agent's process has exited (resolution A6, spec
 * §4.5). Only then do the gates run, in that same worktree, against that commit
 * (spec §9). Reverse the two and the gates verify files the commit leaves
 * behind — anything `git add` skipped, anything a `.gitignore` rule matches —
 * and the ticket advances carrying a commit that does not build. See
 * `./commit.ts`, which is where the ordering is made to *mean* something rather
 * than merely happen in order.
 *
 * And nothing an agent says advances a ticket. `developer.outcome === 'ok'`
 * produces a commit and a gate run, no more (spec §5 rule 2, ADR-004). A red
 * gate bounces the ticket and the Code Reviewer never sees it — `gatesAllGreen`
 * guards the transition, and `runRole` refuses the review and QA roles outright
 * on a ticket whose gates are not green, because a hand-edited note is a way
 * into a state the transition table never granted.
 *
 * ============================================================================
 * WHAT IS NOT HERE
 * ============================================================================
 * Either merge. Phase 10 landed the ticket one: `runMerge` here reaches the
 * decision, but every git operation and the revert live in `./merge.ts`. Phase
 * 11 landed the feature one the same way — `handle` routes a feature at
 * `awaiting_feature_close` into `./featureClose.ts`, which owns the gates on the
 * feature branch, the checkpoint, the base-branch merge and the tag. **The base
 * branch is written from there and nowhere else** (plan Section E item 8), and
 * `mergeTicket` refuses outright when its target is the base branch, which is
 * why the two paths share `Git` and share no code.
 *
 * Five modules were split out of this file before Phase 11, code unchanged:
 * `./dispatchTypes.ts` (every interface the split shares), `./noteWrites.ts`
 * (`composeNote`, `transition`, `persist`, `writeAnyNote`, `refreshViews`),
 * `./roleEffects.ts` (one effect builder per role, plus the markdown-section
 * rendering), `./attemptPolicy.ts` (`recordFailure`, `applyBounce`) and
 * `./workspaces.ts` (`resolveWorkspace`, `ticketWorkspace`, and the two
 * capability predicates). This file keeps the loop itself.
 */
import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { AGENTS, loadSystemPrompt } from '../agents/registry.js';
import { buildContext, RETRY_NOTE_DOC_IDS, SECTION } from '../agents/context.js';
import { profileFor } from '../agents/profiles.js';
import { validateAgentOutput } from '../agents/schemas.js';
import { runId as makeRunId } from '../domain/ids.js';
import { gatesAllGreen } from '../domain/guards.js';
import type { Actor, Role } from '../domain/roles.js';
import type { FeatureState, PauseReason, TicketState, WorkItemState } from '../domain/states.js';
import { canTransition } from '../domain/transitions.js';
import type { TransitionContext } from '../domain/transitions.js';
import type {
  AnyNote,
  FeatureNote,
  IsoTimestamp,
  TicketNote,
} from '../domain/types.js';
import { DEFAULT_GATE_TIMEOUT_MS } from '../gates/runner.js';
import {
  allGatesPassed,
  describeGateFailure,
  renderGateResults,
  toGateSummaries,
} from '../gates/results.js';
import { ticketBranchName } from '../git/paths.js';
import { featureBranchFor } from '../git/workspace.js';
import type { AgentFailure, AgentRunResult, AgentRunSpec } from '../runner/types.js';
import { profileTouchesRepo } from '../runner/types.js';
import { atomicWrite } from '../vault/atomic.js';
import { classifyFailure, describeAttemptFailure, pauseReasonForFailure } from './attempts.js';
import type { AttemptFailure } from './attempts.js';
import { applyBounce, recordFailure } from './attemptPolicy.js';
import { claimItem, releaseClaim } from './claim.js';
import { CHECKPOINTS, checkpointEnabled, pauseItem } from './checkpoints.js';
import { snapshotWorktree } from './commit.js';
import type {
  Actionable,
  DispatchContext,
  DispatchDeps,
  DispatchOutcome,
  RunContext,
} from './dispatchTypes.js';
import { canCloseFeature, runFeatureClose } from './featureClose.js';
import { mergeTicket, renderFeatureGateResults } from './merge.js';
import { composeNote, persist, refreshViews, transition, writeAnyNote } from './noteWrites.js';
import { effectFor, notesSection } from './roleEffects.js';
import {
  canMergeTickets,
  canRunTicketLoop,
  resolveWorkspace,
  ticketWorkspace,
} from './workspaces.js';

// ---------------------------------------------------------------------------
// State → role.
// ---------------------------------------------------------------------------

/**
 * Which agent a feature in this state is waiting for (spec §9 step 9).
 *
 * Only the three M2 roles. `in_development` is a holding state whose work is in
 * its tickets, and the ticket-level roles need worktrees and gates, which are
 * Phases 8 and 9.
 */
export const FEATURE_STATE_ROLES: Readonly<Partial<Record<FeatureState, Role>>> = Object.freeze({
  refining: 'pm',
  planning: 'tl_plan',
  ticketing: 'dl',
});

export function roleForFeatureState(state: FeatureState): Role | null {
  return FEATURE_STATE_ROLES[state] ?? null;
}

/**
 * Which agent a ticket in this state is waiting for (Phase 9).
 *
 * `gates` and `merge` are absent because no agent runs there: gates are
 * orchestrator child processes (ADR-004) and the merge is Phase 10. Being
 * absent from this table is what makes "no agent can override a gate" a
 * property of the code rather than a promise in a comment.
 */
export const TICKET_STATE_ROLES: Readonly<Partial<Record<TicketState, Role>>> = Object.freeze({
  in_progress: 'developer',
  code_review: 'code_reviewer',
  qa: 'qa',
});

export function roleForTicketState(state: TicketState): Role | null {
  return TICKET_STATE_ROLES[state] ?? null;
}

/**
 * Ticket states this file will dispatch, given a git handle and a gate runner.
 *
 * `backlog` is not here: it is actionable through the DAG resolver instead,
 * which is the only thing that knows whether its dependencies are done.
 */
export const DISPATCHABLE_TICKET_STATES: readonly TicketState[] = Object.freeze([
  'ready',
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
]);

// ---------------------------------------------------------------------------
// The attempt policy.
// ---------------------------------------------------------------------------

/**
 * The policy itself now lives in `./attempts.ts` (plan Phase 7b), which is also
 * where Phase 9 adds gate failures and the `max_attempts` off-by-one. Both are
 * re-exported so that "what does a failure cost" can still be asked of the file
 * that acts on the answer, and so no existing caller had to be edited to move
 * the code.
 */
export { failureConsumesAttempt, pauseReasonForFailure } from './attempts.js';

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

export async function dispatchItem(
  deps: DispatchDeps,
  item: Actionable,
  context: DispatchContext,
): Promise<DispatchOutcome> {
  const claim = await claimItem(deps.storage, item.path, deps.ownerId, { now: deps.now() });
  if (!claim.won) {
    await deps.events?.emit({
      type: 'claim_lost',
      itemId: item.id,
      reason: claim.reason ?? 'unknown',
    });
    return { itemId: item.id, claimed: false, ran: null, from: item.stage, to: null, paused: false };
  }
  await deps.events?.emit({ type: 'claim_won', itemId: item.id, ownerId: deps.ownerId });

  // The claim read-back is the freshest truth about this note; work from it
  // rather than from what the scan saw a moment earlier.
  const claimed = { ...item, note: claim.note as AnyNote };

  try {
    return await handle(deps, claimed, context);
  } finally {
    await releaseClaim(deps.storage, item.path, deps.ownerId);
    await deps.events?.emit({ type: 'claim_released', itemId: item.id, ownerId: deps.ownerId });
  }
}

async function handle(
  deps: DispatchDeps,
  item: Actionable,
  context: DispatchContext,
): Promise<DispatchOutcome> {
  if (item.kind === 'ticket') return await handleTicket(deps, item, context);

  if (item.stage === 'intake') {
    return await plainTransition(deps, item, 'refining', 'orchestrator', {});
  }

  // The feature half of Phase 10. `in_development` has no agent role — its work
  // is in its tickets — so it needs a branch of its own here, or the state is
  // reachable and permanently terminal. `allTicketsDone` is the guard on the
  // transition itself, so a feature whose tickets are not all done is refused by
  // the rulebook rather than by a second opinion written here.
  if (item.stage === 'in_development') {
    return await plainTransition(deps, item, 'awaiting_feature_close', 'orchestrator', {
      tickets: context.tickets,
    });
  }

  // The feature half of Phase 11. Like `in_development`, `awaiting_feature_close`
  // has no agent role, and unlike it the move out is not a plain transition: the
  // gates have to run on the feature branch first and a human has to say yes.
  // All of that lives in `./featureClose.ts` — see this file's header.
  if (item.stage === 'awaiting_feature_close') {
    if (!canCloseFeature(deps)) {
      // Deliberately an idle rather than offering a human an approval backed by
      // no gate run, or merging into the base branch unverified.
      return idle(
        item,
        'the feature close needs a git handle, a gate runner and somewhere to run the ' +
          'feature-branch gates, and this dispatcher is missing at least one',
      );
    }
    return await runFeatureClose(deps, item, context);
  }

  const role = roleForFeatureState(item.stage as FeatureState);
  if (role === null) return idle(item, 'no agent role owns this feature state in M1–M3');

  return await runRole(deps, item, role);
}

/**
 * The ticket half of the state machine (spec §3.3, §9).
 *
 * `backlog → ready` is Phase 7a's; everything below it is Phase 9's. The two
 * are in one switch rather than two functions because "which of these does the
 * orchestrator handle" is one question, and answering it in two places is how a
 * state ends up handled by neither.
 */
async function handleTicket(
  deps: DispatchDeps,
  item: Actionable,
  context: DispatchContext,
): Promise<DispatchOutcome> {
  const stage = item.stage as TicketState;

  if (stage === 'backlog') {
    return await plainTransition(deps, item, 'ready', 'orchestrator', {
      tickets: context.tickets,
    });
  }

  if (!DISPATCHABLE_TICKET_STATES.includes(stage)) {
    return idle(item, `no handler for a ticket in ${stage}`);
  }

  if (!canRunTicketLoop(deps)) {
    // See `DispatchDeps.git`. Not a refusal in the safety sense — nothing unsafe
    // would happen — but a ticket that advanced to `gates` with no gate runner
    // would sit there being re-scanned forever, so it is better to say so.
    return idle(
      item,
      'the ticket loop needs a git handle and a gate runner, and this dispatcher has neither',
    );
  }

  if (stage === 'ready') {
    return await plainTransition(deps, item, 'in_progress', 'orchestrator', {});
  }

  if (stage === 'gates') return await runGates(deps, item);

  if (stage === 'merge') {
    if (!canMergeTickets(deps)) {
      // Deliberately an idle rather than a merge in the operator's checkout with
      // gates run wherever. See `canMergeTickets`.
      return idle(
        item,
        'the ticket merge needs somewhere to run the feature-branch gates, and this dispatcher ' +
          'has no featureWorkspace provider',
      );
    }
    return await runMerge(deps, item);
  }

  const role = roleForTicketState(stage);
  if (role === null) return idle(item, `no agent role owns a ticket in ${stage}`);

  // ============================================================================
  // THE HARD GATE (requirements §6.2, plan Section E item 3)
  // ============================================================================
  // The transition table already refuses `gates → code_review` unless every gate
  // passed. This is the second lock on the same door, and it is not redundant:
  // the vault is a documented human editing surface (ADR-001), so a ticket can
  // arrive in `code_review` because somebody typed it there. Checking here means
  // the reviewer's Runner is never *invoked* on a red ticket, rather than being
  // invoked and then having its verdict discarded — which would burn money and
  // show a red ticket to an agent that must never see one.
  if (role === 'code_reviewer' || role === 'qa') {
    const verdict = gatesAllGreen(item.note as TicketNote);
    if (!verdict.ok) {
      return await refuseEffect(
        deps,
        item,
        role,
        `refusing to run the ${role} agent on ${item.id}: ${verdict.reason}. A red gate always ` +
          'bounces a ticket and no role, verdict or config flag may override it (ADR-004, plan ' +
          'Section E item 3). Send the ticket back to in_progress to have the gates re-run.',
        item.note.frontmatter.cost_usd,
        deps.now(),
      );
    }
  }

  if (role === 'code_reviewer') {
    // The reviewer's recipe requires the diff and the agent cannot read git
    // itself. Computed before the throwaway worktree is provisioned, so an
    // empty one costs nothing: an empty diff means the branch carries no change,
    // which is a broken ticket rather than an approvable one.
    const diff = await reviewDiff(deps, item);
    if (diff.trim() === '') {
      return await refuseEffect(
        deps,
        item,
        role,
        `refusing to review ${item.id}: its branch carries no change against the feature branch, ` +
          'so there is nothing to review. The Developer’s commit is missing or was made on ' +
          'another branch.',
        item.note.frontmatter.cost_usd,
        deps.now(),
      );
    }
    return await runRole(deps, item, role, { diff });
  }

  return await runRole(deps, item, role);
}

/** `git diff <feature-branch>...<ticket-branch>` — the change under review. */
async function reviewDiff(deps: DispatchDeps, item: Actionable): Promise<string> {
  const git = deps.git;
  if (git === undefined) return '';
  const ticket = item.note as TicketNote;
  const branch =
    ticket.frontmatter.branch ??
    ticketBranchName(item.slug, item.id, ticket.frontmatter.title);
  const base = await featureBranchFor(
    { config: deps.config, paths: deps.paths, storage: deps.storage },
    item.slug,
  );
  return await git.diff(base, branch);
}

function idle(item: Actionable, reason: string): DispatchOutcome {
  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: null,
    paused: false,
    reason,
  };
}

/** A transition with no agent behind it. Still one atomic write. */
async function plainTransition(
  deps: DispatchDeps,
  item: Actionable,
  to: WorkItemState,
  actor: Actor,
  ctx: TransitionContext,
): Promise<DispatchOutcome> {
  const verdict = canTransition(item.note, to, actor, ctx);
  if (!verdict.ok) return idle(item, verdict.reason);

  const now = deps.now();
  const next = transition(item.note, to, actor, now, ctx);
  await persist(deps, item, next, to, actor, now);
  return { itemId: item.id, claimed: true, ran: null, from: item.stage, to, paused: false };
}

// ---------------------------------------------------------------------------
// Running an agent.
// ---------------------------------------------------------------------------

async function runRole(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  /** Computed before the workspace exists — today only the reviewer's diff. */
  prepared: { readonly diff?: string } = {},
): Promise<DispatchOutcome> {
  const diff = prepared.diff;
  const definition = AGENTS[role];
  const profile = profileFor(role, deps.config);
  const attempt = item.note.frontmatter.attempts + 1;

  // `ticketId` is what tells the provider which worktree this run belongs in.
  // Without it a `developer` or `qa` run would ask for "the worktree for
  // FEAT-X", which is a feature, and get one built from the wrong branch.
  const workspace = await resolveWorkspace(deps, {
    role,
    itemId: item.id,
    featureSlug: item.slug,
    ...(item.kind === 'ticket' ? { ticketId: item.id } : {}),
  });
  if (profileTouchesRepo(profile) && deps.workspace === undefined) {
    await deps.events?.emit({
      type: 'workspace_unprovisioned',
      itemId: item.id,
      role,
      cwd: workspace.cwd,
    });
  }

  try {
    // ========================================================================
    // THE PRE-RUN SNAPSHOT — see `./commit.ts`
    // ========================================================================
    // Taken here, after the worktree is provisioned (so `setup_command` has
    // already run and its install output is *in* the snapshot) and before the
    // agent starts. Everything the commit stages is measured against this, which
    // is what keeps `npm ci`'s output — and anything else that was already
    // sitting in the tree — out of the ticket branch.
    const snapshot =
      role === 'developer' && deps.git !== undefined
        ? await snapshotWorktree(deps.git, workspace.cwd)
        : undefined;

    // The schema-retry loop (plan Phase 7b, `./attempts.ts`). At most
    // `FREE_SCHEMA_RETRIES + 1` runs, all inside one attempt: a first schema
    // failure is re-run with the validator's own words in the prompt and costs
    // nothing but the run itself.
    //
    // `carriedCostUsd` is why the loop cannot simply `continue` and forget: a
    // forgiven run is free of *attempts*, not free of money. Dropping its cost
    // would make `cost_usd` on the note understate what the item actually spent,
    // and that field is the only per-item spend record there is.
    let schemaFailuresForgiven = 0;
    let retryGuidance: string | undefined;
    let carriedCostUsd = 0;

    for (;;) {
      const built = await buildContext(definition.recipe, {
        storage: deps.storage,
        paths: deps.paths,
        featureSlug: item.slug,
        repoRoot: deps.config.target_repo,
        attempt,
        maxChars: deps.config.context_warn_chars,
        task: taskFor(role),
        ...(item.kind === 'ticket' ? { ticketId: item.id } : {}),
        ...(diff === undefined ? {} : { diff }),
        ...(retryGuidance === undefined ? {} : { retryGuidance }),
      });

      if (built.report.truncated) {
        await deps.events?.emit({
          type: 'context_truncated',
          itemId: item.id,
          role,
          dropped: built.report.dropped.map((entry) => entry.id),
        });
      }

      // ====================================================================
      // A RETRY THAT CANNOT SEE WHY IT BOUNCED IS A BURNED ATTEMPT
      // ====================================================================
      // `buildContext` drops the lowest-priority droppable document to fit, and
      // the bounce notes are at the bottom of the developer's recipe — so a
      // context over `context_warn_chars` sacrifices exactly the gate output,
      // review findings and QA evidence the retry exists to act on. The drop is
      // recorded, and Phase 8 left this as a debt with an explicit instruction:
      // treat it as escalate-worthy rather than merely logging it.
      //
      // Checked before the run, so it costs nothing. Paying for a run that is
      // about to repeat the previous run's mistake is the failure being avoided.
      const lostNotes = built.report.dropped
        .map((entry) => entry.id)
        .filter((id) => RETRY_NOTE_DOC_IDS.includes(id));

      if (lostNotes.length > 0) {
        return await refuseEffect(
          deps,
          item,
          role,
          `refusing to re-run the ${role} agent on ${item.id}: its context is over ` +
            `${String(deps.config.context_warn_chars)} characters, so ${lostNotes.join(', ')} — ` +
            'the record of why the previous attempt bounced — was dropped to make it fit. The ' +
            'run would repeat the mistake it was sent back to fix. Trim the ticket or the tech ' +
            'plan, or raise context_warn_chars, then approve.',
          item.note.frontmatter.cost_usd,
          deps.now(),
        );
      }

      const variant = schemaFailuresForgiven === 0 ? undefined : `schema-retry${schemaFailuresForgiven}`;
      const spec: AgentRunSpec = {
        runId: makeRunId(item.id, role, attempt, deps.nextCounter()),
        role,
        cwd: workspace.cwd,
        prompt: built.prompt,
        systemPromptAppend: await loadSystemPrompt(role),
        profile,
        outputSchema: definition.jsonSchema,
        model: deps.config.models[role],
        transcriptPath: deps.paths.logPath(item.slug, item.id, attempt, role, variant),
        itemId: item.id,
        featureSlug: item.slug,
        attempt,
        validateStructured: (value: unknown) => validateAgentOutput(role, value),
      };

      const signal = deps.signal ?? new AbortController().signal;
      const result = await deps.runner.run(spec, signal);

      await deps.hooks?.crash?.('after_run', { itemId: item.id, role });

      // A schema failure reaches here by two routes and they must be treated
      // identically. `ClaudeCodeRunner` runs `validateStructured` itself and
      // reports `failure: 'schema'` with `schemaIssues`; `MockRunner` does not
      // validate at all, so a canned bad payload arrives as a *successful* run
      // that this function's own `validateAgentOutput` then rejects. Handling
      // only one of them would make the rule real against the real CLI and
      // absent in every mock test, or the reverse.
      const failure: AgentFailure | undefined = result.ok
        ? validationFailure(role, result.structured)
        : (result.failure ?? 'crash');
      const issues = result.ok
        ? validationIssues(role, result.structured)
        : (result.schemaIssues ?? []);

      if (failure === undefined) {
        await warnIfPayloadLarge(deps, item, role, result.structured);
        return await applyRoleOutput(deps, item, role, result, carriedCostUsd, {
          ...(snapshot === undefined ? {} : { snapshot }),
          workspaceCwd: workspace.cwd,
          attempt,
        });
      }

      const disposition = classifyFailure({ failure, role, schemaFailuresForgiven, issues });

      if (disposition.kind === 'retry_in_place') {
        schemaFailuresForgiven += 1;
        carriedCostUsd += result.costUsd;
        retryGuidance = disposition.guidance;
        await deps.events?.emit({
          type: 'schema_retry',
          itemId: item.id,
          role,
          attempt,
          issues: [...issues],
          costUsd: result.costUsd,
        });
        continue;
      }

      return await recordFailure(
        deps,
        item,
        role,
        result,
        failure,
        issues.length === 0 ? undefined : issues.join('; '),
        carriedCostUsd,
      );
    }
  } finally {
    await workspace.dispose?.();
  }
}

/**
 * The size of what came back, measured the way the CLI had to carry it.
 *
 * Exported so a test can measure a payload without reproducing the encoding
 * choice — `JSON.stringify` is the number that matters, because that is the
 * form the `StructuredOutput` tool call actually transmits, and a count of the
 * markdown fields alone would understate it by the JSON escaping.
 */
export function payloadChars(structured: unknown): number {
  try {
    return JSON.stringify(structured)?.length ?? 0;
  } catch {
    // A payload that cannot be stringified is not a size problem, and it will
    // have failed validation long before this. Never let measurement throw.
    return 0;
  }
}

/**
 * Warn, once per accepted payload, when it is getting close to the size at
 * which the CLI's `StructuredOutput` mechanism starts failing.
 *
 * Deliberately not a refusal — see `config.payload_warn_chars`. The payload has
 * already been paid for and is valid; the only useful response is to make the
 * number visible while it is still merely large.
 */
async function warnIfPayloadLarge(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  structured: unknown,
): Promise<void> {
  const chars = payloadChars(structured);
  const limitChars = deps.config.payload_warn_chars;
  if (chars <= limitChars) return;

  await deps.events?.emit({
    type: 'payload_large',
    itemId: item.id,
    role,
    chars,
    limitChars,
  });
}

/** `'schema'` when the orchestrator's own re-validation rejects the payload. */
function validationFailure(role: Role, structured: unknown): AgentFailure | undefined {
  return validateAgentOutput(role, structured).ok ? undefined : 'schema';
}

function validationIssues(role: Role, structured: unknown): readonly string[] {
  const validation = validateAgentOutput(role, structured);
  return validation.ok ? [] : validation.issues;
}

function taskFor(role: Role): string {
  switch (role) {
    case 'pm':
      return 'Refine the requirement above into something a Tech Lead can plan against.';
    case 'tl_plan':
      return 'Produce the technical plan for the refined requirement above.';
    case 'dl':
      return 'Break the technical plan above into self-contained tickets.';
    case 'developer':
      return 'Implement the ticket above.';
    case 'code_reviewer':
      return 'Review the change above.';
    case 'qa':
      return "Verify the ticket's acceptance criteria above.";
    default: {
      const unreachable: never = role;
      throw new Error(`no task text for role ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Applying a successful role output.
// ---------------------------------------------------------------------------

async function applyRoleOutput(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  result: AgentRunResult,
  /** Money already spent on forgiven runs in this dispatch. See `runRole`. */
  carriedCostUsd = 0,
  run: RunContext = {},
): Promise<DispatchOutcome> {
  const payload = result.structured as { outcome: string; escalate_reason: string | null; notes_markdown: string };
  const now = deps.now();
  const spentNow = carriedCostUsd + result.costUsd;
  const costUsd = item.note.frontmatter.cost_usd + spentNow;

  await deps.events?.emit({
    type: 'cost_recorded',
    itemId: item.id,
    costUsd: spentNow,
    totalUsd: costUsd,
  });

  // Spec §5 rule 3. An escalation is the agent saying it cannot do the job;
  // nothing it produced is applied, because it just told us not to trust it.
  if (payload.outcome === 'escalate') {
    const detail = payload.escalate_reason ?? 'the agent escalated without giving a reason';
    const paused = pauseItem(
      composeNote({
        note: item.note,
        sections: notesSection(payload.notes_markdown),
        frontmatter: { cost_usd: costUsd },
      }),
      {
        reason: 'escalation',
        detail,
        // Approve re-runs the same role once the human has fixed whatever the
        // agent was stuck on. Reject has no meaning here — see the same note in
        // `recordFailure`.
        resumeTo: item.stage,
        rejectTo: null,
        now,
        actor: role,
        historyNote: `escalation: ${detail}`,
      },
    );

    await writeAnyNote(deps.storage, item.path, paused);
    await deps.events?.emit({
      type: 'item_paused',
      itemId: item.id,
      pauseReason: 'escalation',
      detail,
      resumeTo: item.stage,
      rejectTo: null,
    });
    await refreshViews(deps);
    await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });

    return {
      itemId: item.id,
      claimed: true,
      ran: role,
      from: item.stage,
      to: 'needs_human',
      paused: true,
      reason: detail,
    };
  }

  const effect = await effectFor(deps, item, role, result.structured, run);

  if (effect.refuse !== undefined) {
    return await refuseEffect(deps, item, role, effect.refuse, costUsd, now);
  }

  // A bounce writes the evidence and the attempt count in the same write as the
  // move, so there is no window in which the note says "reviewed" but not "and
  // it asked for changes".
  if (effect.bounce !== undefined) {
    return await applyBounce(deps, item, role, effect, effect.bounce, costUsd, now);
  }

  for (const [file, contents] of effect.files ?? []) {
    await atomicWrite(file, contents);
  }
  // Delete first, then write. A crash in between leaves the feature with no
  // tickets at all under a `ticketing` status, and the re-run recreates them —
  // which is recoverable. Writing first and deleting after would, on a crash,
  // leave the previous breakdown's extras behind permanently.
  for (const stale of effect.removeTicketFiles ?? []) {
    await unlink(stale).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
  }
  for (const ticket of effect.tickets ?? []) {
    await deps.storage.writeNote(deps.paths.ticketPath(item.slug, ticket.frontmatter.id), ticket);
  }
  if ((effect.removeTicketFiles ?? []).length > 0) {
    await deps.events?.emit({
      type: 'tickets_replaced',
      featureId: item.id,
      removed: (effect.removeTicketFiles ?? []).map((file) => path.basename(file, '.md')).sort(),
    });
  }
  if ((effect.tickets ?? []).length > 0) {
    await deps.events?.emit({
      type: 'tickets_created',
      featureId: item.id,
      ticketIds: (effect.tickets ?? []).map((ticket) => ticket.frontmatter.id),
    });
  }

  await deps.hooks?.crash?.('after_side_files', { itemId: item.id, role });

  const staged = composeNote({
    note: item.note,
    sections: effect.sections,
    frontmatter: { cost_usd: costUsd, ...(effect.frontmatter ?? {}) },
  });

  const usesCheckpoint =
    effect.checkpoint !== undefined && checkpointEnabled(deps.config, effect.checkpoint);

  if (usesCheckpoint && effect.checkpoint !== undefined) {
    const spec = CHECKPOINTS[effect.checkpoint];
    const paused = pauseItem(staged, {
      reason: 'checkpoint',
      detail: spec.description,
      resumeTo: spec.resumeTo,
      rejectTo: spec.rejectTo,
      now,
      actor: 'orchestrator',
      historyNote: `checkpoint ${spec.name}`,
    });

    await writeAnyNote(deps.storage, item.path, paused);
    await deps.events?.emit({
      type: 'item_paused',
      itemId: item.id,
      pauseReason: 'checkpoint',
      detail: spec.description,
      resumeTo: spec.resumeTo,
      rejectTo: spec.rejectTo,
    });
    await refreshViews(deps);
    await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });

    return {
      itemId: item.id,
      claimed: true,
      ran: role,
      from: item.stage,
      to: 'needs_human',
      paused: true,
    };
  }

  const next = transition(staged, effect.to, effect.actor, now, {}, effect.historyNote);
  await persist(deps, item, next, effect.to, effect.actor, now, role, effect.historyNote);

  return {
    itemId: item.id,
    claimed: true,
    ran: role,
    from: item.stage,
    to: effect.to,
    paused: false,
  };
}

/**
 * Pause an item because the orchestrator will not apply what the agent
 * returned. Distinct from an agent escalation only in who noticed.
 */
async function refuseEffect(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  detail: string,
  costUsd: number,
  now: IsoTimestamp,
): Promise<DispatchOutcome> {
  const paused = pauseItem(
    composeNote({ note: item.note, frontmatter: { cost_usd: costUsd } }),
    {
      reason: 'escalation',
      detail,
      resumeTo: item.stage,
      rejectTo: null,
      now,
      actor: 'orchestrator',
      historyNote: `refused ${role} output: ${detail}`,
    },
  );

  await writeAnyNote(deps.storage, item.path, paused);
  await deps.events?.emit({
    type: 'item_paused',
    itemId: item.id,
    pauseReason: 'escalation',
    detail,
    resumeTo: item.stage,
    rejectTo: null,
  });
  await refreshViews(deps);
  await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });

  return {
    itemId: item.id,
    claimed: true,
    ran: role,
    from: item.stage,
    to: 'needs_human',
    paused: true,
    reason: detail,
  };
}

// ---------------------------------------------------------------------------
// The ticket loop: developer → gates → code_review → qa (Phase 9).
// ---------------------------------------------------------------------------

/**
 * Run the gates against the committed state, and act on the exit codes.
 *
 * No agent is involved and none can be: this is reached from the `gates` state,
 * which has no row in `TICKET_STATE_ROLES`. The gates are orchestrator child
 * processes outside the sandbox (spec §8.2, ADR-004), and their exit codes are
 * the only thing that advances the ticket.
 *
 * Everything the run produced — the three summaries in frontmatter, the rendered
 * section in the body, the transition, and (on a red gate) the attempt count —
 * lands in **one** write. Gate results written as a follow-up would leave a
 * window in which the ticket says `code_review` and carries no evidence of why.
 */
async function runGates(deps: DispatchDeps, item: Actionable): Promise<DispatchOutcome> {
  const git = deps.git;
  const gates = deps.gates;
  if (git === undefined || gates === undefined) {
    return idle(item, 'no gate runner is available');
  }

  const ticket = item.note as TicketNote;
  const attempt = ticket.frontmatter.attempts + 1;

  const workspace = await ticketWorkspace(deps, item);
  const commitSha = await git.revParse(workspace.cwd, 'HEAD');

  const results = await gates.run(workspace.cwd, deps.config.gates, {
    logPathFor: (gate) => deps.paths.gateLogPath(item.slug, item.id, attempt, gate),
    maxOutputChars: deps.config.gate_output_chars,
    timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
    onGateFinished: async (gate, result) => {
      await deps.events?.emit({
        type: 'gate_result',
        itemId: item.id,
        gate,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
      });
    },
  });

  // Nothing has been written yet — the same window the agent roles have, and the
  // reason a crash here re-runs the gates rather than trusting a partial result.
  await deps.hooks?.crash?.('after_run', { itemId: item.id, role: null });

  const green = allGatesPassed(results);
  const detail = describeGateFailure(results);

  await deps.events?.emit({
    type: 'gates_finished',
    itemId: item.id,
    attempt,
    green,
    commitSha,
    detail,
  });

  const sections: Array<readonly [string, string]> = [
    [SECTION.gateResults, renderGateResults(results, { attempt, ...(commitSha === null ? {} : { commitSha }) })],
  ];
  const frontmatter = { gate_results: toGateSummaries(results) };

  if (!green) {
    return await applyBounce(
      deps,
      item,
      null,
      { sections, frontmatter },
      {
        failure: 'gate',
        to: 'in_progress',
        actor: 'orchestrator',
        detail:
          `${detail} on ${item.id}, attempt ${String(attempt)}` +
          (commitSha === null ? '' : ` (commit ${commitSha.slice(0, 8)})`) +
          `. Gate log: ${gateLogsOf(results)}. Developer transcript: ` +
          `${deps.paths.logPath(item.slug, item.id, attempt, 'developer')}`,
      },
      item.note.frontmatter.cost_usd,
      deps.now(),
    );
  }

  const now = deps.now();
  const staged = composeNote({ note: item.note, sections, frontmatter });
  // `canTransition`'s `gatesAllGreen` guard reads `gate_results` off the note it
  // is given, so the staged note — the one carrying the results just produced —
  // is what it must see. Handing it `item.note` would ask the guard about the
  // previous attempt.
  const next = transition(staged, 'code_review', 'orchestrator', now, {}, 'gates green');
  await persist(deps, item, next, 'code_review', 'orchestrator', now, null, 'gates green');

  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: 'code_review',
    paused: false,
  };
}

/**
 * The log paths of the gates that did not pass.
 *
 * Named in `pause_detail` rather than left to "see the ticket": a ticket parked
 * after three red gate runs is read by a human whose next question is "what
 * broke", and an answer that is one `cat` away beats one that is a hunt.
 */
function gateLogsOf(results: Parameters<typeof describeGateFailure>[0]): string {
  const paths = Object.values(results)
    .filter((result) => result.status === 'fail' && result.logPath !== '')
    .map((result) => result.logPath);
  return paths.length === 0 ? '(none written)' : paths.join(', ');
}

// ---------------------------------------------------------------------------
// The ticket merge (Phase 10).
// ---------------------------------------------------------------------------

/**
 * Merge a verified ticket into its feature branch (spec §10, ADR-004).
 *
 * No agent is involved and none can be: `merge` has no row in
 * `TICKET_STATE_ROLES`, exactly as `gates` has none. The decisions all live in
 * `./merge.ts`; this function is the part that turns an outcome into a note, in
 * one write, on every branch.
 *
 * **`mergeClean` and `featureBranchGatesGreen` are threaded into the transition
 * context here.** `mergeVerified` refuses `merge → done` without both, and
 * nothing else in the system sets them. That is deliberate (Phase 2's ledger row
 * says so by name): the guard fails toward a stuck ticket rather than toward a
 * `done` that nobody verified, so the only way to satisfy it is to have actually
 * done the merge and actually run the gates.
 */
async function runMerge(deps: DispatchDeps, item: Actionable): Promise<DispatchOutcome> {
  const git = deps.git;
  const gates = deps.gates;
  const featureWorkspace = deps.featureWorkspace;
  if (git === undefined || gates === undefined || featureWorkspace === undefined) {
    return idle(item, 'no merge capability is available');
  }

  const ticket = item.note as TicketNote;
  const attempt = ticket.frontmatter.attempts + 1;
  const ticketBranch =
    ticket.frontmatter.branch ?? ticketBranchName(item.slug, item.id, ticket.frontmatter.title);
  const featureBranch = await featureBranchFor(
    { config: deps.config, paths: deps.paths, storage: deps.storage },
    item.slug,
  );

  const outcome = await mergeTicket({
    git,
    gates,
    config: deps.config,
    paths: deps.paths,
    featureWorkspace,
    ...(deps.events === undefined ? {} : { events: deps.events }),
    ticketId: item.id,
    featureSlug: item.slug,
    ticketBranch,
    featureBranch,
    attempt,
    worktreePath: ticket.frontmatter.worktree,
  });

  // Nothing has been written yet — the same window every other dispatch has, and
  // the reason a crash here re-runs the merge rather than trusting a half-record.
  await deps.hooks?.crash?.('after_run', { itemId: item.id, role: null });

  const now = deps.now();

  if (outcome.kind === 'merged') {
    const staged = composeNote({
      note: item.note,
      sections: [
        [
          SECTION.gateResults,
          renderFeatureGateResults(outcome.results, {
            branch: featureBranch,
            sha: outcome.sha,
            attempt,
          }),
        ],
      ],
      frontmatter: outcome.worktreeRemoved ? { worktree: null } : {},
    });

    const historyNote =
      `merged ${outcome.sha.slice(0, 8)} into ${featureBranch}` +
      (outcome.branchDeleted ? `, ${ticketBranch} deleted` : '');

    const next = transition(
      staged,
      'done',
      'orchestrator',
      now,
      // See the function's own note. Without these two the guard refuses.
      { mergeClean: true, featureBranchGatesGreen: true },
      historyNote,
    );
    await persist(deps, item, next, 'done', 'orchestrator', now, null, historyNote);

    return {
      itemId: item.id,
      claimed: true,
      ran: null,
      from: item.stage,
      to: 'done',
      paused: false,
    };
  }

  if (outcome.kind === 'conflict') {
    // An empty list is not a content conflict at all — git refused the merge for
    // some other reason, most often an untracked file in the main checkout that
    // the merge would overwrite. The label stays `merge_conflict` (spec §9.1
    // names it, and `PAUSE_REASONS` is a closed domain constant), so the detail
    // has to say plainly that there are no conflict markers to go looking for.
    const named = outcome.conflicts.length > 0;
    const conflicts = named
      ? `Conflicted paths: ${outcome.conflicts.join(', ')}.`
      : 'git named **no conflicted paths**, so nothing has conflict markers in it — the merge ' +
        'was refused for another reason, and the most common one is an untracked file in ' +
        `${deps.config.target_repo} that the merge would have overwritten. Read git's own ` +
        'message below.';
    return await pauseAtMerge(deps, item, now, 'merge_conflict', {
      detail:
        `${describeAttemptFailure('merge_conflict')}: ${ticketBranch} does not merge cleanly into ` +
        `${featureBranch}. ${conflicts} The merge was aborted, so the ` +
        'repository holds no half-merged state. No agent resolves this (ADR-004): rebase or fix ' +
        'the ticket branch by hand and approve, or reject to send the ticket back to a ' +
        `Developer.\n\n${outcome.detail}`,
      section: [
        SECTION.notes,
        `**Merge conflict** — \`${ticketBranch}\` → \`${featureBranch}\`.\n\n` +
          (named
            ? `Conflicted paths:\n\n${outcome.conflicts.map((file) => `- \`${file}\``).join('\n')}`
            : 'git named no conflicted paths. Nothing in the repository has conflict markers ' +
              `in it; see \`pause_detail\` for git's own message.`),
      ],
    });
  }

  if (outcome.kind === 'gates_red') {
    const undone = outcome.reverted
      ? `The merge has been undone: ${featureBranch} is back at ${outcome.beforeSha}, and the ` +
        `merge commit ${outcome.mergeSha} is no longer on it. Nothing was lost — ${ticketBranch} ` +
        'still carries every commit.'
      : `**The merge could not be undone** (${outcome.revertError ?? 'no reason recorded'}), so ` +
        `${featureBranch} is still at ${outcome.mergeSha} and still fails its own gates. Reset it ` +
        `to ${outcome.beforeSha} by hand before any other ticket merges.`;

    return await pauseAtMerge(deps, item, now, 'merge_gates', {
      detail:
        `${describeAttemptFailure('merge_gates')}: ${item.id} passed its own gates, and after ` +
        `merging into ${featureBranch} the branch gates went red — ${outcome.detail}. ${undone}`,
      section: [
        SECTION.gateResults,
        renderFeatureGateResults(outcome.results, {
          branch: featureBranch,
          sha: outcome.mergeSha,
          attempt,
        }),
      ],
    });
  }

  await deps.events?.emit({ type: 'merge_refused', itemId: item.id, detail: outcome.detail });
  // `null` because nothing was attempted: no merge, no gates, nothing to name as
  // a failure kind. The repository was not touched at all.
  return await pauseAtMerge(deps, item, now, null, {
    detail: `refusing to merge ${item.id}: ${outcome.detail}`,
  });
}

/**
 * Park a ticket that could not be merged.
 *
 * `resumeTo` is `merge`, not `in_progress`: a human who fixes the feature branch
 * or the conflict wants the merge retried, and `needs_human → merge` is already
 * in the transition table. `rejectTo` is `in_progress`, for the other answer —
 * send it back to a Developer to redo the work against the branch as it now is.
 * Neither needs a new transition rule, which is exactly why they are these two.
 */
async function pauseAtMerge(
  deps: DispatchDeps,
  item: Actionable,
  now: IsoTimestamp,
  /** `null` when nothing was attempted, so there is no failure kind to name. */
  failure: AttemptFailure | null,
  options: {
    readonly detail: string;
    readonly section?: readonly [heading: string, markdown: string];
  },
): Promise<DispatchOutcome> {
  const pauseReason: PauseReason =
    failure === null ? 'escalation' : pauseReasonForFailure(failure);
  const historyNote = failure === null ? 'refused to merge' : `${pauseReason}: ${failure}`;

  // No attempt is charged. See `FREE_FAILURES` in `./attempts.ts`: there is no
  // retry for a merge failure, so the count would be a number nobody acts on.
  const paused = pauseItem(
    composeNote({
      note: item.note,
      sections: options.section === undefined ? [] : [options.section],
    }),
    {
      reason: pauseReason,
      detail: options.detail,
      resumeTo: 'merge',
      rejectTo: 'in_progress',
      now,
      actor: 'orchestrator',
      historyNote,
    },
  );

  await writeAnyNote(deps.storage, item.path, paused);
  await deps.events?.emit({
    type: 'item_paused',
    itemId: item.id,
    pauseReason,
    detail: options.detail,
    resumeTo: 'merge',
    rejectTo: 'in_progress',
  });
  await refreshViews(deps);
  await deps.hooks?.crash?.('after_persist', { itemId: item.id, role: null });

  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: 'needs_human',
    paused: true,
    reason: options.detail,
  };
}

/** Narrowing helpers, exported for the loop's actionable-set computation. */
export function asFeatureNote(note: AnyNote): FeatureNote {
  return note as FeatureNote;
}

export function asTicketNote(note: AnyNote): TicketNote {
  return note as TicketNote;
}

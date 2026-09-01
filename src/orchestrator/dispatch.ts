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
 * WHAT IS NOT HERE
 * ============================================================================
 * Worktrees (Phase 8), gates and the developer/review/QA loop (Phase 9), and
 * merges (Phases 10–11). Phase 7a dispatches the feature-level roles only, on
 * `MockRunner`, and the states it does not own are simply not actionable.
 */
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { AGENTS, loadSystemPrompt } from '../agents/registry.js';
import { buildContext, SECTION } from '../agents/context.js';
import { profileFor } from '../agents/profiles.js';
import { validateAgentOutput } from '../agents/schemas.js';
import type {
  DlOutput,
  PmOutput,
  TlPlanOutput,
} from '../agents/schemas.js';
import type { FactoryConfig } from '../config/schema.js';
import { featureId as toFeatureId, runId as makeRunId, ticketId as makeTicketId } from '../domain/ids.js';
import type { Actor, Role } from '../domain/roles.js';
import type { FeatureState, TicketState, WorkItemState } from '../domain/states.js';
import { fenceIfHeadings } from '../domain/markdown.js';
import { applyTransition, canTransition } from '../domain/transitions.js';
import type { TransitionContext } from '../domain/transitions.js';
import type {
  AnyNote,
  FeatureNote,
  IsoTimestamp,
  TicketFrontmatter,
  TicketNote,
} from '../domain/types.js';
import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import type { AgentFailure, AgentRunResult, AgentRunSpec, Runner } from '../runner/types.js';
import { profileTouchesRepo } from '../runner/types.js';
import { atomicWrite } from '../vault/atomic.js';
import { FRONTMATTER_ORDER } from '../vault/note.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import { appendToSection } from '../vault/storage.js';
import { classifyFailure, failureConsumesAttempt, pauseReasonForFailure } from './attempts.js';
import { claimItem, releaseClaim } from './claim.js';
import { CHECKPOINTS, checkpointEnabled, pauseItem } from './checkpoints.js';
import type { CheckpointName } from './checkpoints.js';
import { scanVault } from './scan.js';
import { regenerateViews } from './views.js';

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
// Composing a note update.
// ---------------------------------------------------------------------------

export interface ComposeInput<N extends AnyNote> {
  readonly note: N;
  /** Appended in order, each under its `SECTION_ORDER` heading. */
  readonly sections?: ReadonlyArray<readonly [heading: string, markdown: string]>;
  /** Spread over the existing frontmatter. Never a rebuild. */
  readonly frontmatter?: object;
}

/** Apply body-section appends and frontmatter updates, purely. */
export function composeNote<N extends AnyNote>(input: ComposeInput<N>): N {
  let body = input.note.body;
  for (const [heading, markdown] of input.sections ?? []) {
    if (markdown.trim().length === 0) continue;
    body = appendToSection(body, heading, markdown);
  }

  return {
    ...input.note,
    frontmatter: { ...input.note.frontmatter, ...(input.frontmatter ?? {}) },
    body,
  };
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

/**
 * Points at which a test may kill the process.
 *
 * A test seam, exactly like `atomicWrite`'s `beforeRename`. Production never
 * passes `hooks`. `test/helpers/crashDuringDispatch.mjs` uses it to SIGKILL
 * itself, because an in-process thrown error runs our own `finally` blocks —
 * including the one that releases the claim — which is precisely the code a
 * real crash does not run.
 */
export type DispatchCrashPoint =
  /** The agent returned; nothing has been written yet. */
  | 'after_run'
  /**
   * The non-note files are written — `tech-plan.md`, the DL's ticket notes —
   * but the item note still says the role has not run. The one genuinely
   * multi-file window in a dispatch, and the reason ticket ids are allocated
   * from the payload rather than from what is already on disk.
   */
  | 'after_side_files'
  /** The note has been written and the views regenerated; the claim is still held. */
  | 'after_persist';

export interface DispatchHooks {
  readonly crash?: (
    point: DispatchCrashPoint,
    info: { readonly itemId: string; readonly role: Role | null },
  ) => void | Promise<void>;
}

/** Where an agent's child process runs. Phase 8 replaces the default. */
export interface Workspace {
  readonly cwd: string;
  readonly dispose?: () => Promise<void>;
}

export interface WorkspaceRequest {
  readonly role: Role;
  readonly itemId: string;
  readonly featureSlug: string;
  readonly ticketId?: string;
}

export type WorkspaceProvider = (request: WorkspaceRequest) => Promise<Workspace>;

export interface DispatchDeps {
  readonly paths: VaultPaths;
  readonly config: FactoryConfig;
  readonly storage: Storage;
  readonly runner: Runner;
  readonly events?: EventSink;
  readonly runs?: RunSink;
  readonly now: () => IsoTimestamp;
  readonly ownerId: string;
  readonly hooks?: DispatchHooks;
  readonly workspace?: WorkspaceProvider;
  /** Per-process monotonic counter feeding `runId` (spec §3.6). */
  readonly nextCounter: () => number;
  readonly signal?: AbortSignal;
}

export interface Actionable {
  readonly kind: 'feature' | 'ticket';
  readonly id: string;
  readonly path: string;
  /** The owning feature's slug — the same value for a feature and its tickets. */
  readonly slug: string;
  readonly note: AnyNote;
  readonly stage: WorkItemState;
}

export interface DispatchOutcome {
  readonly itemId: string;
  readonly claimed: boolean;
  /** The role that ran, or `null` for an orchestrator-only transition. */
  readonly ran: Role | null;
  readonly from: WorkItemState;
  readonly to: WorkItemState | null;
  readonly paused: boolean;
  readonly failure?: AgentFailure;
  readonly error?: string;
  readonly reason?: string;
}

export interface DispatchContext {
  /** Every ticket in the vault, for the dependency guards. */
  readonly tickets: readonly TicketNote[];
}

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
  if (item.kind === 'ticket') {
    // The only ticket move Phase 7a owns: `backlog → ready` once every
    // dependency is `done` (spec §7.5). Everything past `ready` needs a
    // worktree and a gate run.
    if (item.stage !== 'backlog') return idle(item, 'no Phase 7a handler for this ticket state');
    return await plainTransition(deps, item, 'ready', 'orchestrator', {
      tickets: context.tickets,
    });
  }

  if (item.stage === 'intake') {
    return await plainTransition(deps, item, 'refining', 'orchestrator', {});
  }

  const role = roleForFeatureState(item.stage as FeatureState);
  if (role === null) return idle(item, 'no agent role owns this feature state in M1–M3');

  return await runRole(deps, item, role);
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
): Promise<DispatchOutcome> {
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
        return await applyRoleOutput(deps, item, role, result, carriedCostUsd);
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

/**
 * Where the child process runs.
 *
 * Phase 8 provides real worktrees. Until then a repo-touching role falls back
 * to the target repo itself — which is safe **only** because `factory start`
 * refuses to construct a non-mock runner while no `WorkspaceProvider` exists
 * (see `src/cli/start.ts`). The fallback exists so a `MockRunner` cycle has a
 * cwd to put in its spec; the mock never spawns anything, so it never uses it.
 *
 * The refusal deliberately lives at the CLI rather than here. A per-dispatch
 * refusal would fail halfway through a feature, after the PM run has already
 * been paid for.
 */
async function resolveWorkspace(
  deps: DispatchDeps,
  request: WorkspaceRequest,
): Promise<Workspace> {
  if (deps.workspace !== undefined) return await deps.workspace(request);
  return { cwd: deps.config.target_repo };
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
// Failure handling (spec §9.1).
// ---------------------------------------------------------------------------

async function recordFailure(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  result: AgentRunResult,
  failure: AgentFailure,
  detail?: string,
  /** Money already spent on forgiven runs in this dispatch. See `runRole`. */
  carriedCostUsd = 0,
): Promise<DispatchOutcome> {
  const reason = detail ?? result.terminalReason;

  if (!failureConsumesAttempt(failure)) {
    await deps.events?.emit({
      type: 'attempt_forgiven',
      itemId: item.id,
      failure,
      reason: 'the orchestrator cancelled the run, so the agent did not fail',
    });

    // Forgiven of attempts, not of money.
    //
    // A forgiven failure normally writes nothing — the item stays exactly as it
    // was and the next cycle picks it up, which is what makes an abort cheap.
    // But `carriedCostUsd` is real spend on runs that already happened: a
    // schema failure was forgiven, its free re-run was paid for, and *then* the
    // orchestrator was cancelled. Returning here without writing would drop
    // that from `cost_usd`, which is the only per-item spend record there is.
    //
    // Guarded rather than unconditional so the ordinary abort path still writes
    // nothing at all.
    if (carriedCostUsd > 0) {
      const next = composeNote({
        note: item.note,
        frontmatter: {
          cost_usd: item.note.frontmatter.cost_usd + carriedCostUsd,
          updated_at: deps.now(),
        },
      });
      await writeAnyNote(deps.storage, item.path, next);
      await deps.events?.emit({
        type: 'cost_recorded',
        itemId: item.id,
        costUsd: carriedCostUsd,
        totalUsd: next.frontmatter.cost_usd,
      });
    }

    return {
      itemId: item.id,
      claimed: true,
      ran: role,
      from: item.stage,
      to: null,
      paused: false,
      failure,
      reason,
    };
  }

  const attempts = item.note.frontmatter.attempts + 1;
  const maxAttempts = maxAttemptsFor(item, deps.config);
  const costUsd = item.note.frontmatter.cost_usd + carriedCostUsd + result.costUsd;
  const now = deps.now();

  await deps.events?.emit({ type: 'attempt_consumed', itemId: item.id, failure, attempts, maxAttempts });

  if (attempts < maxAttempts) {
    // No transition: the item stays where it is and the next cycle retries it.
    // A same-state retry has no `## History` line to add — the event log is
    // where a bounce is recorded, and inventing a self-transition here would
    // put a row in the audit trail that the state machine never permitted.
    const next = composeNote({
      note: item.note,
      frontmatter: { attempts, cost_usd: costUsd, updated_at: now },
    });
    await writeAnyNote(deps.storage, item.path, next);
    await refreshViews(deps);
    return {
      itemId: item.id,
      claimed: true,
      ran: role,
      from: item.stage,
      to: null,
      paused: false,
      failure,
      reason,
    };
  }

  const pauseReason = pauseReasonForFailure(failure);
  const detailText =
    `${role} failed ${attempts} time(s) (${failure}: ${reason}). ` +
    `Transcript: ${deps.paths.logPath(item.slug, item.id, attempts, role)}`;

  const paused = pauseItem(
    composeNote({
      note: item.note,
      frontmatter: { attempts, cost_usd: costUsd },
    }),
    {
      reason: pauseReason,
      detail: detailText,
      // Approving re-runs the same role from the same state. There is no
      // sensible "reject" for an exhausted attempt budget — sending it
      // backwards would re-run an upstream role that did nothing wrong — so
      // rejecting is refused rather than being given an arbitrary target.
      resumeTo: item.stage,
      rejectTo: null,
      now,
      actor: 'orchestrator',
      historyNote: `${pauseReason}: ${failure} after ${attempts} attempt(s)`,
    },
  );

  await writeAnyNote(deps.storage, item.path, paused);
  await deps.events?.emit({
    type: 'item_paused',
    itemId: item.id,
    pauseReason,
    detail: detailText,
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
    failure,
    reason,
  };
}

function maxAttemptsFor(item: Actionable, config: FactoryConfig): number {
  if (item.kind !== 'ticket') return config.max_attempts;
  const override = (item.note.frontmatter as TicketFrontmatter).max_attempts;
  return override ?? config.max_attempts;
}

// ---------------------------------------------------------------------------
// Applying a successful role output.
// ---------------------------------------------------------------------------

interface RoleEffect {
  readonly sections: ReadonlyArray<readonly [heading: string, markdown: string]>;
  readonly to: WorkItemState;
  readonly actor: Actor;
  readonly historyNote?: string;
  readonly checkpoint?: CheckpointName;
  /** Non-note files, written before the note. Full overwrites only. */
  readonly files?: ReadonlyArray<readonly [file: string, contents: string]>;
  readonly tickets?: readonly TicketNote[];
  /**
   * Ticket files to delete before the new ones are written. See
   * `reconcileTickets` — a breakdown replaces the previous breakdown whole,
   * and leaving the previous one's extras on disk would strand schedulable
   * work with dependencies pointing at tickets nobody plans to build.
   */
  readonly removeTicketFiles?: readonly string[];
  /**
   * The effect cannot be applied and the item must go to a human instead.
   * Used when replacing a breakdown would destroy work that has already
   * started, which is a judgement no orchestrator should make on its own.
   */
  readonly refuse?: string;
}

async function applyRoleOutput(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  result: AgentRunResult,
  /** Money already spent on forgiven runs in this dispatch. See `runRole`. */
  carriedCostUsd = 0,
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

  const effect = await effectFor(deps, item, role, result.structured);

  if (effect.refuse !== undefined) {
    return await refuseEffect(deps, item, role, effect.refuse, costUsd, now);
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
    frontmatter: { cost_usd: costUsd },
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

async function effectFor(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  structured: unknown,
): Promise<RoleEffect> {
  switch (role) {
    case 'pm':
      return pmEffect(structured as PmOutput);
    case 'tl_plan':
      return tlPlanEffect(deps, item, structured as TlPlanOutput);
    case 'dl':
      return dlEffect(deps, item, structured as DlOutput, await readExistingTickets(deps, item.slug));
    default:
      throw new Error(
        `Phase 7a has no note-writing effect for role ${role}. The developer, reviewer and QA ` +
          'roles arrive with the gate loop in Phase 9.',
      );
  }
}

function pmEffect(payload: PmOutput): RoleEffect {
  const refined = [
    sectionBody(payload.refined_requirement),
    bulletBlock('In scope', payload.scope_in),
    bulletBlock('Out of scope', payload.scope_out),
    bulletBlock('Questions for the Tech Lead', payload.questions_for_tl),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    sections: [
      [SECTION.refinedRequirement, refined],
      [SECTION.acceptanceCriteria, bullets(payload.acceptance_criteria)],
      ...notesSection(payload.notes_markdown),
    ],
    to: 'planning',
    actor: 'orchestrator',
    checkpoint: 'after_pm_refinement',
  };
}

/**
 * The Tech Lead's `notes_markdown` becomes `tech-plan.md`.
 *
 * `prompts/tl_plan.md` tells the agent so in as many words, and spec §5 and
 * §6.2 never say where `tech-plan.md` comes from. Writing it from anything else
 * would leave the TL instructed to put its plan in a field nobody reads, so the
 * prompt's contract is honoured here rather than rewritten. It is a full
 * overwrite at a fixed path, so a re-run after a crash rewrites it rather than
 * appending to a half-finished one.
 */
function tlPlanEffect(deps: DispatchDeps, item: Actionable, payload: TlPlanOutput): RoleEffect {
  const summary = [
    sectionBody(payload.feasibility),
    bulletBlock('Risks', payload.risks),
    bulletBlock('Phases', payload.phases),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  if (payload.request_refinement) {
    // Straight back to the PM. The questions go in `## Notes`, which is part of
    // the feature body every recipe injects, so the PM's next run reads them.
    const questions = [
      bulletBlock('The Tech Lead asked for refinement', payload.questions_for_pm),
      sectionBody(payload.notes_markdown),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    return {
      sections: [
        [SECTION.techPlan, summary],
        [SECTION.notes, questions],
      ],
      to: 'refining',
      actor: 'tl_plan',
      historyNote: 'the Tech Lead requested refinement',
    };
  }

  return {
    files: [[deps.paths.techPlan(item.slug), techPlanDocument(item, payload)]],
    sections: [[SECTION.techPlan, summary]],
    to: 'ticketing',
    actor: 'orchestrator',
  };
}

function techPlanDocument(item: Actionable, payload: TlPlanOutput): string {
  const header = `# Technical plan — ${item.note.frontmatter.title}\n\n` +
    `_Written by the Tech Lead agent for ${item.id}. The orchestrator wrote this file; ` +
    'the next write overwrites it._\n\n';
  return `${header}${payload.notes_markdown.trim()}\n`;
}

/**
 * The ticket files already sitting under a feature.
 *
 * Enumerated as **files**, not through `listTickets`, for two reasons. A ticket
 * note a human broke in Obsidian would make `listTickets` throw, and it is
 * precisely the file most likely to be left behind by a replacement that only
 * knew about the notes it could parse. And a leftover whose id the new
 * breakdown does not reproduce has to be found by its path, because there is
 * nothing else left to find it by.
 */
interface ExistingTickets {
  /** Every `.md` under the feature's tickets directory. */
  readonly files: readonly string[];
  /** The ones that parsed, by id. */
  readonly byId: ReadonlyMap<string, TicketNote>;
  /** Ids of tickets that have left `backlog` — real work, not a draft. */
  readonly started: readonly string[];
}

async function readExistingTickets(
  deps: DispatchDeps,
  slug: string,
): Promise<ExistingTickets> {
  const directory = deps.paths.ticketsDir(slug);

  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { files: [], byId: new Map(), started: [] };
    }
    throw error;
  }

  const files = names.map((name) => path.join(directory, name));
  const byId = new Map<string, TicketNote>();
  const started: string[] = [];

  for (const file of files) {
    let note: TicketNote;
    try {
      note = await deps.storage.readNote<TicketFrontmatter>(file);
    } catch {
      // Unparseable. It is still deleted along with the rest — leaving it would
      // leave an orphan the scan quarantines every cycle forever — but it
      // cannot be inspected, so it counts towards nothing below.
      continue;
    }
    byId.set(note.frontmatter.id, note);
    if (note.frontmatter.status !== 'backlog') started.push(note.frontmatter.id);
  }

  started.sort();
  return { files, byId, started };
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

/**
 * Turn the DL's payload into ticket notes.
 *
 * `depends_on` in the payload carries ticket **titles**, not ids, because real
 * ids do not exist until this function assigns them (Phase 6 ledger row). The
 * schema already guarantees titles are unique within the payload and that every
 * dependency names one of them, so the mapping below can rely on that and on
 * nothing else — a title it cannot resolve is a bug in the schema, not
 * something to paper over.
 *
 * Ordinals start at 1 **for the payload**, so the same payload always produces
 * the same ids at the same paths. A crash after two of four tickets were
 * written is repaired by the re-run overwriting all four, rather than appending
 * four more with fresh ordinals.
 *
 * ============================================================================
 * A BREAKDOWN REPLACES THE PREVIOUS BREAKDOWN WHOLE
 * ============================================================================
 * The DL runs more than once. A crash re-runs it, and so does `factory reject`
 * at the `after_ticket_breakdown` checkpoint — which is the point of that
 * checkpoint, and the second time the payload is deliberately *different*.
 *
 * Overwriting by id alone is not enough there. A new breakdown with three
 * tickets where the old had four leaves T004 on disk: nothing deletes it, the
 * DAG still sees it, and once the feature reaches `in_development` it becomes
 * schedulable work whose `depends_on` points at a plan nobody is building.
 * Nothing throws, and the only symptom is a ticket the human does not
 * recognise. So every existing ticket file goes, and the new breakdown is
 * written in its place.
 *
 * Two things temper that:
 *
 * - **A ticket that has left `backlog` is real work**, and replacing it would
 *   throw away a branch, a worktree, gate results and an attempt history.
 *   There is no transition into `ticketing` from `in_development`, so finding
 *   one means something is wrong that an orchestrator should not resolve on
 *   its own. It refuses and asks a human.
 * - **A human's own frontmatter keys are carried across** for any ticket the
 *   new breakdown reproduces. `Note<T>` has no slot for them, and this phase's
 *   whole invariant is that they survive a write; a replacement that silently
 *   dropped `owner:` would break that invariant on the one path the
 *   unknown-key test did not walk. Body edits are not carried — the body *is*
 *   the breakdown being replaced — and the replacement is recorded in the
 *   feature's `## Notes` and as a `tickets_replaced` event so a human can find
 *   the old content in git rather than discovering the loss later.
 */
function dlEffect(
  deps: DispatchDeps,
  item: Actionable,
  payload: DlOutput,
  existing: ExistingTickets,
): RoleEffect {
  const featureIdentifier = toFeatureId(item.slug);
  const now = deps.now();

  if (existing.started.length > 0) {
    return refusal(
      `refusing to replace the ticket breakdown for ${item.id}: ` +
        `${existing.started.join(', ')} ${existing.started.length === 1 ? 'has' : 'have'} already ` +
        'left backlog, and a new breakdown would delete work that has started — its branch, its ' +
        'gate results and its attempt history. Move those tickets back to backlog, or delete ' +
        'them, and approve this item to re-run the Delivery Lead.',
    );
  }

  const idByTitle = new Map<string, string>();
  payload.tickets.forEach((ticket, index) => {
    idByTitle.set(ticket.title.trim(), makeTicketId(featureIdentifier, index + 1));
  });

  const tickets: TicketNote[] = payload.tickets.map((ticket, index) => {
    const id = makeTicketId(featureIdentifier, index + 1);
    const dependsOn = ticket.depends_on.map((title) => {
      const resolved = idByTitle.get(title.trim());
      if (resolved === undefined) {
        throw new Error(
          `ticket ${JSON.stringify(ticket.title)} depends on ${JSON.stringify(title)}, which is ` +
            'not a title in this payload. The DL schema is supposed to make that impossible.',
        );
      }
      return resolved;
    });

    // A fresh breakdown, so the body and every known field come from the
    // payload. The one thing carried across from a ticket this replaces is a
    // human's own frontmatter keys — see the header note.
    const carried = carriedKeys(existing.byId.get(id));

    const frontmatter: TicketFrontmatter = {
      type: 'ticket',
      id,
      title: ticket.title.trim(),
      status: 'backlog' satisfies TicketState,
      feature: item.slug,
      ordinal: index + 1,
      depends_on: dependsOn,
      attempts: 0,
      max_attempts: null,
      cost_usd: 0,
      branch: null,
      worktree: null,
      gate_results: null,
      created_at: now,
      updated_at: now,
      locked_by: null,
      locked_at: null,
      pause_reason: null,
      pause_detail: null,
      resume_to: null,
      reject_to: null,
      paused_at: null,
      ...carried,
    };

    let body = '';
    body = appendToSection(body, SECTION.rawRequirement, sectionBody(ticket.description_md));
    body = appendToSection(body, SECTION.acceptanceCriteria, bullets(ticket.acceptance_criteria));
    if (ticket.technical_notes_md.trim().length > 0) {
      body = appendToSection(body, SECTION.techPlan, sectionBody(ticket.technical_notes_md));
    }

    return { frontmatter, body };
  });

  const replaced = [...existing.byId.keys()].sort();
  const notes = [
    payload.notes_markdown.trim(),
    replaced.length === 0
      ? ''
      : `_The orchestrator replaced a previous breakdown: ${replaced.join(', ')}. ` +
        'Their previous contents are in git history._',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    tickets,
    removeTicketFiles: existing.files,
    sections: notesSection(notes),
    to: 'in_development',
    actor: 'orchestrator',
    checkpoint: 'after_ticket_breakdown',
  };
}

function refusal(detail: string): RoleEffect {
  return { refuse: detail, sections: [], to: 'needs_human', actor: 'orchestrator' };
}

/**
 * A replaced ticket's unknown frontmatter keys — the ones `Note<T>` has no slot
 * for, which is exactly why they need naming explicitly here.
 *
 * `FRONTMATTER_ORDER` is the full set of keys the domain knows about, so
 * anything outside it was put there by a human.
 */
function carriedKeys(previous: TicketNote | undefined): Record<string, unknown> {
  if (previous === undefined) return {};
  const known = new Set<string>(FRONTMATTER_ORDER);
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous.frontmatter as unknown as Record<string, unknown>)) {
    if (known.has(key)) continue;
    carried[key] = value;
  }
  return carried;
}

// ---------------------------------------------------------------------------
// Persisting.
// ---------------------------------------------------------------------------

/** `applyTransition` without the overload gymnastics at every call site. */
function transition<N extends AnyNote>(
  note: N,
  to: WorkItemState,
  actor: Actor,
  now: IsoTimestamp,
  ctx: TransitionContext,
  historyNote?: string,
): N {
  return applyTransition(note as never, to as never, actor, {
    now,
    ctx,
    ...(historyNote === undefined ? {} : { note: historyNote }),
  }) as N;
}

async function persist(
  deps: DispatchDeps,
  item: Actionable,
  next: AnyNote,
  to: WorkItemState,
  actor: Actor,
  _now: IsoTimestamp,
  role: Role | null = null,
  historyNote?: string,
): Promise<void> {
  // The one write. See the header note.
  await writeAnyNote(deps.storage, item.path, next);
  await deps.events?.emit({
    type: 'item_transitioned',
    itemId: item.id,
    from: item.stage,
    to,
    actor,
    ...(historyNote === undefined ? {} : { note: historyNote }),
  });
  await refreshViews(deps);
  await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });
}

/**
 * `Storage.writeNote` for a note whose kind is only known as `AnyNote`.
 *
 * The generic would otherwise resolve against the first member of the union and
 * refuse a ticket. Widening `T` to the union of both frontmatter types is safe
 * because `Note<T>` is read-only in `T`.
 */
export async function writeAnyNote(
  storage: Storage,
  file: string,
  note: AnyNote,
): Promise<void> {
  await storage.writeNote<AnyNote['frontmatter']>(file, note);
}

/** Loop step 10's "regenerate `index.md`", plus `NEEDS_HUMAN.md` (plan Phase 7a). */
export async function refreshViews(deps: Pick<DispatchDeps, 'storage' | 'paths'>): Promise<void> {
  const scan = await scanVault(deps.storage, deps.paths);
  await regenerateViews(deps.paths, scan);
}

// ---------------------------------------------------------------------------
// Markdown helpers.
// ---------------------------------------------------------------------------

function notesSection(markdown: string): ReadonlyArray<readonly [string, string]> {
  return markdown.trim().length === 0 ? [] : [[SECTION.notes, sectionBody(markdown)]];
}

/**
 * Agent-supplied markdown, made safe to put inside a `## ` section.
 *
 * See `fenceIfHeadings`: text containing its own headings splits the section it
 * is written into, and can shadow a real section that a context recipe reads by
 * name. Every piece of free-form agent output that lands in a section goes
 * through here.
 */
function sectionBody(markdown: string): string {
  return fenceIfHeadings(markdown.trim());
}

function bullets(items: readonly string[]): string {
  return items
    .map((entry) => `- ${entry.replace(/\s*\r?\n\s*/g, ' ').trim()}`)
    .filter((line) => line !== '- ')
    .join('\n');
}

function bulletBlock(title: string, items: readonly string[]): string {
  const list = bullets(items);
  return list.length === 0 ? '' : `**${title}**\n\n${list}`;
}

/** Narrowing helpers, exported for the loop's actionable-set computation. */
export function asFeatureNote(note: AnyNote): FeatureNote {
  return note as FeatureNote;
}

export function asTicketNote(note: AnyNote): TicketNote {
  return note as TicketNote;
}

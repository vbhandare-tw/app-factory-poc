import { GATE_NAMES } from './states.js';
import type { FeatureNote, TicketNote } from './types.js';

/**
 * The result of a guard. A refusal always carries a reason, because the reason
 * is what ends up in the event log and in `pause_detail` when a human has to
 * work out why the pipeline stopped.
 */
export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const allow = (): GuardResult => ({ ok: true });

export const refuse = (reason: string): GuardResult => ({ ok: false, reason });

/**
 * Everything a guard is allowed to look at. Guards take explicit context and
 * read no globals, so the whole state machine is testable without a disk.
 */
export interface TransitionContext {
  /** Every ticket the caller knows about. Guards look up dependencies here. */
  readonly tickets?: readonly TicketNote[];
  /** `config.max_attempts`, used when a ticket has no override. */
  readonly defaultMaxAttempts?: number;
  /** Whether `git merge --no-ff` into the feature branch succeeded. */
  readonly mergeClean?: boolean;
  /** Whether the gates on the feature branch were green after the merge. */
  readonly featureBranchGatesGreen?: boolean;
  /**
   * Whether `git merge --no-ff <feature-branch>` into the **base** branch
   * succeeded (Phase 11).
   *
   * The feature-level twin of `mergeClean`, and the more dangerous of the two:
   * base-branch writes are reserved to the feature-close path alone (plan
   * Section E item 8), so this is the only fact that can make a feature `done`.
   */
  readonly baseMergeClean?: boolean;
  /**
   * The tag created on the base-branch merge commit — `factory/<slug>/<date>`.
   *
   * A separate fact from the merge rather than a boolean pair, because it is
   * also the value written to the note's `tag` field: one source for "was it
   * tagged" and "with what" cannot disagree with itself.
   */
  readonly featureTag?: string | null;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** `backlog → ready` requires every `depends_on` ticket to be `done`. */
export function allDependenciesDone(ticket: TicketNote, ctx: TransitionContext): GuardResult {
  const dependencies = ticket.frontmatter.depends_on;
  if (dependencies.length === 0) return allow();

  if (ctx.tickets === undefined) {
    return refuse(
      `cannot check dependencies of ${ticket.frontmatter.id}: no ticket set was supplied`,
    );
  }

  const byId = new Map(ctx.tickets.map((t) => [t.frontmatter.id, t]));
  const missing: string[] = [];
  const unfinished: string[] = [];

  for (const dependencyId of dependencies) {
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) {
      missing.push(dependencyId);
      continue;
    }
    if (dependency.frontmatter.status !== 'done') {
      unfinished.push(`${dependencyId} (${dependency.frontmatter.status})`);
    }
  }

  if (missing.length > 0 || unfinished.length > 0) {
    const parts: string[] = [];
    if (unfinished.length > 0) parts.push(`not done: ${unfinished.join(', ')}`);
    if (missing.length > 0) parts.push(`unknown ticket id: ${missing.join(', ')}`);
    return refuse(`${ticket.frontmatter.id} has unmet dependencies — ${parts.join('; ')}`);
  }

  return allow();
}

/**
 * `gates → code_review` requires tests, lint and build to all be `pass`.
 *
 * This is the hard gate of requirements §6.2 and plan Section E item 3: no
 * role, verdict or config flag may override it, and a missing result counts as
 * a failure, never as an absence of evidence.
 */
export function gatesAllGreen(ticket: TicketNote): GuardResult {
  const results = ticket.frontmatter.gate_results;
  if (results === null || results === undefined) {
    return refuse(`${ticket.frontmatter.id} has no gate results recorded`);
  }

  const problems: string[] = [];
  for (const gate of GATE_NAMES) {
    const result = results[gate];
    if (result === undefined) {
      problems.push(`${gate}: missing`);
      continue;
    }
    if (result.status !== 'pass') {
      problems.push(`${gate}: ${result.status}`);
    }
  }

  if (problems.length > 0) {
    return refuse(`${ticket.frontmatter.id} gates are not green — ${problems.join(', ')}`);
  }
  return allow();
}

/** Feature `in_development → awaiting_feature_close` requires every ticket `done`. */
export function allTicketsDone(feature: FeatureNote, ctx: TransitionContext): GuardResult {
  if (ctx.tickets === undefined) {
    return refuse(
      `cannot close ${feature.frontmatter.id}: no ticket set was supplied`,
    );
  }

  const owned = ctx.tickets.filter((t) => t.frontmatter.feature === feature.frontmatter.slug);
  if (owned.length === 0) {
    return refuse(`${feature.frontmatter.id} has no tickets, so there is nothing to close`);
  }

  const unfinished = owned
    .filter((t) => t.frontmatter.status !== 'done')
    .map((t) => `${t.frontmatter.id} (${t.frontmatter.status})`);

  if (unfinished.length > 0) {
    return refuse(`${feature.frontmatter.id} still has open tickets — ${unfinished.join(', ')}`);
  }
  return allow();
}

/**
 * Whether a ticket may be retried.
 *
 * `attempts` is a lifetime count, so the check is `attempts < max`, not
 * `attempts <= max`. Getting that off by one either wastes a run or drops one.
 */
export function attemptsRemaining(ticket: TicketNote, ctx: TransitionContext): GuardResult {
  const max = ticket.frontmatter.max_attempts ?? ctx.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (ticket.frontmatter.attempts < max) return allow();
  return refuse(
    `${ticket.frontmatter.id} has used all ${max} attempt(s) (attempts=${ticket.frontmatter.attempts})`,
  );
}

/**
 * A feature reaches `done` only when it is really on the base branch and really
 * tagged (Phase 11, plan Section E item 8).
 *
 * ============================================================================
 * WHY THIS GUARD EXISTS AT ALL
 * ============================================================================
 * `FEATURE_STATES` documents `done` as "merged into the base branch and
 * tagged", and until this phase **neither** route to it checked anything. The
 * `awaiting_feature_close → done` rule's own description claimed "merged into
 * base and tagged" while carrying no `guard` field, so a `factory approve`
 * would move a feature to `done` whatever had happened to the merge — including
 * nothing at all. `done` is terminal, so nothing would ever re-check, and the
 * vault would record a delivery that is not on the base branch.
 *
 * It is the exact shape of `mergeVerified` one level up, for the same reason:
 * the facts arrive in the context, nothing else in the system sets them, and
 * `!== true` means an **absent** fact refuses. The failure direction is a
 * feature stuck at the checkpoint, which a human can see and act on, rather
 * than a `done` nobody verified.
 *
 * Both routes are guarded. The checkpoint parks the feature at `needs_human`
 * with `resume_to: done`, so `needs_human → done` is the one a human actually
 * drives; guarding only the direct rule would leave the reachable route open.
 */
export function featureCloseVerified(feature: FeatureNote, ctx: TransitionContext): GuardResult {
  const id = feature.frontmatter.id;

  if (ctx.baseMergeClean !== true) {
    return refuse(
      `${id} was not merged cleanly into the base branch, so it cannot be done — done means ` +
        'merged and tagged. Only the feature-close path may write the base branch (plan ' +
        'Section E item 8), and it has not reported a clean merge for this feature.',
    );
  }

  const tag = ctx.featureTag;
  if (typeof tag !== 'string' || tag.trim() === '') {
    return refuse(
      `${id} merged into the base branch but no tag was recorded, so there is nothing marking ` +
        'the delivery. A merge and a tag are not interchangeable: the merge puts the work on ' +
        'the branch, the tag is what makes it findable afterwards.',
    );
  }

  return allow();
}

/** `merge → done` requires a clean merge and green gates on the feature branch. */
export function mergeVerified(ticket: TicketNote, ctx: TransitionContext): GuardResult {
  if (ctx.mergeClean !== true) {
    return refuse(`${ticket.frontmatter.id} was not merged cleanly into its feature branch`);
  }
  if (ctx.featureBranchGatesGreen !== true) {
    return refuse(
      `${ticket.frontmatter.id} merged, but the feature branch gates are not green`,
    );
  }
  return allow();
}

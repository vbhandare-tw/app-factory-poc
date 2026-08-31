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

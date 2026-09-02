/**
 * The orchestrator-side attempt policy: what a failure or a bounce *does* to an
 * item.
 *
 * The policy itself — which failures cost an attempt, which pause reason each
 * one carries, what a schema failure is forgiven — is pure and lives in
 * `./attempts.ts`. This module is the half that acts on those answers: it
 * charges the attempt, writes the evidence, moves the item back or parks it at
 * `needs_human`, and does all of it in one write per branch. The two files stay
 * separate because `./attempts.ts` is testable without a disk and this is not.
 */
import type { FactoryConfig } from '../config/schema.js';
import type { Role } from '../domain/roles.js';
import type { IsoTimestamp, TicketFrontmatter } from '../domain/types.js';
import type { AgentFailure, AgentRunResult } from '../runner/types.js';
import {
  describeAttemptFailure,
  failureConsumesAttempt,
  pauseReasonForFailure,
} from './attempts.js';
import { pauseItem } from './checkpoints.js';
import type {
  Actionable,
  BounceSpec,
  DispatchDeps,
  DispatchOutcome,
  RoleEffect,
} from './dispatchTypes.js';
import { composeNote, persist, refreshViews, transition, writeAnyNote } from './noteWrites.js';

// ---------------------------------------------------------------------------
// Failure handling (spec §9.1).
// ---------------------------------------------------------------------------

export async function recordFailure(
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

/**
 * A bounce: charge the attempt, write the evidence, move the ticket back — or
 * park it if that was the last attempt. One write, on every branch.
 *
 * `role` is `null` for a gate bounce, where no agent ran.
 */
export async function applyBounce(
  deps: DispatchDeps,
  item: Actionable,
  role: Role | null,
  effect: Pick<RoleEffect, 'sections' | 'frontmatter'>,
  bounce: BounceSpec,
  costUsd: number,
  now: IsoTimestamp,
): Promise<DispatchOutcome> {
  const attempts = item.note.frontmatter.attempts + 1;
  const maxAttempts = maxAttemptsFor(item, deps.config);

  await deps.events?.emit({
    type: 'attempt_consumed',
    itemId: item.id,
    failure: bounce.failure,
    attempts,
    maxAttempts,
  });

  const frontmatter = {
    ...(effect.frontmatter ?? {}),
    attempts,
    cost_usd: costUsd,
    updated_at: now,
  };

  if (attempts >= maxAttempts) {
    const detailText =
      `${describeAttemptFailure(bounce.failure)} — ${bounce.detail} ` +
      `This was attempt ${String(attempts)} of ${String(maxAttempts)}.`;

    const paused = pauseItem(
      composeNote({ note: item.note, sections: effect.sections, frontmatter }),
      {
        reason: pauseReasonForFailure(bounce.failure),
        detail: detailText,
        // Approving sends the ticket where the bounce was going, so a human who
        // has fixed whatever was wrong gets one more Developer run rather than
        // an immediate re-park.
        resumeTo: bounce.to,
        rejectTo: null,
        now,
        actor: role ?? 'orchestrator',
        historyNote: `${pauseReasonForFailure(bounce.failure)}: ${bounce.failure} after ${String(attempts)} attempt(s)`,
      },
    );

    await writeAnyNote(deps.storage, item.path, paused);
    await deps.events?.emit({
      type: 'item_paused',
      itemId: item.id,
      pauseReason: pauseReasonForFailure(bounce.failure),
      detail: detailText,
      resumeTo: bounce.to,
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
      reason: detailText,
    };
  }

  const staged = composeNote({ note: item.note, sections: effect.sections, frontmatter });

  if (bounce.to === item.stage) {
    // A same-state retry. The transition table has no self-transition and
    // inventing one here would put a move in the audit trail that the state
    // machine never permitted (Phase 7a). `attempts` and the event log carry it.
    await writeAnyNote(deps.storage, item.path, staged);
    await refreshViews(deps);
    await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });
    return {
      itemId: item.id,
      claimed: true,
      ran: role,
      from: item.stage,
      to: null,
      paused: false,
      reason: bounce.detail,
    };
  }

  const next = transition(staged, bounce.to, bounce.actor, now, {}, bounce.detail);
  await persist(deps, item, next, bounce.to, bounce.actor, now, role, bounce.detail);

  return {
    itemId: item.id,
    claimed: true,
    ran: role,
    from: item.stage,
    to: bounce.to,
    paused: false,
    reason: bounce.detail,
  };
}

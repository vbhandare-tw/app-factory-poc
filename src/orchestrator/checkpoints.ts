/**
 * Pausing an item, and the three planned checkpoints (spec §3.4–3.5).
 *
 * `needs_human` is overloaded: an agent that got stuck and a planned approval
 * gate both land there, and they need different resume behaviour. Spec §3.4
 * settles it with five extra frontmatter fields, and this module is the only
 * place that writes them, so "paused" always means the same complete set of
 * facts rather than whatever the calling site remembered to fill in.
 *
 * SPREAD, NEVER REBUILD. `pauseItem` and `clearPause` both extend the existing
 * frontmatter object. `Note<T>` has no slot for a human's own Obsidian-added
 * keys, so a field-by-field rebuild here would delete them silently, with no
 * type error and nothing red anywhere except the one test that plants such a
 * key on purpose.
 */
import type { Actor } from '../domain/roles.js';
import type { FeatureState, PauseReason, WorkItemState } from '../domain/states.js';
import { applyTransition } from '../domain/transitions.js';
import type { AnyNote, IsoTimestamp } from '../domain/types.js';

export type CheckpointName = 'after_pm_refinement' | 'after_ticket_breakdown' | 'final_acceptance';

export interface CheckpointSpec {
  readonly name: CheckpointName;
  /** The state the item is in when the checkpoint fires. */
  readonly from: FeatureState;
  /** Where `factory approve` sends it. */
  readonly resumeTo: FeatureState;
  /** Where `factory reject` sends it. */
  readonly rejectTo: FeatureState;
  /** Shown to the human in `NEEDS_HUMAN.md` and `pause_detail`. */
  readonly description: string;
}

/**
 * Spec §3.5's table as data.
 *
 * `final_acceptance` is declared here and unreachable in Phase 7a — the feature
 * cannot reach `awaiting_feature_close` until every ticket is `done`, which
 * needs the developer loop (Phase 9) and the ticket merge (Phase 10). It is
 * written now because the three checkpoints are one decision and splitting the
 * table across two phases is how the third one ends up shaped differently from
 * the first two.
 */
export const CHECKPOINTS: Readonly<Record<CheckpointName, CheckpointSpec>> = Object.freeze({
  after_pm_refinement: Object.freeze({
    name: 'after_pm_refinement',
    from: 'refining',
    resumeTo: 'planning',
    rejectTo: 'refining',
    description: 'The PM has refined the requirement. Approve to let the Tech Lead plan it.',
  }),
  after_ticket_breakdown: Object.freeze({
    name: 'after_ticket_breakdown',
    from: 'ticketing',
    resumeTo: 'in_development',
    rejectTo: 'ticketing',
    description: 'The Delivery Lead has cut tickets. Approve to start development.',
  }),
  final_acceptance: Object.freeze({
    name: 'final_acceptance',
    from: 'awaiting_feature_close',
    resumeTo: 'done',
    rejectTo: 'in_development',
    description: 'Every ticket is done and the feature branch is green. Approve to merge and tag.',
  }),
});

/** Only the config keys this module reads (spec §11). */
export interface CheckpointConfigView {
  readonly human_checkpoints: Readonly<Record<CheckpointName, boolean>>;
}

/**
 * Is this checkpoint switched on?
 *
 * A disabled checkpoint is skipped **entirely** — the item does not pause and
 * does not touch `needs_human`; it transitions straight to the checkpoint's
 * `resumeTo`. That is the difference between "off" and "auto-approved": nothing
 * is written that a human then has to look at.
 */
export function checkpointEnabled(config: CheckpointConfigView, name: CheckpointName): boolean {
  return config.human_checkpoints[name] !== false;
}

export interface PauseInput {
  readonly reason: PauseReason;
  readonly detail: string;
  /** Where `factory approve` sends it. `null` means approving is refused. */
  readonly resumeTo: WorkItemState | null;
  /** Where `factory reject` sends it. `null` means rejecting is refused. */
  readonly rejectTo: WorkItemState | null;
  readonly now: IsoTimestamp;
  readonly actor: Actor;
  /** Free text for the `## History` line. */
  readonly historyNote?: string;
}

/**
 * Move a note to `needs_human` and record why, in one new note object.
 *
 * The transition goes through `applyTransition`, so the state machine still
 * decides whether the move is legal and the history line is appended in the
 * same shape as every other transition. The pause fields are then spread on
 * top — this function returns a value; persisting it is the caller's job
 * (ADR-002).
 */
export function pauseItem<N extends AnyNote>(note: N, input: PauseInput): N {
  const transitioned = applyTransition(
    note as never,
    'needs_human' as never,
    input.actor,
    {
      now: input.now,
      ...(input.historyNote === undefined ? {} : { note: input.historyNote }),
    },
  ) as N;

  return {
    ...transitioned,
    frontmatter: {
      ...transitioned.frontmatter,
      pause_reason: input.reason,
      pause_detail: input.detail,
      resume_to: input.resumeTo,
      reject_to: input.rejectTo,
      paused_at: input.now,
    },
  };
}

/**
 * Clear the pause machinery once a human has resolved the item.
 *
 * Leaving `pause_reason` set on a running item would make `NEEDS_HUMAN.md` and
 * `factory status` keep reporting it as parked, and would make the *next* pause
 * indistinguishable from the last one in the note's history.
 */
export function clearPause<T extends object>(frontmatter: T): T {
  return {
    ...frontmatter,
    pause_reason: null,
    pause_detail: null,
    resume_to: null,
    reject_to: null,
    paused_at: null,
  };
}

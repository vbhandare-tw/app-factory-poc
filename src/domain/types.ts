import type { Actor } from './roles.js';
import type { FeatureState, GateName, PauseReason, TicketState, WorkItemState } from './states.js';

/**
 * Every timestamp in the vault is an ISO 8601 string, never a `Date` and never
 * a YAML date object (spec §7.2). Typing it as a branded-ish alias keeps that
 * intent visible at every use site.
 */
export type IsoTimestamp = string;

/** A parsed note: YAML frontmatter plus the markdown body below the fence. */
export interface Note<T> {
  readonly frontmatter: T;
  readonly body: string;
}

/** One `## History` entry: `timestamp | from → to | actor | note`. */
export interface HistoryLine {
  readonly timestamp: IsoTimestamp;
  readonly from: string;
  readonly to: string;
  readonly actor: Actor;
  readonly note?: string | undefined;
}

/** The part of a gate run that is small enough to live in frontmatter. */
export interface GateResultSummary {
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly exit_code: number;
  readonly duration_ms: number;
  /** Tail of the output, capped at `config.gate_output_chars`. */
  readonly output: string;
  /** Full output on disk. */
  readonly log_path: string;
}

/** Set together whenever an item pauses (spec §3.4). */
export interface PauseFields {
  readonly pause_reason: PauseReason | null;
  readonly pause_detail: string | null;
  readonly resume_to: WorkItemState | null;
  readonly reject_to: WorkItemState | null;
  readonly paused_at: IsoTimestamp | null;
}

/** The item-level claim (spec §7.4). */
export interface LockFields {
  readonly locked_by: string | null;
  readonly locked_at: IsoTimestamp | null;
}

export interface CommonFrontmatter extends PauseFields, LockFields {
  readonly id: string;
  readonly title: string;
  readonly created_at: IsoTimestamp;
  readonly updated_at: IsoTimestamp;
  /** Lifetime failure count. Never reset by a success (see plan Phase 9). */
  readonly attempts: number;
  readonly cost_usd: number;
}

export type FeaturePriority = 'high' | 'medium' | 'low';

export interface FeatureFrontmatter extends CommonFrontmatter {
  readonly type: 'feature';
  readonly status: FeatureState;
  readonly slug: string;
  readonly priority: FeaturePriority;
  readonly feature_branch: string | null;
  /** Set on close: `factory/<slug>/<ISO date>`. */
  readonly tag: string | null;
  /**
   * The feature-branch commit the pre-approval gates actually verified.
   *
   * Recorded when the `final_acceptance` checkpoint is offered and re-checked
   * when a human approves, because **the gate verdict goes stale**: the gates
   * run before the checkpoint and the approval arrives whenever a person gets
   * to it, so anything landing on the feature branch in between is unverified.
   * Without this the thing a human approved and the thing that lands on the
   * base branch are two different commits. `null` means nothing is verified,
   * which refuses rather than passing.
   */
  readonly verified_sha: string | null;
  /**
   * The **base**-branch commit the pre-approval gates verified, when they had
   * to verify one at all.
   *
   * The feature close merges into a branch nobody in the factory owns, and
   * requirements §16 wants a red base branch to block the merge. The verdict
   * goes stale for exactly the reason `verified_sha`'s does — the gates run
   * before the checkpoint and the approval arrives whenever a person gets to
   * it — so the commit it was taken at is recorded and re-checked against the
   * base branch tip before anything is merged.
   *
   * `null` means **no gate run covers the base branch**, which is the normal
   * state rather than a failure: when the base tip is already an ancestor of
   * the verified feature commit, the merge produces that commit's tree and the
   * feature-branch run has already judged it, so no separate run is made. The
   * close re-derives that ancestry at merge time, so `null` is safe there and
   * refuses everywhere else.
   */
  readonly base_verified_sha: string | null;
  /**
   * The feature commit a human has already approved for delivery.
   *
   * A standing approval. A person at the `final_acceptance` checkpoint is
   * judging **the feature commit** — the summary shows them `verified_sha`, the
   * tickets and the gate results, and it does not show them the base branch at
   * all. So when the base branch moves while they are deciding, refusing their
   * approval outright asks them to re-answer a question about the feature that
   * nothing about the feature changed. Instead the approval is recorded here
   * and the feature goes back to the loop, which is the only thing that can
   * gate the moved base branch; the close then happens on this approval.
   *
   * **Void the moment the feature commit changes.** `runFeatureClose` closes on
   * it only when it equals the commit the gates have just verified, so a
   * feature branch that moved needs a fresh checkpoint — a person re-approves
   * when what they approved changed, not when somebody else's unrelated commit
   * landed.
   */
  readonly approved_sha: string | null;
  /** What the approver typed, kept so the close can carry it into `## History`. */
  readonly approved_note: string | null;
  /**
   * The tag name the approval summary promised, kept with the approval.
   *
   * `factory/<slug>/<ISO date>` is derived from `paused_at` precisely so that
   * the name a person is shown is the name that gets created (Phase 11 note 6).
   * A standing approval outlives its pause — `clearPause` nulls `paused_at`,
   * and any later pause overwrites it — so the promise is carried here instead
   * of being re-derived from a clock that has moved on.
   */
  readonly approved_tag: string | null;
}

export interface TicketFrontmatter extends CommonFrontmatter {
  readonly type: 'ticket';
  readonly status: TicketState;
  /** The slug of the owning feature. */
  readonly feature: string;
  readonly ordinal: number;
  readonly depends_on: readonly string[];
  /** Overrides `config.max_attempts` for this ticket only (spec §11). */
  readonly max_attempts: number | null;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly gate_results: Partial<Record<GateName, GateResultSummary>> | null;
}

export type FeatureNote = Note<FeatureFrontmatter>;
export type TicketNote = Note<TicketFrontmatter>;
export type AnyNote = FeatureNote | TicketNote;

export function isTicketNote(note: AnyNote): note is TicketNote {
  return note.frontmatter.type === 'ticket';
}

export function isFeatureNote(note: AnyNote): note is FeatureNote {
  return note.frontmatter.type === 'feature';
}

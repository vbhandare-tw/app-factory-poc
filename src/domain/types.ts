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

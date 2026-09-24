/**
 * Display labels and one-line event summaries (tech spec §1).
 *
 * `EVENT_SUMMARIES` is a mapped type over every `FactoryEvent['type']`, so
 * adding a 57th event type without a formatter here is a compile error, not a
 * silent gap in the feed.
 */
import type { Role } from '../domain/roles.js';
import type { FeatureState, PauseReason, TicketState } from '../domain/states.js';
import type { FactoryEvent } from '../log/events.js';

export const ROLE_LABELS: Record<Role, string> = {
  pm: 'Product Manager',
  tl_plan: 'Tech Lead',
  dl: 'Delivery Lead',
  developer: 'Developer',
  code_reviewer: 'Code Reviewer',
  qa: 'QA',
};

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  checkpoint: 'Waiting for review',
  escalation: 'Escalated',
  attempts_exhausted: 'Failed 3 times',
  timeout: 'Timed out',
  merge_conflict: 'Merge conflict',
  malformed_output: 'Malformed output',
};

export const STAGE_LABELS: Record<FeatureState | TicketState, string> = {
  intake: 'Intake',
  refining: 'Refining',
  planning: 'Planning',
  ticketing: 'Ticketing',
  in_development: 'In development',
  awaiting_feature_close: 'Awaiting close',
  needs_human: 'Needs you',
  done: 'Done',
  blocked: 'Blocked',
  regression: 'Regression',
  pm_review: 'PM review',
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  gates: 'Gates',
  code_review: 'Code review',
  qa: 'QA',
  merge: 'Merge',
};

type SummaryOf<T extends FactoryEvent['type']> = (event: Extract<FactoryEvent, { type: T }>) => string;

export type EventSummaries = { [K in FactoryEvent['type']]: SummaryOf<K> };

export const EVENT_SUMMARIES: EventSummaries = {
  run_started: (e) => `${ROLE_LABELS[e.role]} run started for ${e.itemId}`,
  run_finished: (e) => `${ROLE_LABELS[e.role]} run finished (${e.ok ? 'ok' : 'failed'})`,
  run_stream_malformed: (e) => `Run ${e.runId}: unparseable stream line`,
  run_stderr: (e) => `Run ${e.runId}: stderr output`,
  run_killed: (e) => `Run ${e.runId} killed (${e.reason})`,
  run_swept: (e) => `Run ${e.runId} swept up after a crash`,

  lock_acquired: (e) => `Instance lock acquired (pid ${e.pid})`,
  lock_reclaimed: (e) => `Instance lock reclaimed: ${e.reason}`,
  lock_heartbeat_failed: (e) => `Lock heartbeat failed: ${e.error}`,
  cycle_started: (e) => `Cycle ${e.cycle} started`,
  cycle_finished: (e) =>
    `Cycle ${e.cycle}: ${e.dispatched} dispatched, ${e.quarantined} quarantined, ${e.errors} errors`,
  kill_switch: () => 'Kill switch detected',
  note_malformed: (e) => `Malformed note: ${e.path} (${e.reason})`,
  claim_won: (e) => `${e.itemId} claimed`,
  claim_lost: (e) => `${e.itemId} claim lost: ${e.reason}`,
  claim_expired: (e) => `${e.itemId} claim expired: ${e.reason}`,
  claim_released: (e) => `${e.itemId} claim released`,
  item_transitioned: (e) => `${e.itemId}: ${e.from} → ${e.to}`,
  item_paused: (e) => `${e.itemId} paused: ${PAUSE_REASON_LABELS[e.pauseReason as PauseReason] ?? e.pauseReason}`,
  attempt_consumed: (e) => `${e.itemId}: attempt ${e.attempts}/${e.maxAttempts} consumed`,
  attempt_forgiven: (e) => `${e.itemId}: attempt forgiven (${e.reason})`,
  payload_large: (e) => `${e.itemId}: ${ROLE_LABELS[e.role]} payload is ${e.chars} chars (limit ${e.limitChars})`,
  delivery_retried: (e) => `${e.itemId}: ${ROLE_LABELS[e.role]} needed ${e.calls} delivery attempts`,
  schema_retry: (e) => `${e.itemId}: ${ROLE_LABELS[e.role]} schema retry on attempt ${e.attempt}`,
  context_truncated: (e) => `${e.itemId}: context truncated for ${ROLE_LABELS[e.role]}`,
  tickets_created: (e) => `${e.featureId}: ${e.ticketIds.length} ticket(s) created`,
  tickets_replaced: (e) => `${e.featureId}: tickets replaced (${e.removed.length} removed)`,
  cost_recorded: (e) => `${e.itemId}: cost recorded ($${e.costUsd.toFixed(2)}, total $${e.totalUsd.toFixed(2)})`,
  dispatch_failed: (e) => `${e.itemId}: dispatch failed (${e.error})`,
  workspace_unprovisioned: (e) => `${e.itemId}: no worktree for ${ROLE_LABELS[e.role]}`,

  worktree_created: (e) => `Worktree created for ${e.itemId}`,
  worktree_removed: (e) => `Worktree removed: ${e.reason}`,
  worktree_unaccounted: (e) => `Unaccounted worktree: ${e.path}`,
  worktree_retained_dirty: (e) => `${e.itemId}: worktree retained (dirty)`,
  feature_branch_created: (e) => `Feature branch created: ${e.branch}`,
  worktrees_reconciled: (e) =>
    `Worktrees reconciled: ${e.kept} kept, ${e.created} created, ${e.removed} removed`,
  worktree_reconcile_failed: (e) => `Worktree reconcile failed: ${e.error}`,

  gate_result: (e) => `${e.itemId}: gate ${e.gate} ${e.status}`,
  gates_finished: (e) => `${e.itemId}: gates ${e.green ? 'green' : 'red'} (attempt ${e.attempt})`,
  commit_created: (e) => `${e.itemId}: commit ${e.sha.slice(0, 7)}`,
  commit_refused: (e) => `${e.itemId}: commit refused (${e.reason})`,

  merge_started: (e) => `${e.itemId}: merge started into ${e.into}`,
  merge_completed: (e) => `${e.itemId}: merged into ${e.into}`,
  merge_conflict: (e) => `${e.itemId}: merge conflict into ${e.into}`,
  merge_reverted: (e) => `${e.itemId}: merge reverted (${e.reason})`,
  merge_revert_failed: (e) => `${e.itemId}: merge revert failed (${e.error})`,
  merge_refused: (e) => `${e.itemId}: merge refused (${e.detail})`,
  ticket_branch_deleted: (e) => `${e.itemId}: ticket branch deleted`,
  merge_cleanup_failed: (e) => `${e.itemId}: merge cleanup failed`,

  feature_close_started: (e) => `${e.featureId}: feature close started`,
  feature_closed: (e) => `${e.featureId}: closed and tagged ${e.tag}`,
  feature_close_conflict: (e) => `${e.featureId}: feature close conflict`,
  feature_close_refused: (e) => `${e.featureId}: feature close refused (${e.detail})`,
  feature_tagged: (e) => `${e.featureId}: tagged ${e.tag}`,
  feature_close_cleanup_failed: (e) => `${e.featureId}: feature close cleanup failed`,
  feature_tag_failed: (e) => `${e.featureId}: tag failed (${e.error})`,
};

/**
 * `event` is deliberately wider than `FactoryEvent` — a future event type on
 * disk that this build does not know about must fall back, not throw.
 */
export function summariseEvent(event: { readonly type: string } & Record<string, unknown>): string {
  const table = EVENT_SUMMARIES as Record<string, ((e: never) => string) | undefined>;
  const summary = table[event.type];
  return summary ? summary(event as never) : event.type;
}

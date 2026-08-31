/**
 * Feature states that are reachable in M1–M3 (spec §3.2).
 *
 * `done` means merged into the base branch and tagged, so there is no separate
 * `deployed_ready`.
 */
export const FEATURE_STATES = [
  'intake',
  'refining',
  'planning',
  'ticketing',
  'in_development',
  'awaiting_feature_close',
  'needs_human',
  'done',
] as const;

export type ReachableFeatureState = (typeof FEATURE_STATES)[number];

/**
 * Declared but unreachable in M1–M3: no transition rule targets them.
 *
 * They exist now so that M4 (`blocked`) and M5 (`regression`, `pm_review`) are
 * additive rather than a breaking change to every persisted note.
 */
export const FUTURE_FEATURE_STATES = ['blocked', 'regression', 'pm_review'] as const;

export type FutureFeatureState = (typeof FUTURE_FEATURE_STATES)[number];

export const ALL_FEATURE_STATES = [...FEATURE_STATES, ...FUTURE_FEATURE_STATES] as const;

export type FeatureState = (typeof ALL_FEATURE_STATES)[number];

/**
 * Ticket states (spec §3.3).
 *
 * `gates` and `merge` are executed by the orchestrator, not by an agent. They
 * are still modelled as states so `## History` reads coherently and so a crash
 * mid-gate is recoverable.
 */
export const TICKET_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
  'done',
  'needs_human',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export type WorkItemState = FeatureState | TicketState;

/**
 * Why an item is sitting in `needs_human` (spec §3.4). The status alone is not
 * enough, because a planned checkpoint and a stuck agent need different resume
 * behaviour.
 */
export const PAUSE_REASONS = [
  'checkpoint',
  'escalation',
  'attempts_exhausted',
  'timeout',
  'merge_conflict',
  'malformed_output',
] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number];

/** The deterministic quality gates, in the order they run (spec §8.2). */
export const GATE_NAMES = ['tests', 'lint', 'build'] as const;

export type GateName = (typeof GATE_NAMES)[number];

export function isFeatureState(value: unknown): value is FeatureState {
  return typeof value === 'string' && (ALL_FEATURE_STATES as readonly string[]).includes(value);
}

export function isTicketState(value: unknown): value is TicketState {
  return typeof value === 'string' && (TICKET_STATES as readonly string[]).includes(value);
}

export function isPauseReason(value: unknown): value is PauseReason {
  return typeof value === 'string' && (PAUSE_REASONS as readonly string[]).includes(value);
}

export function isGateName(value: unknown): value is GateName {
  return typeof value === 'string' && (GATE_NAMES as readonly string[]).includes(value);
}

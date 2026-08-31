import type { WorkItemState } from './states.js';

/**
 * Scheduling — requirements §8.1.
 *
 * **M1–M3 implements rule 1 (stage priority) and rule 5 (the lexicographic
 * tiebreaker) only.** Rules 2 (fixes before new work), 3 (feature priority and
 * `max_active_features`) and 4 (critical path by DAG descendant count), plus
 * the starvation guard, land in M4. They are additive: they slot in between the
 * two comparisons below, so no caller changes.
 *
 * The whole point of this function is that the same vault snapshot always
 * yields the same claim order (plan Section E item 10), which is why the
 * tiebreaker compares codepoints rather than using locale collation.
 */

export interface WorkItem {
  readonly id: string;
  readonly stage: WorkItemState;
}

/**
 * Lower number = claimed first. Rule 1's rationale is "drain WIP first":
 * finishing near-done work releases dependencies and keeps work-in-progress
 * low, so a reviewer or QA run is never starved to spawn another developer.
 *
 * The order below is requirements §8.1 rule 1 verbatim, with the states that
 * rule does not mention slotted in:
 *   - `gates` and `awaiting_feature_close` are near-done work, so they rank high.
 *   - `in_development`, `backlog` and `blocked` are holding states — the work is
 *     really in their children — so they rank below anything directly runnable.
 *   - `needs_human` and `done` are never claimed at all.
 */
export const STAGE_PRIORITY: Record<WorkItemState, number> = {
  merge: 0,
  awaiting_feature_close: 1,
  gates: 2,
  regression: 3,
  pm_review: 4,
  qa: 5,
  code_review: 6,
  in_progress: 7,
  ready: 8,
  ticketing: 9,
  planning: 10,
  refining: 11,
  intake: 12,
  in_development: 13,
  backlog: 14,
  blocked: 15,
  needs_human: 16,
  done: 17,
};

export function stagePriority(stage: WorkItemState): number {
  return STAGE_PRIORITY[stage];
}

/**
 * Rule 1 then rule 5. Returns <0 if `a` should be claimed before `b`.
 */
export function compareWorkItems(a: WorkItem, b: WorkItem): number {
  const byStage = stagePriority(a.stage) - stagePriority(b.stage);
  if (byStage !== 0) return byStage;

  // Rule 5: lexicographic by id, compared codepoint by codepoint.
  // `localeCompare` would make the claim order depend on the machine's locale.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Sorted copy, highest priority first. Never mutates the input. */
export function rankWorkItems<T extends WorkItem>(items: readonly T[]): T[] {
  return [...items].sort(compareWorkItems);
}

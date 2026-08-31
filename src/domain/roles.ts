/**
 * The agent roles the factory runs in M1–M3.
 *
 * `tl_merge` and `qa_lead` from the requirements document are deliberately
 * absent: merging is deterministic and orchestrator-driven (ADR-004), and
 * feature-close regression is M5 (spec §3.1).
 */
export const ROLES = ['pm', 'tl_plan', 'dl', 'developer', 'code_reviewer', 'qa'] as const;

export type Role = (typeof ROLES)[number];

/** Actors that are not agents: the orchestrator itself, and the human operator. */
export const NON_AGENT_ACTORS = ['orchestrator', 'human'] as const;

export type NonAgentActor = (typeof NON_AGENT_ACTORS)[number];

/** Anything that can cause a state transition and be recorded in `## History`. */
export type Actor = Role | NonAgentActor;

export const ACTORS = [...ROLES, ...NON_AGENT_ACTORS] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isActor(value: unknown): value is Actor {
  return typeof value === 'string' && (ACTORS as readonly string[]).includes(value);
}

/**
 * One permission profile per role (spec §4.3, ADR-003).
 *
 * Pure data. `src/runner/settings.ts` turns it into the sandbox JSON and
 * `src/runner/argv.ts` turns it into `--tools` / `--allowedTools`; nothing here
 * knows what a CLI flag is.
 *
 * `AgentProfile` is imported from `src/runner/types.ts` and deliberately not
 * redeclared: `AgentRunSpec` references it, and the runner must not depend on
 * the agent layer (Phase 5 ledger row).
 *
 * THREE INVARIANTS THIS FILE CARRIES, all of them plan Section E items:
 *
 * - **Item 5 — agents never touch the vault.** No profile names a path at all.
 *   `buildSandboxSettings` adds the run's cwd, and the repo root for a
 *   repo-touching role; a vault path here would be a hole that no other layer
 *   would notice, because everything downstream trusts the profile.
 * - **Item 6 — no phase weakens the sandbox to make a test pass.** If a profile
 *   makes something awkward, the profile's *shape* is the thing to change.
 * - **§4.5 — nobody but the developer writes.** `Edit` and `Write` appear in
 *   exactly one profile below, and `profiles.test.ts` asserts it globally rather
 *   than role by role.
 */
import type { Role } from '../domain/roles.js';
import type { AgentProfile, ProfileCwdKind, SandboxProfile } from '../runner/types.js';

/** Tools that can change a file. Used by the test that pins them to one role. */
export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/** Spec §4.3: the read-only repo roles. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** The read-only roles that must also *run* something to do their job. */
export const READ_AND_RUN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

/** Spec §4.3's developer row, verbatim. */
export const DEVELOPER_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'] as const;

/**
 * The same sandbox block for every role.
 *
 * Every list is empty on purpose — see the header note. `denyReadHome` is the
 * one thing a profile does say, and it says the same thing six times so that a
 * profile with it missing stands out rather than blending in.
 */
const FENCED: SandboxProfile = Object.freeze({
  denyReadHome: true,
  allowRead: Object.freeze([]),
  allowWrite: Object.freeze([]),
  denyWrite: Object.freeze([]),
});

/** Ten minutes. The PM reads two documents and writes a payload; it has no tools. */
const SHORT_RUN_MS = 600_000;
/** Twenty minutes for the roles that read a repo but do not change it. */
const MEDIUM_RUN_MS = 1_200_000;
/** Thirty minutes — spec §11's `agent_timeout` default, the developer's ceiling. */
const LONG_RUN_MS = 1_800_000;

function profile(
  role: Role,
  cwd: ProfileCwdKind,
  tools: readonly string[],
  timeoutMs: number,
  maxBudgetUsd: number,
): AgentProfile {
  return Object.freeze({
    role,
    cwd,
    tools: Object.freeze([...tools]),
    // Same list. `--tools` decides what exists, `--allowedTools` what may run
    // without a prompt; a headless run that has to ask is a run that hangs
    // until it times out, so anything granted is also allowed (spec §4.4).
    allowedTools: Object.freeze([...tools]),
    sandbox: FENCED,
    timeoutMs,
    maxBudgetUsd,
  });
}

/**
 * Spec §4.3's table as code.
 *
 * The timeouts and budgets here are each role's own ceiling. `profileFor` takes
 * the smaller of these and the configured limits, so raising
 * `config.agent_timeout` cannot silently give the PM a half-hour run.
 */
export const PROFILES: Readonly<Record<Role, AgentProfile>> = Object.freeze({
  pm: profile('pm', 'scratch', [], SHORT_RUN_MS, 1),
  tl_plan: profile('tl_plan', 'repo_scratch_worktree', READ_ONLY_TOOLS, MEDIUM_RUN_MS, 2),
  dl: profile('dl', 'repo_scratch_worktree', READ_ONLY_TOOLS, MEDIUM_RUN_MS, 2),
  developer: profile('developer', 'ticket_worktree', DEVELOPER_TOOLS, LONG_RUN_MS, 5),
  code_reviewer: profile(
    'code_reviewer',
    'repo_scratch_worktree',
    READ_AND_RUN_TOOLS,
    MEDIUM_RUN_MS,
    2,
  ),
  qa: profile('qa', 'ticket_worktree', READ_AND_RUN_TOOLS, MEDIUM_RUN_MS, 2),
});

/** Only the config keys a profile reads (spec §11). */
export interface ProfileConfigView {
  /** Seconds. */
  readonly agent_timeout: number;
  readonly max_budget_usd_per_run: number;
}

/**
 * The profile a run actually uses: the role's own ceiling, capped by config.
 *
 * `Math.min` in both directions on purpose. Config is an operator's global
 * limit and must be able to tighten every role at once; the profile is a
 * role-specific judgement and must not be loosened by a config edit that was
 * aimed at something else.
 */
export function profileFor(role: Role, config: ProfileConfigView): AgentProfile {
  const base = PROFILES[role];
  const timeoutMs = Math.min(base.timeoutMs, Math.max(1, Math.floor(config.agent_timeout * 1000)));
  const maxBudgetUsd = Math.min(base.maxBudgetUsd, config.max_budget_usd_per_run);

  if (!(timeoutMs > 0) || !(maxBudgetUsd > 0)) {
    throw new Error(
      `profileFor(${role}): config produced timeoutMs=${timeoutMs} maxBudgetUsd=${maxBudgetUsd}. ` +
        'A zero timeout or budget would kill every run of this role immediately.',
    );
  }

  return Object.freeze({ ...base, timeoutMs, maxBudgetUsd });
}

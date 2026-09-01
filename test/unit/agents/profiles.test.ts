/**
 * The per-role permission shape (spec §4.3, ADR-003).
 *
 * These profiles are where the fence is configured. Plan Section E item 6 says
 * no phase may weaken the sandbox to make a test pass, and item 5 says agents
 * never touch the vault — so the assertions here are deliberately absolute
 * ("only the developer has Edit", "no profile names a vault path") rather than
 * per-role snapshots that a future edit could quietly re-baseline.
 */
import { describe, expect, it } from 'vitest';

import { PROFILES, WRITE_TOOLS, profileFor } from '../../../src/agents/profiles.js';
import { ROLES } from '../../../src/domain/roles.js';
import { profileTouchesRepo } from '../../../src/runner/types.js';

/** Config defaults from spec §11, as `profileFor` reads them. */
const CONFIG = { agent_timeout: 1800, max_budget_usd_per_run: 5 };

describe('agent profiles', () => {
  it('there is exactly one profile per role', () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) expect(PROFILES[role].role).toBe(role);
  });

  it('pm has no tools at all', () => {
    // Spec §4.3: "pure text in, structured text out". An empty `tools` list is
    // what makes `argv.ts` emit `--tools ""` rather than omitting the flag and
    // handing the PM the CLI's full default toolset.
    expect(PROFILES.pm.tools).toEqual([]);
    expect(PROFILES.pm.allowedTools).toEqual([]);
    expect(PROFILES.pm.cwd).toBe('scratch');
    expect(profileTouchesRepo(PROFILES.pm)).toBe(false);
  });

  it('only the developer may Edit or Write', () => {
    for (const role of ROLES) {
      const profile = PROFILES[role];
      const writeTools = [...profile.tools, ...profile.allowedTools].filter((tool) =>
        (WRITE_TOOLS as readonly string[]).includes(tool),
      );
      if (role === 'developer') {
        expect(profile.tools).toContain('Edit');
        expect(profile.tools).toContain('Write');
      } else {
        expect(writeTools, `${role} may use ${writeTools.join(', ')}`).toEqual([]);
      }
    }
  });

  it('tl_plan, dl and code_reviewer work in a throwaway worktree, never a ticket worktree', () => {
    for (const role of ['tl_plan', 'dl', 'code_reviewer'] as const) {
      expect(PROFILES[role].cwd, `${role} must not share the developer's worktree`).toBe(
        'repo_scratch_worktree',
      );
    }
    // The two that legitimately do share it, stated here so a swap in either
    // direction is a failure rather than a silent re-shuffle.
    expect(PROFILES.developer.cwd).toBe('ticket_worktree');
    expect(PROFILES.qa.cwd).toBe('ticket_worktree');
  });

  it('every profile has a timeout within config.agent_timeout and a non-zero budget', () => {
    for (const role of ROLES) {
      const profile = profileFor(role, CONFIG);
      expect(profile.timeoutMs, `${role} timeout`).toBeGreaterThan(0);
      expect(profile.timeoutMs, `${role} timeout exceeds config.agent_timeout`).toBeLessThanOrEqual(
        CONFIG.agent_timeout * 1000,
      );
      expect(profile.maxBudgetUsd, `${role} budget`).toBeGreaterThan(0);
      expect(profile.maxBudgetUsd).toBeLessThanOrEqual(CONFIG.max_budget_usd_per_run);
    }
  });

  it('profileFor clamps to the configured ceilings rather than trusting the profile', () => {
    const tight = profileFor('developer', { agent_timeout: 60, max_budget_usd_per_run: 0.25 });
    expect(tight.timeoutMs).toBe(60_000);
    expect(tight.maxBudgetUsd).toBe(0.25);

    // A generous config never raises a profile above its own declared ceiling:
    // the profile is the floor of the two, so loosening config.agent_timeout
    // cannot silently give every role a 10-hour run.
    const loose = profileFor('pm', { agent_timeout: 36_000, max_budget_usd_per_run: 500 });
    expect(loose.timeoutMs).toBe(PROFILES.pm.timeoutMs);
    expect(loose.maxBudgetUsd).toBe(PROFILES.pm.maxBudgetUsd);
  });

  it('no profile grants a read or write path of its own', () => {
    // Plan Section E item 5: agents never write to the vault, and nothing in a
    // profile may hand one a path. `buildSandboxSettings` adds the run cwd and
    // (for repo roles) the repo root; anything here would be an extra hole, and
    // there is no legitimate one in M1–M3.
    for (const role of ROLES) {
      const sandbox = PROFILES[role].sandbox;
      expect(sandbox.denyReadHome, `${role} must deny the operator's home`).toBe(true);
      expect(sandbox.allowRead, `${role} grants extra read paths`).toEqual([]);
      expect(sandbox.allowWrite, `${role} grants extra write paths`).toEqual([]);
      expect(sandbox.denyWrite).toEqual([]);
    }
  });

  it('every repo-touching role is one the .git fence will apply to', () => {
    for (const role of ROLES) {
      const expected = PROFILES[role].cwd !== 'scratch';
      expect(profileTouchesRepo(PROFILES[role]), `${role}`).toBe(expected);
    }
  });

  it('read-only roles that run commands still get Bash, and planners do not', () => {
    // Spec §4.3's table, restated as behaviour: the reviewer and QA need to run
    // the code they are judging; the PM, TL and DL only read.
    expect(PROFILES.code_reviewer.tools).toContain('Bash');
    expect(PROFILES.qa.tools).toContain('Bash');
    expect(PROFILES.tl_plan.tools).not.toContain('Bash');
    expect(PROFILES.dl.tools).not.toContain('Bash');
  });
});

/**
 * Builders for the Phase 5 runner tests.
 *
 * The six real `AgentProfile`s are Phase 6's job. These are deliberately
 * minimal stand-ins whose only purpose is to exercise the runner: a
 * repo-touching one, a scratch one, and a spec factory. Nothing here should
 * grow into a second definition of the production profiles — when Phase 6
 * lands, these stay as test data and `src/agents/profiles.ts` becomes the
 * source of truth.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Role } from '../../src/domain/roles.js';
import type { AgentProfile, AgentRunSpec, ProfileCwdKind } from '../../src/runner/types.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RUNNER_FIXTURE_DIR = path.join(PROJECT_ROOT, 'test', 'fixtures', 'runner');

/** The stream recorded from a real CLI v2.1.220 run on 2026-09-01. */
export const REAL_STREAM_FIXTURE = path.join(RUNNER_FIXTURE_DIR, 'real-run-2026-09-01.jsonl');

export interface TestProfileOverrides {
  readonly role?: Role;
  readonly cwd?: ProfileCwdKind;
  readonly tools?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly denyReadHome?: boolean;
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBudgetUsd?: number;
}

export function testProfile(overrides: TestProfileOverrides = {}): AgentProfile {
  return {
    role: overrides.role ?? 'developer',
    cwd: overrides.cwd ?? 'ticket_worktree',
    tools: overrides.tools ?? ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    allowedTools: overrides.allowedTools ?? ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    sandbox: {
      denyReadHome: overrides.denyReadHome ?? true,
      allowRead: overrides.allowRead ?? [],
      allowWrite: overrides.allowWrite ?? [],
      denyWrite: overrides.denyWrite ?? [],
    },
    timeoutMs: overrides.timeoutMs ?? 1_800_000,
    maxBudgetUsd: overrides.maxBudgetUsd ?? 5,
  };
}

/**
 * The set of profile shapes spec §4.3 describes, reduced to what Phase 5 can
 * know: which roles work inside the repo and which do not.
 */
export const PROFILE_CWD_BY_ROLE: Readonly<Record<Role, ProfileCwdKind>> = {
  pm: 'scratch',
  tl_plan: 'repo_scratch_worktree',
  dl: 'repo_scratch_worktree',
  developer: 'ticket_worktree',
  code_reviewer: 'repo_scratch_worktree',
  qa: 'ticket_worktree',
};

export interface TestSpecOverrides {
  readonly runId?: string;
  readonly role?: Role;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly systemPromptAppend?: string;
  readonly profile?: AgentProfile;
  readonly outputSchema?: object;
  readonly model?: string;
  readonly transcriptPath?: string;
  readonly itemId?: string;
  readonly featureSlug?: string;
  readonly attempt?: number;
  readonly validateStructured?: AgentRunSpec['validateStructured'];
}

export function testSpec(overrides: TestSpecOverrides = {}): AgentRunSpec {
  const role = overrides.role ?? 'developer';
  const itemId = overrides.itemId ?? 'FEAT-DEMO-T001';
  const attempt = overrides.attempt ?? 1;
  const base: AgentRunSpec = {
    runId: overrides.runId ?? `${itemId}-${role}-a${attempt}-0`,
    role,
    cwd: overrides.cwd ?? '/tmp-not-used/worktree',
    prompt: overrides.prompt ?? 'do the thing',
    systemPromptAppend: overrides.systemPromptAppend ?? 'you are a test agent',
    profile: overrides.profile ?? testProfile({ role }),
    outputSchema: overrides.outputSchema ?? {
      type: 'object',
      properties: { outcome: { type: 'string' } },
      required: ['outcome'],
      additionalProperties: false,
    },
    model: overrides.model ?? 'sonnet',
    transcriptPath: overrides.transcriptPath ?? '/dev/null',
    itemId,
    featureSlug: overrides.featureSlug ?? 'demo',
    attempt,
  };
  return overrides.validateStructured === undefined
    ? base
    : { ...base, validateStructured: overrides.validateStructured };
}

/** The config slice the sandbox builder reads, with the shipped defaults. */
export function testSandboxConfig(
  overrides: { sandbox_extra_read?: string[]; sandbox_extra_write?: string[] } = {},
): { sandbox_extra_read: string[]; sandbox_extra_write: string[] } {
  return {
    sandbox_extra_read: overrides.sandbox_extra_read ?? [],
    sandbox_extra_write: overrides.sandbox_extra_write ?? [],
  };
}

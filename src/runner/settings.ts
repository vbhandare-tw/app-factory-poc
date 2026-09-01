/**
 * The sandbox fence (spec §4.2, §4.5; ADR-003; plan resolutions A2 and A6).
 *
 * This is the single highest-consequence file in the project. Everything the
 * orchestrator does to keep an agent away from the operator's base branch ends
 * up as the JSON this module returns, and the failure mode is silent: a run
 * with a malformed or mis-syntaxed fence starts normally, does its work, exits
 * 0, and has no fence at all. Claude Code's own `--help` says it out loud —
 * "Settings files that fail validation are silently ignored in this mode (no
 * error dialog is shown)" for `--print` runs.
 *
 * THE TRAP, stated once so nobody has to rediscover it:
 *
 *   `sandbox.filesystem.*` takes **standard** paths — `/abs`, `~/`, or a bare
 *   relative path. `permissions.*` rules take a **different** syntax — `//abs`
 *   for absolute and `/project-relative`, wrapped in `Tool(...)`. Both are
 *   valid JSON and the CLI accepts both. Writing `//Users/...` here produces a
 *   rule that matches nothing and an agent that is completely unfenced.
 *
 * A unit test cannot catch that, because a unit test on a pure function only
 * restates the author's belief about the syntax. `assertStandardSandboxPath`
 * below turns the belief into a runtime refusal, and
 * `test/integration/isolation.test.ts` is the only thing that proves the fence
 * actually blocks anything.
 *
 * NOTE FOR ANY FUTURE EDITOR: no later phase may weaken anything here to make a
 * test pass (plan Section E items 6 and 8a). If a test is hard to satisfy, the
 * test is wrong.
 */
import path from 'node:path';

import type { AgentProfile } from './types.js';
import { profileTouchesRepo } from './types.js';

/** `filesystem.denyRead` entry that fences the operator's home (spec §4.2). */
export const HOME_DENY_READ = '~/';

/**
 * The four `.git` subtrees an agent must never write (spec §4.5, ADR-003).
 *
 * `hooks` is the escape: a planted `pre-commit` runs **unsandboxed** under the
 * orchestrator later. `refs` and `objects` are how a worktree agent could move
 * `refs/heads/main` without touching a file in the main checkout. `config` is
 * how it could install a `core.hooksPath` pointing somewhere it *can* write.
 *
 * `.git/worktrees` is deliberately NOT fenced: git needs to write the current
 * worktree's own index and HEAD there, and blocking it breaks `git status`.
 */
export const GIT_FENCE_DIRS = ['hooks', 'config', 'refs', 'objects'] as const;

/**
 * Environment overrides for a sandboxed child (verified, not inherited from the
 * spec).
 *
 * Spec §4.5 claims `git status --short` and `git diff` keep working under the
 * `.git` fence. They do — but **not** under `denyRead: ["~/"]`, which the same
 * design also requires. The Phase 5 probe found every git command failing with
 * `fatal: unable to access '<home>/.gitconfig': Operation not permitted`,
 * exit 128, before it ever reached the `.git` fence. That is a fence that
 * blocks something the agent legitimately needs, which is its own kind of bug.
 *
 * The fix is to stop git looking in the home directory at all rather than to
 * punch a read hole for `~/.gitconfig` — that file can carry credential
 * helpers, signing key paths and `url.insteadOf` rewrites with tokens in them,
 * and none of it is anything an agent should see. Agents never commit
 * (ADR-003), so they need no identity from the global config.
 *
 * `XDG_CONFIG_HOME` covers the second half of the same lookup. With no global
 * config, git falls back to `$XDG_CONFIG_HOME/git/ignore` (default
 * `~/.config/git/ignore`) for `core.excludesFile`, which is also denied — and
 * git prints `warning: unable to access ...: Operation not permitted` twice per
 * command while still exiting 0. Harmless, but it lands in the agent's tool
 * output on every `git status`, and Phase 9 feeds that output straight back
 * into the retry context. Pointing it at `/dev/null` removes the warning and
 * has the side benefit of keeping the operator's personal global ignore rules
 * out of a reproducible agent run, which matches what `--safe-mode` is for.
 *
 * Both are verified against real CLI v2.1.220 by `isolation.test.ts`.
 */
export const SANDBOX_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  XDG_CONFIG_HOME: '/dev/null',
};

export function sandboxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...SANDBOX_ENV_OVERRIDES };
}

/** Only the config keys the fence reads. Keeps this module free of the whole config. */
export interface SandboxConfigView {
  readonly sandbox_extra_read: readonly string[];
  readonly sandbox_extra_write: readonly string[];
}

export interface SandboxFilesystemSettings {
  readonly denyRead: string[];
  readonly allowRead: string[];
  readonly allowWrite: string[];
  readonly denyWrite: string[];
}

export interface SandboxSettings {
  readonly sandbox: {
    /** Literal `true`. There is no code path that produces `false`. */
    readonly enabled: true;
    readonly filesystem: SandboxFilesystemSettings;
  };
}

export class SandboxPathSyntaxError extends Error {
  readonly field: string;
  readonly value: string;

  constructor(field: string, value: string, detail: string) {
    super(
      `sandbox.filesystem.${field} entry ${JSON.stringify(value)} is not a standard path: ${detail}. ` +
        'sandbox.filesystem.* uses standard paths (/abs, ~/, bare-relative). The //abs and ' +
        'Tool(...) forms belong to permissions.* rules — a rule in that syntax here is accepted ' +
        'as JSON, matches nothing, and leaves the agent unfenced (spec §4.2).',
    );
    this.name = 'SandboxPathSyntaxError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Refuse a path written in `permissions.*` syntax.
 *
 * The two detectable confusions are the `//` absolute prefix and a `Tool(...)`
 * wrapper. A `/project-relative` rule is indistinguishable from a legitimate
 * absolute path, so it cannot be caught here — which is exactly why the
 * integration probe exists.
 */
export function assertStandardSandboxPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SandboxPathSyntaxError(field, String(value), 'must be a non-empty string');
  }
  if (value.startsWith('//')) {
    throw new SandboxPathSyntaxError(field, value, 'starts with // (the permissions-rule absolute form)');
  }
  if (/^[A-Za-z][A-Za-z0-9_]*\(/.test(value)) {
    throw new SandboxPathSyntaxError(field, value, 'looks like a Tool(...) permission rule');
  }
  return value;
}

/** `<repo>/.git/{hooks,config,refs,objects}` — absolute, in a fixed order. */
export function gitFenceWritePaths(repoRoot: string): string[] {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new Error('gitFenceWritePaths: repoRoot must be a non-empty path');
  }
  const gitDir = path.join(path.resolve(repoRoot), '.git');
  return GIT_FENCE_DIRS.map((dir) => path.join(gitDir, dir));
}

/**
 * Build the object handed to `--settings` (plan Phase 5).
 *
 * Fails closed in one specific way worth calling out: a repo-touching profile
 * with no `repoRoot` **throws**. The alternative — quietly emitting a settings
 * object with an empty `denyWrite` — would produce a run that works perfectly
 * and has no `.git` fence, which is precisely the silent failure ADR-003
 * exists to prevent.
 */
export function buildSandboxSettings(
  profile: AgentProfile,
  cwd: string,
  config: SandboxConfigView,
  repoRoot?: string,
): SandboxSettings {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new Error('buildSandboxSettings: cwd must be a non-empty path');
  }
  const resolvedCwd = path.resolve(cwd);
  const touchesRepo = profileTouchesRepo(profile);

  if (touchesRepo && (repoRoot === undefined || repoRoot.trim().length === 0)) {
    throw new Error(
      `buildSandboxSettings: profile "${profile.role}" has cwd kind "${profile.cwd}", so it works ` +
        'inside the target repo and needs the .git write fence — but no repoRoot was supplied. ' +
        'Refusing to build a settings object without it (spec §4.5, plan Section E item 8a).',
    );
  }

  const resolvedRepoRoot = repoRoot === undefined ? undefined : path.resolve(repoRoot);

  const denyRead = profile.sandbox.denyReadHome ? [HOME_DENY_READ] : [];

  // The repo root is on `allowRead` for repo-touching profiles because the real
  // git directory lives outside a linked worktree (spec §4.5) and `denyRead:
  // ["~/"]` would otherwise deny git its own object store. Reading the repo is
  // not the hazard the fence is about; writing it is.
  const allowRead = [
    resolvedCwd,
    ...(touchesRepo && resolvedRepoRoot !== undefined ? [resolvedRepoRoot] : []),
    ...profile.sandbox.allowRead,
    ...config.sandbox_extra_read,
  ];

  const allowWrite = [...profile.sandbox.allowWrite, ...config.sandbox_extra_write];

  // Fence first, profile extras after. Order is fixed so the produced JSON is
  // byte-stable across runs and a diff of two settings objects is readable.
  const denyWrite = [
    ...(touchesRepo && resolvedRepoRoot !== undefined ? gitFenceWritePaths(resolvedRepoRoot) : []),
    ...profile.sandbox.denyWrite,
  ];

  return {
    sandbox: {
      enabled: true,
      filesystem: {
        denyRead: clean(denyRead, 'denyRead'),
        allowRead: clean(allowRead, 'allowRead'),
        allowWrite: clean(allowWrite, 'allowWrite'),
        denyWrite: clean(denyWrite, 'denyWrite'),
      },
    },
  };
}

/** Serialised form for `--settings`. One place, so nothing re-stringifies differently. */
export function sandboxSettingsJson(settings: SandboxSettings): string {
  return JSON.stringify(settings);
}

/** Validate every entry, then de-duplicate while keeping first-seen order. */
function clean(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const checked = assertStandardSandboxPath(value, field);
    if (seen.has(checked)) continue;
    seen.add(checked);
    out.push(checked);
  }
  return out;
}

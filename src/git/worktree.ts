/**
 * Provisioning a worktree an agent can actually work in (plan Phase 8, A3).
 *
 * ============================================================================
 * WHY THERE IS A SETUP STEP AT ALL — resolution A3
 * ============================================================================
 * A fresh `git worktree` has no `node_modules`: the directory is untracked, so
 * a new worktree is a clean checkout with nothing installed. A sandboxed agent
 * has **no network** (verified: `curl https://registry.npmjs.org/` returns exit
 * 56, HTTP 000 under `sandbox.enabled`), so it can never install them itself.
 * Without this step the Developer agent's very first `npm test` fails for a
 * reason that has nothing to do with its code, three attempts get burned, and
 * the ticket lands in `needs_human` with a misleading transcript.
 *
 * ============================================================================
 * AND WHY THAT IS A DELIBERATE TRUST BOUNDARY, STATED PLAINLY
 * ============================================================================
 * `config.setup_command` (default `npm ci`) runs **unsandboxed, with network,
 * as the orchestrator**, inside a directory built from the target repo. It is
 * the target repo's own package scripts, and `npm ci` runs whatever
 * `preinstall`/`postinstall` hooks the dependency tree carries. Nothing here
 * fences that, and nothing can: the whole point is that it does what the
 * sandbox forbids.
 *
 * What is fenced instead is the blast radius of it going wrong:
 *
 * - a deadline (`config.setup_timeout`, default 300s), then SIGTERM, then
 *   SIGKILL, so a hanging install cannot hang the factory;
 * - the output is captured and capped, and travels with the failure so a human
 *   sees the real reason;
 * - a failure **removes the worktree** and raises. The caller marks the ticket
 *   `needs_human`. An agent is never handed a half-installed tree, because a
 *   half-installed tree produces test failures that look like the agent's fault.
 *
 * The operator's protection is that `target_repo` is a path they chose. Point
 * the factory at a repo you would not run `npm ci` in, and this is where that
 * decision is cashed.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { execCapture } from './exec.js';
import type { ExecFn, ExecResult } from './exec.js';
import type { Git } from './git.js';
import {
  assertNotUnderTempRoot,
  assertOutsideRepo,
  scratchWorktreePath,
  ticketBranchName,
  ticketWorktreePath,
} from './paths.js';

export interface SetupOutcome {
  readonly command: string;
  /** False when the caller asked for no setup — a read-only role, say. */
  readonly ran: boolean;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Tail of stderr + stdout, capped. Goes into the `needs_human` detail. */
  readonly output: string;
}

const NOT_RUN: SetupOutcome = Object.freeze({
  command: '',
  ran: false,
  ok: true,
  exitCode: null,
  timedOut: false,
  durationMs: 0,
  output: '',
});

export class SetupCommandFailedError extends Error {
  readonly outcome: SetupOutcome;
  readonly worktreePath: string;

  constructor(worktreePath: string, outcome: SetupOutcome) {
    const how = outcome.timedOut
      ? `timed out after ${outcome.durationMs}ms`
      : `exited ${String(outcome.exitCode)}`;
    super(
      `setup command \`${outcome.command}\` ${how} in ${worktreePath}. The worktree has been ` +
        'removed rather than handed to an agent with a broken dependency tree ' +
        `(plan resolution A3).${outcome.output === '' ? '' : `\n${outcome.output}`}`,
    );
    this.name = 'SetupCommandFailedError';
    this.outcome = outcome;
    this.worktreePath = worktreePath;
  }
}

export interface ProvisionInput {
  readonly git: Git;
  readonly repoRoot: string;
  /** Groups this vault's worktrees. See `vaultWorktreeName`. */
  readonly vaultName: string;
  readonly ticketId: string;
  readonly featureSlug: string;
  readonly title: string;
  /** The feature branch. Ticket branches are cut from it, never from base (spec §10). */
  readonly fromRef: string;
  /** Overrides the derived name — used when the ticket note already records one. */
  readonly branch?: string | undefined;
  readonly setupCommand: string;
  readonly setupTimeoutMs: number;
  /** Skip the setup step. Read-only roles do not need dependencies. */
  readonly runSetup?: boolean;
  readonly exec?: ExecFn;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProvisionedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly setup: SetupOutcome;
  /** True when the worktree already existed and was reused as-is. */
  readonly reused: boolean;
}

/**
 * Create (or adopt) the ticket's worktree and make it ready to work in.
 *
 * Idempotent by design: reconciliation calls this every cycle for every live
 * ticket, and a worktree git already has at the right path is reused rather
 * than rebuilt. Rebuilding would re-run `npm ci` every 15 seconds and, far
 * worse, would throw away the agent's uncommitted work.
 */
export async function provisionWorktree(input: ProvisionInput): Promise<ProvisionedWorktree> {
  const worktreePath = ticketWorktreePath(input.repoRoot, input.vaultName, input.ticketId);
  const branch = input.branch ?? ticketBranchName(input.featureSlug, input.ticketId, input.title);

  const existing = await findWorktree(input.git, worktreePath);
  if (existing !== undefined && !existing.prunable) {
    return { path: worktreePath, branch: existing.branch ?? branch, setup: NOT_RUN, reused: true };
  }

  // Git keeps the registration when the directory is deleted by hand. Without
  // this, recreating it fails with "already registered" — which is the exact
  // case the plan requires reconciliation to recover from.
  if (existing !== undefined) await input.git.pruneWorktrees();

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await input.git.createWorktree(worktreePath, branch, input.fromRef);

  const setup = await runSetup(worktreePath, input);
  if (!setup.ok) {
    await destroyWorktree(input.git, worktreePath);
    throw new SetupCommandFailedError(worktreePath, setup);
  }

  return { path: worktreePath, branch, setup, reused: false };
}

export interface ScratchInput {
  readonly git: Git;
  readonly repoRoot: string;
  readonly vaultName: string;
  /** A unique-per-run label. Becomes the directory name. */
  readonly label: string;
  /** Base branch for `tl_plan`/`dl`, ticket branch for `code_reviewer` (spec §4.3). */
  readonly ref: string;
  readonly setupCommand: string;
  readonly setupTimeoutMs: number;
  readonly runSetup?: boolean;
  readonly exec?: ExecFn;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ScratchWorktree {
  readonly path: string;
  readonly setup: SetupOutcome;
  /** `git worktree remove --force`. Everything the agent wrote goes with it. */
  dispose(): Promise<void>;
}

/**
 * A throwaway worktree (spec §4.3), the mechanism that makes read-only repo
 * access real without a deny-all `Edit(//**)` glob (resolution A4).
 *
 * The agent gets a genuine worktree, the kernel confines its writes to it, and
 * the whole thing is force-removed when the run ends — so "read-only" is a
 * property of what survives rather than a property of a permission string whose
 * syntax is one slip from matching nothing.
 *
 * **Detached on purpose.** Git refuses to check out a branch that is already
 * checked out in another worktree, and the base branch is exactly the branch
 * the main checkout normally sits on. A named branch here would fail on the
 * common case and work only on the uncommon one.
 */
export async function provisionScratchWorktree(input: ScratchInput): Promise<ScratchWorktree> {
  const worktreePath = scratchWorktreePath(input.repoRoot, input.vaultName, input.label);

  // A leftover from a run that was killed mid-flight. Force-remove rather than
  // adopt: a scratch worktree carries no work worth keeping, by definition.
  const existing = await findWorktree(input.git, worktreePath);
  if (existing !== undefined) await destroyWorktree(input.git, worktreePath);
  await rm(worktreePath, { recursive: true, force: true });

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await input.git.createDetachedWorktree(worktreePath, input.ref);

  let setup: SetupOutcome;
  try {
    setup = await runSetup(worktreePath, input);
  } catch (error) {
    await destroyWorktree(input.git, worktreePath);
    throw error;
  }

  if (!setup.ok) {
    await destroyWorktree(input.git, worktreePath);
    throw new SetupCommandFailedError(worktreePath, setup);
  }

  return {
    path: worktreePath,
    setup,
    dispose: async (): Promise<void> => {
      await destroyWorktree(input.git, worktreePath);
    },
  };
}

export class ForeignWorktreeError extends Error {
  readonly worktreePath: string;
  readonly ownedBy: string;

  constructor(worktreePath: string, ownedBy: string, ourRepo: string) {
    super(
      `refusing to remove ${worktreePath}: it is a worktree of ${ownedBy}, not of ${ourRepo}. ` +
        'Removing another repository’s worktree destroys work that exists nowhere else — ' +
        'agents never commit (ADR-003), so a working tree is the only copy of what they produced.',
    );
    this.name = 'ForeignWorktreeError';
    this.worktreePath = worktreePath;
    this.ownedBy = ownedBy;
  }
}

/**
 * `git worktree remove --force`, then make sure the directory really is gone.
 *
 * ============================================================================
 * THE OWNERSHIP CHECK IS NOT DECORATION
 * ============================================================================
 * This function ends in an unconditional `rm -rf`, which makes it the single
 * most destructive primitive in the phase. `git worktree remove` alone is safe
 * — it refuses a path that is not *our* worktree — but that refusal is treated
 * here as "already gone" so that removing a directory git has forgotten still
 * works. The two together used to mean: hand this a path belonging to another
 * repository and it deletes it, in full, without an error.
 *
 * Salting the worktree root (`vaultWorktreeName`) makes two vaults unable to
 * collide in the first place, and that is the primary fix. This is the
 * backstop, and it earns its place because it guards the primitive rather than
 * one route into it: a hand-edited `target_repo`, a repo that moved, or a
 * future caller passing a path from somewhere new all arrive here, and none of
 * them are covered by a layout rule.
 *
 * A linked worktree's `.git` is a *file* containing `gitdir: <repo>/.git/worktrees/<id>`,
 * so ownership is a fact on disk rather than an inference. A directory with no
 * `.git` at all (the PM's plain scratch directory) cannot be attributed and is
 * allowed through — it holds no checkout and no agent work, and with the salt
 * in place it cannot belong to anyone else.
 */
export async function destroyWorktree(git: Git, worktreePath: string): Promise<void> {
  assertWorktreeOwnedBy(worktreePath, git.repoRoot);

  await git.removeWorktree(worktreePath, true);
  // `worktree remove` refuses some states outright; the caller has already
  // decided the tree is disposable, so the directory goes either way.
  await rm(worktreePath, { recursive: true, force: true });
  await git.pruneWorktrees();
}

/** Throws `ForeignWorktreeError` if this worktree belongs to another repository. */
export function assertWorktreeOwnedBy(worktreePath: string, repoRoot: string): void {
  const owner = worktreeOwner(worktreePath);
  if (owner === undefined) return;

  if (path.resolve(owner) !== path.resolve(repoRoot)) {
    throw new ForeignWorktreeError(path.resolve(worktreePath), owner, path.resolve(repoRoot));
  }
}

/**
 * The repository a linked worktree belongs to, read from its `.git` file.
 *
 * `undefined` means "cannot be attributed": no `.git`, an unreadable one, or a
 * shape this does not recognise. Callers treat that as "not provably foreign",
 * never as "provably ours".
 */
export function worktreeOwner(worktreePath: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path.join(worktreePath, '.git'), 'utf8');
  } catch {
    return undefined;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(contents.trim());
  const gitdir = match?.[1]?.trim();
  if (gitdir === undefined) return undefined;

  // `<repo>/.git/worktrees/<id>` → `<repo>`.
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const index = gitdir.indexOf(marker);
  return index === -1 ? undefined : gitdir.slice(0, index);
}

/** The registered worktree at this exact path, if git knows about one. */
export async function findWorktree(
  git: Git,
  worktreePath: string,
): Promise<{ readonly branch: string | null; readonly prunable: boolean } | undefined> {
  const resolved = path.resolve(worktreePath);
  const all = await git.listWorktrees();
  return all.find((entry) => entry.path === resolved);
}

async function runSetup(
  worktreePath: string,
  input: {
    readonly setupCommand: string;
    readonly setupTimeoutMs: number;
    readonly runSetup?: boolean;
    readonly exec?: ExecFn;
    readonly env?: NodeJS.ProcessEnv;
    readonly repoRoot: string;
    readonly vaultName: string;
  },
): Promise<SetupOutcome> {
  if (input.runSetup === false) return NOT_RUN;

  // Belt and braces. The path was checked when it was derived; it is checked
  // again immediately before a command runs in it, because this is the moment
  // an unfenced location would actually start to matter.
  assertNotUnderTempRoot(worktreePath, 'worktree');
  assertOutsideRepo(worktreePath, input.repoRoot);

  const exec = input.exec ?? execCapture;
  const result: ExecResult = await exec(input.setupCommand, [], {
    cwd: worktreePath,
    timeoutMs: input.setupTimeoutMs,
    shell: true,
    ...(input.env === undefined ? {} : { env: input.env }),
  });

  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');

  return {
    command: input.setupCommand,
    ran: true,
    ok: result.status === 0 && result.spawnError === null && !result.timedOut,
    exitCode: result.status,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    output: result.spawnError === null ? output : `${result.spawnError}\n${output}`.trim(),
  };
}

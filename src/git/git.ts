/**
 * The `Git` seam (spec §8.3) and the one implementation that shells out.
 *
 * Every operation goes through `git -C <repo>` with an explicit repo root. No
 * libgit2, no `process.chdir`, no relative paths: the orchestrator runs
 * concurrent-ish work against one repo and several worktrees, and a `cwd`-
 * dependent git call is the kind of bug that only shows up under load.
 *
 * **This runs unsandboxed, as the orchestrator.** It is the only writer of git
 * history (ADR-002/ADR-003 — agents never commit), which is exactly why it is
 * an interface: Phases 9–11 add gates, merges and tags on top, and a test needs
 * to be able to say "and then git failed" without arranging for git to fail.
 *
 * Two methods beyond spec §8.3's five and the plan's `tag`/`branchExists`,
 * both forced by the phase's own required tests rather than chosen:
 *
 * - **`pruneWorktrees`** — recreating a worktree whose directory was deleted
 *   from disk is impossible without it. Git still holds the registration in
 *   `.git/worktrees/<id>`, and `git worktree add` on that path fails with
 *   "already registered". The plan requires exactly that recreation.
 * - **`createDetachedWorktree`** — git refuses to check a branch out in two
 *   worktrees at once. A throwaway worktree at the base branch (spec §4.3, for
 *   `tl_plan` and `dl`) would therefore fail whenever the main checkout is on
 *   the base branch, which is the normal case. Detaching is what makes the
 *   throwaway mechanism work at all.
 */
import path from 'node:path';

import { describeExec, execCapture } from './exec.js';
import type { ExecFn, ExecResult } from './exec.js';

/** How long a single git command may take before it is killed. */
export const GIT_TIMEOUT_MS = 120_000;

export interface WorktreeInfo {
  /** Absolute, resolved as git reports it. */
  readonly path: string;
  readonly head: string | null;
  /** Short branch name (`feat/x/t001-y`), or `null` when detached. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** Git's own word for "the directory is gone but the registration is not". */
  readonly prunable: boolean;
  readonly locked: boolean;
  /** The repo's own working tree, which is never a factory worktree. */
  readonly isMain: boolean;
}

export type MergeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflicts: string[]; readonly detail: string };

export interface Git {
  /** The repository every operation is against. Absolute and resolved. */
  readonly repoRoot: string;
  createWorktree(worktreePath: string, branch: string, fromRef: string): Promise<void>;
  /** No branch: a detached checkout at `ref`. See the header note. */
  createDetachedWorktree(worktreePath: string, ref: string): Promise<void>;
  removeWorktree(worktreePath: string, force: boolean): Promise<void>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  /** Drop registrations whose directory is gone. See the header note. */
  pruneWorktrees(): Promise<void>;
  mergeNoFf(into: string, from: string): Promise<MergeResult>;
  diff(baseRef: string, headRef: string): Promise<string>;
  tag(name: string, ref: string): Promise<void>;
  branchExists(branch: string): Promise<boolean>;
  /**
   * Create `branch` at `fromRef` if it does not exist. Returns whether it was
   * created.
   *
   * Needed because spec §10 cuts ticket branches from the **feature** branch,
   * and nothing before this phase ever creates a feature branch. A ticket
   * worktree provisioned before one exists would be cut from base, which is the
   * one thing requirements §10 forbids.
   */
  ensureBranch(branch: string, fromRef: string): Promise<boolean>;
  /** Tracked-and-untracked porcelain status for a worktree. Empty means clean. */
  status(worktreePath: string): Promise<string>;
  /** `git check-ref-format refs/heads/<name>` — git's own opinion, not ours. */
  isValidBranchName(branch: string): Promise<boolean>;
}

export class GitCommandError extends Error {
  readonly result: ExecResult;

  constructor(result: ExecResult) {
    super(`git command failed: ${describeExec(result)}`);
    this.name = 'GitCommandError';
    this.result = result;
  }
}

export interface ShellGitOptions {
  readonly repoRoot: string;
  readonly exec?: ExecFn;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export class ShellGit implements Git {
  readonly repoRoot: string;
  private readonly exec: ExecFn;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(options: ShellGitOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.exec = options.exec ?? execCapture;
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    this.env = options.env;
  }

  async createWorktree(worktreePath: string, branch: string, fromRef: string): Promise<void> {
    // `-B` rather than `-b`: reconciliation recreates a worktree for a ticket
    // that already owns a branch, and `-b` fails outright on an existing one.
    // The distinction that matters is handled a level up, in `worktree.ts`,
    // which only reuses a branch it can see already exists.
    const exists = await this.branchExists(branch);
    const args = exists
      ? ['worktree', 'add', '--quiet', worktreePath, branch]
      : ['worktree', 'add', '--quiet', '-b', branch, worktreePath, fromRef];
    await this.must(args);
  }

  async createDetachedWorktree(worktreePath: string, ref: string): Promise<void> {
    await this.must(['worktree', 'add', '--quiet', '--detach', worktreePath, ref]);
  }

  async removeWorktree(worktreePath: string, force: boolean): Promise<void> {
    const result = await this.run([
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      worktreePath,
    ]);
    if (result.status !== 0) {
      // A directory that is already gone is not a failure to remove it — the
      // desired end state is reached. Anything else is real and is raised.
      const missing = /is not a working tree|No such file or directory|not a valid path/i.test(
        `${result.stderr}${result.stdout}`,
      );
      if (!missing) throw new GitCommandError(result);
    }
    // Always prune: `worktree remove` leaves nothing behind, but the failure
    // path above may have, and a stale registration blocks re-adding the path.
    await this.pruneWorktrees();
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const out = await this.must(['worktree', 'list', '--porcelain']);
    return parseWorktreeList(out.stdout, this.repoRoot);
  }

  async pruneWorktrees(): Promise<void> {
    await this.must(['worktree', 'prune']);
  }

  async mergeNoFf(into: string, from: string): Promise<MergeResult> {
    const checkout = await this.run(['checkout', '--quiet', into]);
    if (checkout.status !== 0) throw new GitCommandError(checkout);

    const merge = await this.run(['merge', '--no-ff', '--no-edit', from]);
    if (merge.status === 0) return { ok: true };

    const conflicted = await this.run(['diff', '--name-only', '--diff-filter=U']);
    const conflicts = conflicted.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    // Leave nothing half-merged. ADR-004 escalates a conflict to a human, and a
    // repo stuck mid-merge would break every later git command in the cycle.
    await this.run(['merge', '--abort']);

    return { ok: false, conflicts, detail: describeExec(merge) };
  }

  async diff(baseRef: string, headRef: string): Promise<string> {
    const result = await this.must(['diff', `${baseRef}...${headRef}`]);
    return result.stdout;
  }

  async tag(name: string, ref: string): Promise<void> {
    await this.must(['tag', name, ref]);
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.run([
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    if (result.spawnError !== null) throw new GitCommandError(result);
    return result.status === 0;
  }

  async ensureBranch(branch: string, fromRef: string): Promise<boolean> {
    if (await this.branchExists(branch)) return false;
    await this.must(['branch', branch, fromRef]);
    return true;
  }

  async status(worktreePath: string): Promise<string> {
    const result = await this.run(['status', '--porcelain'], worktreePath);
    if (result.status !== 0) throw new GitCommandError(result);
    return result.stdout;
  }

  async isValidBranchName(branch: string): Promise<boolean> {
    const result = await this.run(['check-ref-format', `refs/heads/${branch}`]);
    if (result.spawnError !== null) throw new GitCommandError(result);
    return result.status === 0;
  }

  /** Run in the repo, or in `cwd` when a worktree is the subject. */
  private run(args: readonly string[], cwd = this.repoRoot): Promise<ExecResult> {
    return this.exec('git', ['-C', cwd, ...args], {
      cwd,
      timeoutMs: this.timeoutMs,
      ...(this.env === undefined ? {} : { env: this.env }),
    });
  }

  private async must(args: readonly string[], cwd = this.repoRoot): Promise<ExecResult> {
    const result = await this.run(args, cwd);
    if (result.status !== 0 || result.spawnError !== null) throw new GitCommandError(result);
    return result;
  }
}

/**
 * `git worktree list --porcelain` → structured entries.
 *
 * Exported because the parser is the part that can be wrong in a way nothing
 * else notices: a missed `prunable` line makes reconciliation think a worktree
 * that git has already given up on is live, and it will then refuse to recreate
 * it forever.
 */
export function parseWorktreeList(stdout: string, repoRoot: string): WorktreeInfo[] {
  const infos: WorktreeInfo[] = [];
  const main = path.resolve(repoRoot);

  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const first = lines[0] ?? '';
    if (!first.startsWith('worktree ')) continue;

    const worktreePath = path.resolve(first.slice('worktree '.length).trim());
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let prunable = false;
    let locked = false;

    for (const line of lines.slice(1)) {
      if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (line === 'detached' || line.startsWith('detached ')) detached = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
    }

    infos.push({
      path: worktreePath,
      head,
      branch,
      detached,
      prunable,
      locked,
      isMain: worktreePath === main,
    });
  }

  return infos;
}

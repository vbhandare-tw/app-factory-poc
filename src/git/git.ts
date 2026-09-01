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

/** How many pathspecs go into one `git add`. Keeps the argv under ARG_MAX. */
const ADD_CHUNK = 200;

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

/**
 * One line of `git status --porcelain=v1 -z`.
 *
 * `path` is what a pathspec would name today; `originalPath` is the other half
 * of a rename or copy. Both are needed by `commit.ts`: staging a rename by its
 * new name alone leaves the deletion of the old name unstaged, so the commit
 * would carry the file twice.
 */
export interface StatusEntry {
  /** Index status. `?` for untracked, `!` for ignored. */
  readonly x: string;
  /** Working-tree status. */
  readonly y: string;
  readonly path: string;
  readonly originalPath: string | null;
}

/** Who the orchestrator's commits are by (resolution A6 — agents never commit). */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * The orchestrator's own identity.
 *
 * Passed explicitly on every commit rather than inherited from the machine, for
 * two reasons. A target repo on a fresh host may have no `user.email` at all,
 * and `git commit` then fails with a message about running `git config` — a
 * failure that has nothing to do with the ticket. And the commit's authorship is
 * the visible half of resolution A6: `git log` on a ticket branch should say, in
 * as many words, that a machine wrote it and that the agent did not.
 */
export const ORCHESTRATOR_IDENTITY: GitIdentity = Object.freeze({
  name: 'App Factory orchestrator',
  email: 'orchestrator@app-factory.invalid',
});

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

  // --- Phase 9: the orchestrator is the only writer of git history ---------
  //
  // Five additions beyond spec §8.3, all of them forced by resolution A6. The
  // Developer leaves a dirty tree and proposes a message; something has to
  // stage it, commit it, and be able to say afterwards exactly what landed. A
  // test also has to be able to say "and then the commit failed" without
  // arranging for git to fail, which is why these are on the interface rather
  // than being shelled out from `commit.ts` directly.

  /**
   * Structured `git status --porcelain=v1 -z`, optionally including ignored paths.
   *
   * `allUntracked` chooses between git's two collapse behaviours, and the choice
   * is load-bearing rather than a tuning knob — see the implementation.
   */
  statusEntries(
    worktreePath: string,
    options?: { readonly includeIgnored?: boolean; readonly allUntracked?: boolean },
  ): Promise<StatusEntry[]>;
  /** `git add -- <pathspecs>`. Never `-A`: see `src/orchestrator/commit.ts`. */
  add(worktreePath: string, pathspecs: readonly string[]): Promise<void>;
  /** `git diff --cached --name-only` — what a commit right now would carry. */
  stagedPaths(worktreePath: string): Promise<string[]>;
  /** Commit the index. Returns the new SHA. Hooks are not run — see the impl. */
  commit(worktreePath: string, message: string, identity: GitIdentity): Promise<string>;
  /** `git rev-parse <ref>`; `null` when the ref does not resolve (an unborn branch). */
  revParse(worktreePath: string, ref: string): Promise<string | null>;
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

  /**
   * ============================================================================
   * THE `-u` MODE IS NOT A TUNING KNOB
   * ============================================================================
   * git collapses a wholly-untracked or wholly-ignored **directory** to a single
   * entry under `--untracked-files=normal`, and lists its files individually
   * under `=all`. Both behaviours are needed, for opposite reasons, and using
   * one where the other belongs is a silent correctness bug:
   *
   * - **`normal` (the default here)** is what the staging comparison needs. It is
   *   also the cheap answer — a target repo that does not ignore `node_modules`
   *   would otherwise enumerate every file in it on every status call (the
   *   Phase 8 debt, met again here) — but the real reason is that a directory
   *   that was already there must compare *equal to itself* across the snapshot
   *   and the commit. Mixing modes between the two makes `node_modules/` and
   *   `node_modules/left-pad/index.js` look like different things.
   * - **`all` + `--ignored`** is what the ignored-artefact prune needs. Under
   *   `normal`, a `dist/` that already existed swallows a file the agent has
   *   just written into it: git reports the same single `!! dist/` entry before
   *   and after, so nothing fresh is detectable. That reopens the
   *   hidden-dependency escape on every attempt after the first — the gates pass
   *   on a file the commit cannot carry, and it surfaces at the merge.
   *
   * Verified against git's own output rather than its documentation:
   * `--ignored=traditional --untracked-files=all` lists `dist/old-build.js` and
   * `dist/secret.txt` separately, while `--ignored=matching` collapses both to
   * `dist/` and would **not** fix it.
   */
  async statusEntries(
    worktreePath: string,
    options: { readonly includeIgnored?: boolean; readonly allUntracked?: boolean } = {},
  ): Promise<StatusEntry[]> {
    const untracked = options.allUntracked === true ? 'all' : 'normal';
    const args = ['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`];
    if (options.includeIgnored === true) args.push('--ignored=traditional');
    const result = await this.must(args, worktreePath);
    return parsePorcelainZ(result.stdout);
  }

  async add(worktreePath: string, pathspecs: readonly string[]): Promise<void> {
    if (pathspecs.length === 0) return;
    // Chunked: a Developer that touched a thousand files must not fail on
    // ARG_MAX, and the failure it would produce ("argument list too long") gives
    // no hint that the fix is batching.
    for (let index = 0; index < pathspecs.length; index += ADD_CHUNK) {
      const chunk = pathspecs.slice(index, index + ADD_CHUNK);
      await this.must(['add', '--', ...chunk], worktreePath);
    }
  }

  async stagedPaths(worktreePath: string): Promise<string[]> {
    const result = await this.must(['diff', '--cached', '--name-only'], worktreePath);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  /**
   * Commit whatever is staged.
   *
   * **No repository hook runs here, and `--no-verify` alone does not achieve
   * that.** A hook would execute unsandboxed, as the orchestrator, against a
   * tree an agent has just written — the exact escape route spec §4.5 closes by
   * denying agents write access to `.git/hooks`, reopened one level up through a
   * hook the *repository* carries rather than one the agent planted. That is not
   * hypothetical: husky-style setups point `core.hooksPath` at a **tracked**
   * directory during `npm ci`, which the agent may edit like any other worktree
   * file, and linked worktrees share `.git/config` with the main checkout.
   *
   * `--no-verify` covers `pre-commit` and `commit-msg` and nothing else —
   * `prepare-commit-msg` and `post-commit` still fire, which a live probe
   * confirmed. `core.hooksPath=/dev/null` is what actually closes it, and it is
   * passed as config rather than relied on from the environment because the
   * value in `.git/config` is the one an agent could have changed. Both are kept:
   * the flag states the intent at the call site, the config enforces it.
   *
   * Quality is the gates' job (ADR-004), and the gates run after this, on the
   * committed state — so nothing is lost by refusing to run the repo's hooks.
   *
   * `commit.gpgsign=false` for the same class of reason: a signing prompt in a
   * headless orchestrator is a hang, not a refusal.
   */
  async commit(worktreePath: string, message: string, identity: GitIdentity): Promise<string> {
    await this.must(
      [
        '-c',
        `user.name=${identity.name}`,
        '-c',
        `user.email=${identity.email}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--no-verify',
        '--quiet',
        '--message',
        message,
      ],
      worktreePath,
    );
    const sha = await this.revParse(worktreePath, 'HEAD');
    if (sha === null) {
      throw new Error(`committed in ${worktreePath} but HEAD does not resolve`);
    }
    return sha;
  }

  async revParse(worktreePath: string, ref: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], worktreePath);
    if (result.spawnError !== null) throw new GitCommandError(result);
    const sha = result.stdout.trim();
    return result.status === 0 && sha !== '' ? sha : null;
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
 * `git status --porcelain=v1 -z` → structured entries.
 *
 * Exported because the NUL framing is the part that is easy to get subtly
 * wrong, and getting it wrong is invisible: a rename parsed as one entry stages
 * the new path and leaves the old one's deletion behind, so the commit carries
 * the file under both names and the gates still pass.
 *
 * The format is `XY<space><path>NUL`, except that when `X` is `R` or `C` the
 * **next** NUL-separated token is the original path and belongs to the same
 * entry. `-z` also means no quoting or escaping at all, which is exactly why it
 * is used here rather than the human-readable form.
 */
export function parsePorcelainZ(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\0').filter((token) => token !== '');
  const entries: StatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.length < 4) continue;
    const x = token[0] ?? ' ';
    const y = token[1] ?? ' ';
    const filePath = token.slice(3);

    let originalPath: string | null = null;
    if (x === 'R' || x === 'C') {
      originalPath = tokens[index + 1] ?? null;
      index += 1;
    }

    entries.push({ x, y, path: filePath, originalPath });
  }

  return entries;
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

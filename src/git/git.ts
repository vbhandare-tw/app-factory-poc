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

/**
 * The `-c` prefix **every** command that checks anything out or moves any ref
 * carries.
 *
 * One definition, because the whole value of the fence is that no writing path
 * is missing it — two copies are two things that can drift, and the one that
 * drifts is the escape. `test/unit/git/hooks.test.ts` pins the class rather
 * than the call sites: a method added later fails that test until it is
 * classified as a writer or as a read. **`commit`'s own comment states the
 * full reasoning; read that first.**
 *
 * ==========================================================================
 * WHY THIS IS THE WHOLE CLASS AND NOT JUST `commit`
 * ==========================================================================
 * Phase 9 closed this for `git commit`. Phase 10's review found `mergeNoFf`,
 * `checkout` and `resetBranch` open, and then the same grep found the rest.
 * Probed against real git, with `core.hooksPath` pointed at a **tracked**
 * directory — which is what a husky-style `prepare` script does when Phase 8's
 * unsandboxed `setup_command` runs `npm ci`, and `.git/config` is shared by
 * every linked worktree:
 *
 * - `mergeNoFf` ran `pre-merge-commit`, `prepare-commit-msg`, `commit-msg` and
 *   `post-merge` — four agent-authored scripts, unsandboxed, as the
 *   orchestrator, in the operator's own checkout.
 * - `checkout` and `worktree add` ran `post-checkout`.
 * - Every ref move — `branch`, `branch -D`, `tag`, `reset --hard`,
 *   `worktree prune` — ran `reference-transaction`.
 *
 * **`worktree add` is the one that matters most**, and it is the reason this is
 * a class fix rather than three call sites: it is the most frequently executed
 * git command in the factory (once per ticket provisioning, and again for every
 * post-merge gate run), and the chain to it needs no agent to commit anything.
 * The orchestrator commits the agent's work to the ticket branch (ADR-003), the
 * merge lands that branch on the feature branch, and the next ticket's worktree
 * is cut from a feature branch that now carries the script.
 *
 * `--no-verify` is passed alongside where git accepts it, for the reason
 * `commit` gives, and it covers none of the above on its own.
 *
 * ==========================================================================
 * WHAT THE IDENTITY AND `gpgsign` FLAGS DO ON A NON-COMMITTING COMMAND
 * ==========================================================================
 * Nothing, and that is deliberate — one set, applied uniformly, is what makes
 * "did this path get the fence?" answerable by looking. They matter on exactly
 * the three commands that write an object: `commit`, `mergeNoFf`'s merge
 * commit, which without them is authored by whoever owns the checkout
 * (resolution A6: `git log` should say a machine wrote it), and `tag`. On a ref
 * move or a checkout git never reads them.
 *
 * ==========================================================================
 * CORRECTED IN PHASE 11 — `tag.gpgsign` IS NOT ONLY AN ANNOTATED-TAG SETTING
 * ==========================================================================
 * **What this comment used to say:** that `commit.gpgsign=false` "says nothing
 * about `tag.gpgsign`", and that `tag` was safe without it because the tag it
 * makes is lightweight. That is wrong, and Phase 11's first real-git probe of
 * the feature close is what found it.
 *
 * `tag.gpgsign=true` does not merely sign an *annotated* tag — it promotes a
 * bare `git tag <name> <ref>` into a signed one, which then has no message and
 * dies. Probed on git 2.39.5:
 *
 *     git tag plain/1 HEAD                    # exit 0, cat-file -t → commit
 *     git config tag.gpgsign true
 *     git tag signed/1 HEAD                   # exit 128, "fatal: no tag message?"
 *     git -c tag.gpgsign=false tag ok/1 HEAD  # exit 0, cat-file -t → commit
 *
 * So a target repo with `tag.gpgsign=true` broke the feature close outright,
 * with an error message ("no tag message?") that points at nothing an operator
 * could act on. It is in the shared set rather than on `tag` alone for the same
 * reason `core.hooksPath` is: two copies are two things that can drift, and the
 * one that drifts is the one nobody is looking at. It is inert everywhere else.
 */
function orchestratorGitConfig(identity: GitIdentity = ORCHESTRATOR_IDENTITY): string[] {
  return [
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
  ];
}

/**
 * Tracked paths a checkout has changed, from its porcelain entries.
 *
 * Untracked (`?`) and ignored (`!`) are excluded on purpose: `git checkout`
 * refuses rather than silently overwriting an untracked file, `reset --hard`
 * does not delete one, and refusing a merge because the repo has a `notes.txt`
 * in it is a usability trap that reads as a bug.
 *
 * `x` is the **index** column, so a plain unstaged edit is ` M` — `x` is a
 * space. Filtering on `x` alone being "interesting" would read every unstaged
 * edit as a clean checkout, which is exactly the state `reset --hard` destroys.
 * Shared by `merge.ts`'s pre-merge refusal and `ShellGit.resetBranch`'s
 * last-moment re-check so both answer the question the same way.
 */
export function dirtyTrackedPaths(entries: readonly StatusEntry[]): string[] {
  return entries
    .filter((entry) => entry.x !== '?' && entry.x !== '!')
    .map((entry) => entry.path)
    .sort();
}

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
  /**
   * `git merge-base --is-ancestor <ancestor> <descendant>` — is every commit
   * reachable from `ancestor` also reachable from `descendant`?
   *
   * Added by the base-branch gate (plan Phase 12). It is what lets the close
   * answer "has the tree that is about to land already been gated?" without
   * running anything: when the base branch tip is an ancestor of the verified
   * feature commit, `git merge --no-ff` produces a commit whose **tree is the
   * feature commit's tree**, which the feature-branch gates just passed. When it
   * is not, the base carries commits nobody has gated and the close has to say
   * so.
   *
   * A read: `merge-base` moves no ref, checks nothing out, and runs no hook.
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /**
   * The parent commits of `ref`, in git's own order.
   *
   * Used by the close to answer one question and only one: **is the commit I am
   * about to tag a merge that carries the verified feature commit?** A resumed
   * close — one whose first attempt merged and then failed at the tag — merges
   * nothing the second time, so whatever the base branch tip happens to be by
   * then is what would get tagged. See `closeFeature`.
   *
   * A read: `rev-list` moves no ref and runs no hook.
   */
  parentsOf(ref: string): Promise<readonly string[]>;

  // --- Phase 10: the ticket merge --------------------------------------------
  //
  // Four additions, all of them about the **main checkout** rather than about a
  // worktree. `mergeNoFf` already checks the feature branch out in `repoRoot`
  // and leaves it there, so Phase 10 needs to know what was checked out before,
  // put it back, undo a merge that its own gates rejected, and delete the ticket
  // branch once the work has landed.
  //
  // On the interface rather than shelled out from `merge.ts` for the reason the
  // header gives: a test has to be able to say "and then git failed" without
  // arranging for git to fail — and for the revert path especially, a test has
  // to be able to assert that the reset was *asked for* rather than inferring it
  // from a SHA that might have moved for some other reason.

  /** The branch checked out in `worktreePath`, or `null` when HEAD is detached. */
  currentBranch(worktreePath?: string): Promise<string | null>;
  /** `git checkout [--detach] <target>` in the main checkout. */
  checkout(target: string, options?: { readonly detach?: boolean }): Promise<void>;
  /**
   * Move `branch` to `sha`, whether or not it is the branch currently checked
   * out in the main checkout. See the implementation for what that costs.
   */
  resetBranch(branch: string, sha: string): Promise<void>;
  /** `git branch -d/-D <branch>`. */
  deleteBranch(branch: string, options?: { readonly force?: boolean }): Promise<void>;
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
    // `worktree add` performs a checkout, so it runs `post-checkout` — and it
    // is the most frequently executed git command in the factory (every ticket
    // provisioning, and again for every post-merge gate run). The branch it
    // checks out may already carry an agent-authored hook script, brought in by
    // an earlier ticket's merge, with no agent having ever committed anything.
    const args = exists
      ? [...orchestratorGitConfig(), 'worktree', 'add', '--quiet', worktreePath, branch]
      : [...orchestratorGitConfig(), 'worktree', 'add', '--quiet', '-b', branch, worktreePath, fromRef];
    await this.must(args);
  }

  async createDetachedWorktree(worktreePath: string, ref: string): Promise<void> {
    await this.must([
      ...orchestratorGitConfig(),
      'worktree',
      'add',
      '--quiet',
      '--detach',
      worktreePath,
      ref,
    ]);
  }

  async removeWorktree(worktreePath: string, force: boolean): Promise<void> {
    const result = await this.run([
      ...orchestratorGitConfig(),
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
    // Drops `.git/worktrees/<id>` registrations, which is a ref change —
    // `reference-transaction` fires. See `orchestratorGitConfig`.
    await this.must([...orchestratorGitConfig(), 'worktree', 'prune']);
  }

  /**
   * `git merge --no-ff`, with the repository's own hooks disarmed.
   *
   * See `orchestratorGitConfig` for why, and `commit` for the full argument.
   * The short version: this runs in the operator's checkout, against a tree the
   * ticket branch has just brought in, and a repo hook there executes
   * unsandboxed as the orchestrator. `--no-verify` states the intent at the
   * call site; `core.hooksPath=/dev/null` is what enforces it.
   */
  async mergeNoFf(into: string, from: string): Promise<MergeResult> {
    const checkout = await this.run([...orchestratorGitConfig(), 'checkout', '--quiet', into]);
    if (checkout.status !== 0) throw new GitCommandError(checkout);

    const merge = await this.run([
      ...orchestratorGitConfig(),
      'merge',
      '--no-verify',
      '--no-ff',
      '--no-edit',
      from,
    ]);
    if (merge.status === 0) return { ok: true };

    const conflicted = await this.run(['diff', '--name-only', '--diff-filter=U']);
    const conflicts = conflicted.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    // Leave nothing half-merged. ADR-004 escalates a conflict to a human, and a
    // repo stuck mid-merge would break every later git command in the cycle.
    await this.run([...orchestratorGitConfig(), 'merge', '--abort']);

    return { ok: false, conflicts, detail: describeExec(merge) };
  }

  async diff(baseRef: string, headRef: string): Promise<string> {
    const result = await this.must(['diff', `${baseRef}...${headRef}`]);
    return result.stdout;
  }

  /**
   * A **lightweight** tag, with hooks disarmed and signing switched off.
   *
   * `reference-transaction` fires for the ref this creates. Phase 11 tags the
   * base branch, so this is a base-branch write on a tree that may carry an
   * agent-authored hook script.
   *
   * **`tag.gpgsign=false` in the shared config is what keeps this lightweight,
   * and it was not always there.** `tag.gpgsign=true` in the target repo
   * promotes even a bare `git tag <name> <ref>` into a signed tag, which has no
   * message and exits 128 with "fatal: no tag message?" — see
   * `orchestratorGitConfig`, which carries the probe. No `-a` and no `-s` here;
   * adding either would make the tag annotated on purpose, and this method's
   * callers rely on `cat-file -t` reporting the commit.
   */
  async tag(name: string, ref: string): Promise<void> {
    await this.must([...orchestratorGitConfig(), 'tag', name, ref]);
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
    await this.must([...orchestratorGitConfig(), 'branch', branch, fromRef]);
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
        // Byte-for-byte what this method has always passed. Shared with the
        // merge, checkout and reset paths so the set cannot drift between them.
        ...orchestratorGitConfig(identity),
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

  /**
   * Exit 0 is yes, exit 1 is no, anything else is git failing to answer.
   *
   * The third case raises rather than returning `false`, because `false` is the
   * answer that makes the close demand a gate run it may not be able to do, and
   * "git could not tell us" is not the same fact as "the base has moved".
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      this.repoRoot,
    );
    if (result.spawnError !== null) throw new GitCommandError(result);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new GitCommandError(result);
  }

  /**
   * `git rev-list --parents -n 1 <ref>` prints the commit followed by its
   * parents on one line. The first token is dropped; a root commit has none.
   */
  async parentsOf(ref: string): Promise<readonly string[]> {
    const result = await this.run(['rev-list', '--parents', '-n', '1', ref], this.repoRoot);
    if (result.spawnError !== null || result.status !== 0) throw new GitCommandError(result);
    return result.stdout.trim().split(/\s+/).filter((token) => token !== '').slice(1);
  }

  async currentBranch(worktreePath: string = this.repoRoot): Promise<string | null> {
    const result = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath);
    if (result.spawnError !== null) throw new GitCommandError(result);
    // Exit 1 with no output is git's way of saying "detached", which is a fact
    // about the checkout rather than a failure to read it.
    const branch = result.stdout.trim();
    return result.status === 0 && branch !== '' ? branch : null;
  }

  /** Hooks disarmed — `post-checkout` runs here otherwise. See `orchestratorGitConfig`. */
  async checkout(target: string, options: { readonly detach?: boolean } = {}): Promise<void> {
    const args = [...orchestratorGitConfig(), 'checkout', '--quiet'];
    if (options.detach === true) args.push('--detach');
    args.push(target);
    await this.must(args);
  }

  /**
   * Move a branch, by force.
   *
   * `git branch --force` is the whole job **unless** the branch is checked out
   * somewhere, and after a merge it always is: `mergeNoFf` checks the feature
   * branch out in the main checkout and leaves it there. Git refuses to move a
   * checked-out branch by name, so the fallback is `git reset --hard` in the
   * checkout that holds it.
   *
   * `--hard` in the operator's own checkout is the most destructive thing this
   * class does, and it is only reachable because `merge.ts` **refuses to merge
   * at all when the main checkout carries uncommitted tracked changes**. That
   * refusal is what makes this safe; do not weaken it without removing this
   * fallback. The fallback also only fires for the branch this checkout is
   * actually on, so a branch checked out in some *other* worktree still raises
   * rather than being silently reset there.
   *
   * ==========================================================================
   * PHASE 10: THE PRE-MERGE REFUSAL IS NOT ENOUGH ON ITS OWN
   * ==========================================================================
   * That refusal happens **once, before the merge**, and the post-merge gates
   * run in between — for as long as the target repo's test suite takes. A human
   * who edits a tracked file in that window was clean when we looked and is
   * dirty by the time we get here. Probed against real git: an edit made during
   * the gate window came back as its pre-merge content, and an edit to a file
   * the merge had just brought in was deleted outright.
   *
   * Two things close it, and this is the second. `merge.ts` now puts the
   * checkout back on its own branch *before* reverting, so `git branch --force`
   * succeeds and this fallback is never reached in the normal case. It is still
   * reached when the operator genuinely started on the feature branch, or when
   * that restore failed — and `restoreCheckout` deliberately never throws, so a
   * failed restore is silent. So the check is re-run here, at the last possible
   * moment, and a dirty checkout **raises instead of resetting**.
   *
   * That direction is deliberate: the caller surfaces the raise as
   * `merge_revert_failed` and parks the ticket telling a human to reset the
   * branch by hand. A bad merge left on a branch is recoverable by anyone who
   * reads that message; a deleted edit is not recoverable by anyone.
   */
  async resetBranch(branch: string, sha: string): Promise<void> {
    const forced = await this.run([...orchestratorGitConfig(), 'branch', '--force', branch, sha]);
    if (forced.status === 0 && forced.spawnError === null) return;
    if (forced.spawnError !== null) throw new GitCommandError(forced);

    const current = await this.currentBranch(this.repoRoot);
    if (current !== branch) throw new GitCommandError(forced);

    const dirty = dirtyTrackedPaths(await this.statusEntries(this.repoRoot));
    if (dirty.length > 0) {
      throw new Error(
        `refusing to run \`git reset --hard\` in ${this.repoRoot}: it is on ${branch} and has ` +
          `uncommitted changes to ${dirty.join(', ')}, which the reset would destroy. ` +
          `${branch} has been left where it is — move it to ${sha} by hand once that work is ` +
          'committed or stashed. An unwanted commit on a branch can be undone; an overwritten ' +
          'edit cannot.',
      );
    }

    await this.must([...orchestratorGitConfig(), 'reset', '--hard', '--quiet', sha]);
  }

  async deleteBranch(branch: string, options: { readonly force?: boolean } = {}): Promise<void> {
    await this.must([
      ...orchestratorGitConfig(),
      'branch',
      options.force === true ? '-D' : '-d',
      branch,
    ]);
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

/**
 * The orchestrator commits; the agent never does (resolution A6, spec §4.5).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 * A linked worktree's real git directory lives at `<repo>/.git/worktrees/<id>`,
 * **outside** the worktree, and the sandbox has to permit writes there or
 * `git commit` inside a worktree could not work. `.git` is shared by every
 * worktree, so an agent that can write it can move `refs/heads/main` or plant a
 * `pre-commit` hook that later runs unsandboxed as the orchestrator. The
 * mitigation the plan chose is not a narrower permission — it is removing the
 * capability: the Developer edits files, runs tests, leaves the tree dirty, and
 * *proposes* a commit message. This module applies it, after the agent's process
 * has exited.
 *
 * ============================================================================
 * THE ORDERING THAT IS THE WHOLE POINT
 * ============================================================================
 * Commit, **then** gate. Spec §9: gates run against the committed state, so what
 * is verified is exactly what will be merged. Reverse those two and the gates
 * pass on files the commit then leaves behind — a file `git add` skipped, or
 * anything a `.gitignore` rule matches — and the ticket advances carrying a
 * commit that does not build. It surfaces at the Phase 10 merge, looking like a
 * merge problem.
 *
 * Two things here make that ordering mean something rather than merely happen in
 * the right order:
 *
 * 1. **The commit is verified clean afterwards.** Once the commit lands, nothing
 *    the agent produced may still be sitting unstaged in the tree. If anything
 *    is, this refuses rather than letting the gates run against a tree that is
 *    not the commit.
 * 2. **Ignored artefacts the agent created are removed before the gates run.**
 *    This is the hole a clean-tree check alone does *not* close, because
 *    `git status` does not report ignored files. An agent that writes a module
 *    into `dist/` (or any other ignored path) and imports it produces a tree
 *    whose tests pass and a commit whose tests cannot. Deleting those files puts
 *    the worktree back to what the commit says, so a red gate is what a human
 *    sees instead of a green gate and a broken merge three phases later.
 *
 * The residual, stated plainly: an ignored path that existed **before** the
 * agent ran is left alone. It has to be — `node_modules` is exactly such a path,
 * and the gates need it. So the guarantee is "the worktree equals the commit,
 * modulo what the repo itself declares is not source", which is the strongest
 * cheap guarantee available without a fresh checkout and a fresh `npm ci` per
 * gate run.
 *
 * ============================================================================
 * AND WHY THERE IS NO `git add -A`
 * ============================================================================
 * `-A` stages whatever is sitting in the worktree. The Phase 8 ledger records
 * that a target repo which does not ignore its install output reads **every**
 * provisioned worktree as dirty — so on such a repo `-A` commits the entire
 * dependency tree, once per attempt, and the only symptom is a slow merge and a
 * very large branch.
 *
 * Instead, a snapshot is taken immediately before the agent runs, and only paths
 * that changed **relative to that snapshot** are staged. Whatever was already
 * dirty was not the agent's work, whether or not the repo has a sensible
 * `.gitignore`. That is a property of this module rather than a requirement on
 * the operator's repo.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { ORCHESTRATOR_IDENTITY } from '../git/git.js';
import type { Git, GitIdentity, StatusEntry } from '../git/git.js';

/**
 * What the worktree looked like before the agent touched it.
 *
 * Three sets rather than two, because git answers "what is ignored here" in two
 * different shapes and both are needed:
 *
 * - `ignored` is the **per-file** answer (`--ignored --untracked-files=all`).
 *   The prune diffs against it, and it has to be per-file or a `dist/` that
 *   already exists hides every file the agent later writes into it.
 * - `ignoredRoots` is the **collapsed** answer (`--untracked-files=normal`):
 *   `node_modules/`, `dist/`. The staging filter needs these as prefixes,
 *   because an agent that deletes `.gitignore` flips the whole directory to
 *   untracked and git then reports it collapsed — a shape that matches nothing
 *   in the per-file set.
 */
export interface WorktreeSnapshot {
  readonly worktreePath: string;
  /** Paths git reported as changed or untracked, ignoring ignored files. */
  readonly dirty: ReadonlySet<string>;
  /** Every ignored **file**, individually. `node_modules/left-pad/index.js`. */
  readonly ignored: ReadonlySet<string>;
  /** Ignored entries as git collapses them. `node_modules/`, `dist/`. */
  readonly ignoredRoots: ReadonlySet<string>;
}

/**
 * Record the worktree's state **before** the agent runs.
 *
 * Called from the dispatch, between provisioning the worktree and spawning the
 * Developer. Taken after `setup_command` on purpose: the dependency tree an
 * install produced is not the agent's work and must never be committed.
 *
 * Three `git status` calls, not one. They ask different questions and their
 * answers are not derivable from each other — see `WorktreeSnapshot`.
 */
export async function snapshotWorktree(git: Git, worktreePath: string): Promise<WorktreeSnapshot> {
  const tracked = await git.statusEntries(worktreePath);
  const collapsed = await git.statusEntries(worktreePath, { includeIgnored: true });
  const perFile = await git.statusEntries(worktreePath, {
    includeIgnored: true,
    allUntracked: true,
  });

  return {
    worktreePath,
    dirty: new Set(tracked.filter((entry) => !isIgnored(entry)).flatMap(pathsOf)),
    ignored: new Set(perFile.filter(isIgnored).flatMap(pathsOf)),
    ignoredRoots: new Set(collapsed.filter(isIgnored).flatMap(pathsOf)),
  };
}

/**
 * Was this path already in the worktree before the agent ran?
 *
 * The one predicate both the staging filter and the post-commit clean check ask,
 * so the two can never disagree about what counts as pre-existing. Three ways to
 * be pre-existing, and each closes a route the others do not:
 *
 * 1. it was dirty (a modified tracked file, an untracked scratch file);
 * 2. it was an ignored file (`node_modules/left-pad/index.js`);
 * 3. it is, or is inside, a directory that was ignored (`node_modules/`).
 *
 * Rule 3 is what survives the agent deleting `.gitignore`. Without it the whole
 * dependency tree flips to untracked, looks brand new, and gets committed —
 * which is the `git add -A` failure this module exists to make impossible.
 *
 * The deliberate cost: a ticket whose actual job is "stop ignoring `dist/`" will
 * have its `.gitignore` change committed but not the previously-ignored content
 * beneath it. That is the right way round. Sweeping a dependency tree into a
 * branch is silent and expensive; a build output that has to be committed
 * separately is visible and rare.
 */
export function wasPresentBefore(snapshot: WorktreeSnapshot, candidate: string): boolean {
  if (snapshot.dirty.has(candidate) || snapshot.ignored.has(candidate)) return true;

  for (const root of snapshot.ignoredRoots) {
    if (candidate === root) return true;
    // git emits a collapsed directory with a trailing slash, so this is a plain
    // prefix test rather than a path-segment walk.
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (candidate === prefix || candidate.startsWith(prefix)) return true;
  }
  return false;
}

export type CommitRefusal = 'no_changes' | 'tree_not_clean';

export interface CommitSuccess {
  readonly ok: true;
  readonly sha: string;
  /** The message as committed, including the trailers below. */
  readonly message: string;
  /** Paths the commit carries, in git's order. */
  readonly files: readonly string[];
  /** Ignored paths the agent created, removed before the gates ran. */
  readonly prunedIgnored: readonly string[];
}

export interface CommitFailure {
  readonly ok: false;
  readonly reason: CommitRefusal;
  readonly detail: string;
  readonly prunedIgnored: readonly string[];
}

export type CommitOutcome = CommitSuccess | CommitFailure;

export interface CommitRequest {
  readonly git: Git;
  readonly snapshot: WorktreeSnapshot;
  /** The agent's proposed `commit_message` (spec §5). */
  readonly proposedMessage: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly attempt: number;
  readonly identity?: GitIdentity;
}

/**
 * Stage the agent's work and commit it, unsandboxed, as the orchestrator.
 *
 * Refuses an empty diff. An agent that changed nothing is a failed attempt, not
 * a silent success: without the refusal the ticket would advance to `gates`,
 * pass them (the tree is unchanged, so it is whatever it was), reach review, and
 * be approved for a change that does not exist.
 */
export async function commitAgentWork(request: CommitRequest): Promise<CommitOutcome> {
  const { git, snapshot } = request;
  const worktree = snapshot.worktreePath;

  const prunedIgnored = await pruneNewIgnoredPaths(git, snapshot);

  const entries = (await git.statusEntries(worktree)).filter((entry) => !isIgnored(entry));
  const changed = entries.filter((entry) =>
    pathsOf(entry).some((candidate) => !wasPresentBefore(snapshot, candidate)),
  );

  if (changed.length === 0) {
    return {
      ok: false,
      reason: 'no_changes',
      detail: emptyDiffDetail(request, prunedIgnored),
      prunedIgnored,
    };
  }

  await git.add(worktree, [...new Set(changed.flatMap(pathsOf))].sort());

  const staged = await git.stagedPaths(worktree);
  if (staged.length === 0) {
    // Everything the agent touched was reverted to its committed content, or
    // was un-addable. Same verdict as an untouched tree: nothing to verify.
    return {
      ok: false,
      reason: 'no_changes',
      detail: emptyDiffDetail(request, prunedIgnored),
      prunedIgnored,
    };
  }

  const message = commitMessage(request);
  const sha = await git.commit(worktree, message, request.identity ?? ORCHESTRATOR_IDENTITY);

  // See the header note. The gates are about to run in this directory, and this
  // is the assertion that makes "they ran against the commit" true rather than
  // merely intended.
  const residual = (await git.statusEntries(worktree))
    .filter((entry) => !isIgnored(entry))
    .flatMap(pathsOf)
    // The same predicate the staging filter used. Asking a narrower question
    // here would refuse a commit for the very paths staging correctly declined
    // to carry — an agent that deleted `.gitignore` would land its change and
    // then be told the tree does not match it.
    .filter((candidate) => !wasPresentBefore(snapshot, candidate));

  if (residual.length > 0) {
    return {
      ok: false,
      reason: 'tree_not_clean',
      detail:
        `committed ${sha} for ${request.ticketId}, but the worktree still differs from it: ` +
        `${residual.sort().join(', ')}. The gates run in this directory and would therefore ` +
        'have verified something other than the commit, so the run is treated as failed rather ' +
        'than advanced (spec §9).',
      prunedIgnored,
    };
  }

  return { ok: true, sha, message, files: staged, prunedIgnored };
}

/**
 * Remove ignored paths that appeared while the agent was running.
 *
 * The narrow, load-bearing case: an agent writes a source file into a path the
 * repo ignores and imports it. `git status` says the tree is clean, the commit
 * carries nothing, and gates run in a directory where the file still exists — so
 * they pass, and the merge later does not. Removing it makes the gates see what
 * the commit says.
 *
 * ============================================================================
 * WHY THIS ASKS FOR THE PER-FILE VIEW
 * ============================================================================
 * `--untracked-files=normal` collapses a wholly-ignored directory to one entry.
 * So on any attempt after the first — once the build gate has written `dist/`,
 * or on any repo whose setup emits output — git reports the identical `!! dist/`
 * before and after the agent runs, `fresh` comes back empty, and a file hidden
 * inside it survives into the gate run. The escape reopens silently, and the
 * only symptom is a green ticket that fails at the merge.
 *
 * `allUntracked: true` is what makes the fresh file visible. It costs a full
 * walk of every ignored file — `node_modules` included — once per commit. That
 * is the price of the guarantee, and it is paid once per attempt rather than
 * once per cycle.
 *
 * Only paths that were **not** in the snapshot go. `node_modules` was there
 * before the agent started and the gates need it.
 */
async function pruneNewIgnoredPaths(
  git: Git,
  snapshot: WorktreeSnapshot,
): Promise<readonly string[]> {
  const entries = await git.statusEntries(snapshot.worktreePath, {
    includeIgnored: true,
    allUntracked: true,
  });
  const fresh = entries
    .filter(isIgnored)
    .flatMap(pathsOf)
    .filter((candidate) => !snapshot.ignored.has(candidate))
    .sort();

  const removed: string[] = [];
  for (const candidate of fresh) {
    const target = resolveInside(snapshot.worktreePath, candidate);
    if (target === null) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}

/**
 * A worktree-relative path resolved to an absolute one, or `null` if it escapes.
 *
 * This function ends in `rm -rf`, and its input is a path git reported about a
 * directory an agent has just been writing to. `..` cannot appear in git's own
 * output, and `.git` is not something git reports as ignored — but "cannot"
 * about a destructive primitive is worth one line of code rather than one line
 * of comment.
 */
function resolveInside(worktreePath: string, relative: string): string | null {
  const root = path.resolve(worktreePath);
  const full = path.resolve(root, relative);
  if (full === root) return null;
  if (!full.startsWith(`${root}${path.sep}`)) return null;
  const first = path.relative(root, full).split(path.sep)[0];
  if (first === '.git') return null;
  return full;
}

function emptyDiffDetail(request: CommitRequest, prunedIgnored: readonly string[]): string {
  const pruned =
    prunedIgnored.length === 0
      ? ''
      : ` The only thing it produced was ignored by this repository and was removed rather ` +
        `than committed: ${prunedIgnored.join(', ')}. A change that cannot be committed cannot ` +
        'be merged, so it does not count as work.';
  return (
    `the Developer left ${request.ticketId} unchanged on attempt ${String(request.attempt)}: ` +
    'there is nothing to commit, so there is nothing for the gates to verify. An agent that ' +
    'changed nothing is a failed attempt, not a no-op success (plan Phase 9).' +
    pruned
  );
}

/**
 * The agent's message, plus trailers naming the ticket and the real author.
 *
 * The agent still authors the message — resolution A6 is explicit that nothing
 * is lost by moving the commit, because the message travels in the structured
 * output. The trailers are the orchestrator's own addition: `git log` on a
 * ticket branch should say which ticket a commit belongs to (Phase 10 merges by
 * branch, and a human reading the merged history has only this) and should say
 * plainly that a machine applied it.
 */
export function commitMessage(request: CommitRequest): string {
  const proposed = request.proposedMessage.trim();
  const subject =
    proposed === ''
      ? `chore(${request.ticketId}): ${request.ticketTitle}`.trim()
      : proposed;

  return [
    subject,
    '',
    `Ticket: ${request.ticketId}`,
    `Attempt: ${String(request.attempt)}`,
    'Committed-by: app-factory orchestrator (the agent proposed this message and cannot commit)',
  ].join('\n');
}

function isIgnored(entry: StatusEntry): boolean {
  return entry.x === '!';
}

/** Both halves of a rename, so staging one never leaves the other behind. */
function pathsOf(entry: StatusEntry): string[] {
  return entry.originalPath === null ? [entry.path] : [entry.path, entry.originalPath];
}

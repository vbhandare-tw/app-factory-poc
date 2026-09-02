/**
 * The ticket merge (plan Phase 10, spec §10, ADR-004).
 *
 * `git merge --no-ff <ticket-branch>` into `feature/<slug>`, then the same
 * deterministic gates the ticket already passed, run again against the branch
 * they landed on. **No agent is involved at any point** and none can be: `merge`
 * has no row in `TICKET_STATE_ROLES`, exactly as `gates` has none.
 *
 * ============================================================================
 * A MERGE COMMIT CANNOT BE UN-MERGED BY `git merge --abort`
 * ============================================================================
 * This is the failure the whole module is shaped around, and it is not the one
 * the plan's test list names.
 *
 * `git merge --abort` only works while a merge is **in progress**. A conflict is
 * therefore easy: nothing was committed, the abort puts the repo back, and the
 * ticket escalates. The post-merge gates are the hard case — by the time they
 * run, the merge commit is already on the feature branch, and a red gate has no
 * abort available to it. Leave it there and the feature branch permanently
 * carries a merge that fails its own gates; every later ticket then merges on
 * top of a broken branch, and the *next* ticket's merge looks like the culprit.
 *
 * So a red post-merge gate **resets the feature branch to the SHA it had before
 * the merge**, records both SHAs in `pause_detail`, and parks the ticket. Nothing
 * is destroyed: the ticket branch still holds every commit, and agents never
 * commit (ADR-003), so there is no work that existed only in the merge. What is
 * given up is the merge commit itself, which is reproducible by definition.
 *
 * ============================================================================
 * WHY A DIRTY MAIN CHECKOUT IS A REFUSAL, NOT A WARNING
 * ============================================================================
 * `ShellGit.mergeNoFf` runs `git checkout <feature-branch>` in the repo root —
 * the operator's own checkout — because that is where spec §10 and the plan put
 * the merge. Three things follow from a checkout that carries uncommitted
 * tracked changes, and the third is the one that matters:
 *
 * 1. `git checkout` can refuse outright, producing a merge failure whose message
 *    has nothing to do with the ticket. (It really does: an untracked file here
 *    that is tracked on the feature branch is enough. `mergeNoFf` raises, and
 *    this module turns that into a `refused` rather than letting it escape as a
 *    dispatch failure — which would retry the ticket every cycle, forever,
 *    without pausing it or telling anybody.)
 * 2. The operator's edits end up sitting on top of the feature branch, so a
 *    human looking at their own repo sees a branch they did not switch to.
 * 3. **The revert path above runs `git reset --hard`** when the feature branch is
 *    the one checked out — which destroys those edits.
 *
 * (3) is unacceptable and unrecoverable, so the merge refuses before it starts.
 * Untracked and ignored files are deliberately *not* a refusal: `git checkout`
 * never overwrites an untracked file silently (it refuses), `reset --hard` does
 * not delete untracked files, and the gates run in a worktree of their own where
 * the operator's stray files are not present at all. Refusing on those would
 * stall every merge for a repo with a `notes.txt` in it, which is a usability
 * trap that reads as a bug.
 *
 * ============================================================================
 * CHANGED IN REVIEW — THE REFUSAL ALONE DID NOT CLOSE (3)
 * ============================================================================
 * **What this module used to do:** revert first, then restore the main checkout
 * in the `finally`. **What it does now: restore first, then revert.** The old
 * order was wrong, and the pre-merge refusal above was not the guarantee it
 * looked like.
 *
 * The refusal is checked **once, before the merge**. The post-merge gates then
 * run, for as long as the target repo's test suite takes, and nothing re-checks.
 * Probed against real git: a tracked file edited during that window came back as
 * its pre-merge content, and an edit to a file the merge had brought in was
 * deleted outright.
 *
 * The fix is not a better guard, it is making the destructive command
 * unreachable. `Git.resetBranch` tries `git branch --force` first and only falls
 * back to `git reset --hard` when the branch is the one *currently checked out*.
 * So the checkout goes back to its own branch **before** any revert: `branch
 * --force` then succeeds and **no working tree is touched at all**. `reset
 * --hard` is left reachable only when the operator genuinely started on the
 * feature branch — and `ShellGit.resetBranch` re-reads the status immediately
 * before it and raises rather than resetting if anything is dirty, which is also
 * the backstop for a `restoreCheckout` that failed silently (it never throws, by
 * design — see its own note).
 *
 * The restore is idempotent, so the `finally` still guarantees it on every path
 * including a thrown one; it simply already happened on the revert paths.
 *
 * ============================================================================
 * WHERE THE POST-MERGE GATES RUN
 * ============================================================================
 * **Not in the main checkout.** A dedicated throwaway worktree, detached at the
 * merge commit, provisioned through the same `setup_command` path every ticket
 * worktree uses (resolution A3). Phase 9's guarantee is "the gates run against
 * the commit, not the dirty tree"; this is that guarantee one level up. The main
 * checkout has whatever the operator left in it — a half-finished `npm install`,
 * a stale `node_modules`, build output from another branch — and none of that is
 * a property of the merge commit.
 *
 * It costs one `setup_command` run per ticket merge. That is the price of the
 * gate verdict meaning something, and it is the same price Phase 8 already pays
 * per ticket.
 *
 * ============================================================================
 * THE MAIN CHECKOUT IS PUT BACK
 * ============================================================================
 * `mergeNoFf` leaves the repo on the branch it merged into. The operator's
 * checkout is theirs; the factory borrowed it for one command. It is restored to
 * the branch — or the detached SHA — it was on before, on every path including
 * the failures, because the alternative is a human's next `git status` quietly
 * reporting a branch they never switched to.
 */
import type { FactoryConfig } from '../config/schema.js';
import type { GateName } from '../domain/states.js';
import {
  allGatesPassed,
  describeGateFailure,
  emptyResults,
  renderGateResults,
} from '../gates/results.js';
import type { GateResults } from '../gates/results.js';
import { DEFAULT_GATE_TIMEOUT_MS } from '../gates/runner.js';
import type { GateRunner } from '../gates/runner.js';
import { dirtyTrackedPaths } from '../git/git.js';
import type { Git, MergeResult } from '../git/git.js';
import { destroyWorktree } from '../git/worktree.js';
import type { EventSink } from '../log/events.js';
import type { VaultPaths } from '../vault/paths.js';
import type { FeatureWorkspaceProvider } from './dispatch.js';

/** Everything the merge needs. All of it injectable; none of it read from a global. */
export interface MergeTicketInput {
  readonly git: Git;
  readonly gates: GateRunner;
  readonly config: FactoryConfig;
  readonly paths: VaultPaths;
  /** Where the post-merge gates run. See the header note. */
  readonly featureWorkspace: FeatureWorkspaceProvider;
  readonly events?: EventSink;
  readonly ticketId: string;
  readonly featureSlug: string;
  readonly ticketBranch: string;
  readonly featureBranch: string;
  /** Only for naming the gate logs — the merge itself charges no attempt. */
  readonly attempt: number;
  /** The ticket's worktree, removed on success before its branch is deleted. */
  readonly worktreePath?: string | null;
}

export type MergeTicketOutcome =
  | {
      readonly kind: 'merged';
      /** The merge commit now at the tip of the feature branch. */
      readonly sha: string;
      readonly beforeSha: string;
      readonly results: GateResults;
      /** Whether the ticket branch was deleted (spec §10's "on done"). */
      readonly branchDeleted: boolean;
      readonly worktreeRemoved: boolean;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: readonly string[];
      readonly detail: string;
    }
  | {
      /** The merge landed and its own gates rejected it. See the header note. */
      readonly kind: 'gates_red';
      readonly detail: string;
      readonly beforeSha: string;
      readonly mergeSha: string;
      readonly results: GateResults;
      /** False only if the reset itself failed — then the bad merge is still there. */
      readonly reverted: boolean;
      readonly revertError?: string;
    }
  | {
      /** Nothing was attempted. The repository is untouched. */
      readonly kind: 'refused';
      readonly detail: string;
    };

/**
 * Merge one ticket branch into its feature branch and verify the result.
 *
 * Every exit path leaves the repository in a state a human can reason about:
 * no merge in progress, the main checkout on the branch it started on, and the
 * feature branch either carrying a verified merge or exactly where it was.
 */
export async function mergeTicket(input: MergeTicketInput): Promise<MergeTicketOutcome> {
  const { git } = input;

  // ==========================================================================
  // THE BASE BRANCH IS PHASE 11'S, AND ONLY PHASE 11'S (Section E item 8)
  // ==========================================================================
  // Both branch names arrive from human-editable vault frontmatter (ADR-001):
  // `featureBranchFor` returns the feature note's `feature_branch` field
  // unconditionally, and the ticket's `branch` field is just as editable. So
  // `feature_branch: main` would have `mergeNoFf` write the base branch and
  // `resetBranch` rewind it, and `branch: main` on a ticket would end this
  // function with `git branch -D main`. Nothing upstream checks. This does.
  const refusedTarget = forbiddenBranch(input);
  if (refusedTarget !== null) return refused(refusedTarget);

  if (!(await git.branchExists(input.featureBranch))) {
    return refused(
      `the feature branch ${input.featureBranch} does not exist, so there is nothing to merge ` +
        `${input.ticketId} into.`,
    );
  }
  if (!(await git.branchExists(input.ticketBranch))) {
    return refused(
      `the ticket branch ${input.ticketBranch} does not exist. ${input.ticketId} reached merge ` +
        'without a branch carrying its work — the commit was made somewhere else, or the branch ' +
        'has been deleted.',
    );
  }

  const dirty = await dirtyMainCheckout(git);
  if (dirty.length > 0) {
    return refused(
      `the main checkout at ${git.repoRoot} has uncommitted changes to ${dirty.join(', ')}. The ` +
        `merge runs there (spec §10), and a red post-merge gate resets ${input.featureBranch}, ` +
        'which would destroy them. Commit or stash them and approve this ticket to retry. ' +
        'Untracked files are fine and are not the reason for this refusal.',
    );
  }

  const beforeSha = await git.revParse(git.repoRoot, input.featureBranch);
  if (beforeSha === null) {
    return refused(
      `${input.featureBranch} does not resolve to a commit, so there is no state to return to if ` +
        'the merge has to be undone.',
    );
  }

  // Captured before anything moves.
  const startingBranch = await git.currentBranch(git.repoRoot);
  const startingHead =
    startingBranch === null ? await git.revParse(git.repoRoot, 'HEAD') : null;

  /**
   * Put the main checkout back. Idempotent, and **called before every revert**.
   *
   * The order is the safety property — see the header note. The `finally` still
   * calls it, which is what guarantees it on the green path and on a thrown
   * one; the flag stops that becoming a second `git checkout`.
   */
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    await restoreCheckout(input, startingBranch, startingHead);
  };

  await input.events?.emit({
    type: 'merge_started',
    itemId: input.ticketId,
    into: input.featureBranch,
    from: input.ticketBranch,
    beforeSha,
  });

  try {
    let merge: MergeResult;
    try {
      merge = await git.mergeNoFf(input.featureBranch, input.ticketBranch);
    } catch (error) {
      // `ShellGit.mergeNoFf` raises when `git checkout <feature>` is refused,
      // which real git does when an untracked file in the main checkout is
      // tracked on the feature branch. Nothing was merged, so this is a
      // `refused` — and it must not escape: the loop would read a raise as a
      // dispatch failure, release the claim, and leave the ticket at `merge` to
      // be retried every cycle forever with no pause and nobody notified.
      return refused(
        `the merge of ${input.ticketBranch} into ${input.featureBranch} could not be started: ` +
          `${error instanceof Error ? error.message : String(error)}\n\nNothing was merged and ` +
          `${input.featureBranch} is untouched. Most often the main checkout at ${git.repoRoot} ` +
          'holds an untracked file that the feature branch tracks — remove or move it, then ' +
          'approve this ticket to retry.',
      );
    }

    if (!merge.ok) {
      // `mergeNoFf` has already run `git merge --abort`. Nothing is committed and
      // nothing is half-merged; the ticket escalates (ADR-004, spec §9.1).
      await input.events?.emit({
        type: 'merge_conflict',
        itemId: input.ticketId,
        into: input.featureBranch,
        from: input.ticketBranch,
        conflicts: merge.conflicts,
        detail: merge.detail,
      });
      return { kind: 'conflict', conflicts: merge.conflicts, detail: merge.detail };
    }

    const mergeSha = await git.revParse(git.repoRoot, input.featureBranch);
    if (mergeSha === null) {
      // Unreachable: a successful merge leaves a commit. Handled rather than
      // asserted because the alternative is a `done` ticket with no evidence.
      await revert(input, restore, beforeSha, 'the merge reported success but left no commit');
      return refused(
        `${input.featureBranch} carried no commit after a merge git reported as successful.`,
      );
    }

    // ======================================================================
    // Everything from here on can leave a bad merge behind, so every failure
    // route below goes through `revert`.
    // ======================================================================
    let results: GateResults;
    try {
      results = await runFeatureGates(input, mergeSha);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const reverted = await revert(
        input,
        restore,
        beforeSha,
        `the post-merge gate run threw: ${reason}`,
      );
      return {
        kind: 'gates_red',
        detail:
          `the post-merge gates on ${input.featureBranch} could not be run: ${reason}. The merge ` +
          'has been undone rather than left unverified.',
        beforeSha,
        mergeSha,
        results: unrunResults(input.config),
        reverted: reverted.ok,
        ...(reverted.ok ? {} : { revertError: reverted.error }),
      };
    }

    const green = allGatesPassed(results);
    await input.events?.emit({
      type: 'gates_finished',
      itemId: input.ticketId,
      attempt: input.attempt,
      green,
      commitSha: mergeSha,
      detail: describeGateFailure(results),
    });

    if (!green) {
      const reverted = await revert(
        input,
        restore,
        beforeSha,
        `the post-merge gates went red: ${describeGateFailure(results)}`,
      );
      return {
        kind: 'gates_red',
        detail: describeGateFailure(results),
        beforeSha,
        mergeSha,
        results,
        reverted: reverted.ok,
        ...(reverted.ok ? {} : { revertError: reverted.error }),
      };
    }

    // Green. Spec §10: "on done, remove the worktree, delete the ticket branch."
    //
    // In that order, and not by accident: git refuses to delete a branch that is
    // checked out in a worktree, so the worktree has to go first. That ordering
    // is also why this path removes the worktree itself rather than leaving it
    // to reconciliation — reconciliation would only notice on the *next* cycle,
    // by which point the branch delete has already failed.
    const worktreeRemoved = await removeTicketWorktree(input);
    const branchDeleted = await deleteTicketBranch(input, worktreeRemoved);

    await input.events?.emit({
      type: 'merge_completed',
      itemId: input.ticketId,
      into: input.featureBranch,
      from: input.ticketBranch,
      sha: mergeSha,
      branchDeleted,
    });

    return { kind: 'merged', sha: mergeSha, beforeSha, results, branchDeleted, worktreeRemoved };
  } finally {
    await restore();
  }
}

/**
 * The `## Gate Results` text for a post-merge run.
 *
 * Deliberately **not** written into `gate_results` frontmatter: that field is
 * the ticket's own verdict, read by `gatesAllGreen`, and overwriting it with a
 * feature-branch run would change the answer to a different question.
 */
export function renderFeatureGateResults(
  results: GateResults,
  context: { readonly branch: string; readonly sha: string; readonly attempt: number },
): string {
  return [
    `**Feature-branch gates** — \`${context.branch}\` at \`${context.sha}\`, after the ` +
      'merge of this ticket. A ticket can pass its own gates and still break the branch it ' +
      'lands on; this is the run that catches that.',
    renderGateResults(results, { attempt: context.attempt, commitSha: context.sha }),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The pieces.
// ---------------------------------------------------------------------------

function refused(detail: string): MergeTicketOutcome {
  return { kind: 'refused', detail };
}

/**
 * Tracked paths the main checkout has changed. Untracked and ignored files are
 * excluded on purpose — see the header note.
 *
 * The predicate itself lives in `git.ts` because `ShellGit.resetBranch` asks
 * the same question again, at the last moment before `git reset --hard`, and
 * two copies of "is this checkout dirty" is one copy too many.
 */
async function dirtyMainCheckout(git: Git): Promise<string[]> {
  return dirtyTrackedPaths(await git.statusEntries(git.repoRoot));
}

/**
 * Why this merge must not be attempted at all, or `null`.
 *
 * All three cases are a branch name arriving from human-editable frontmatter
 * and naming something this phase is not allowed to write. Section E item 8
 * reserves every base-branch write to Phase 11, and a ticket branch equal to
 * the feature branch would end with `git branch -D` on the branch the whole
 * feature lives on.
 */
function forbiddenBranch(input: MergeTicketInput): string | null {
  const base = input.config.base_branch;

  if (input.featureBranch === base) {
    return (
      `refusing to merge ${input.ticketId} into ${input.featureBranch}: that is the base branch. ` +
      'Only the feature-close path writes the base branch (plan Section E item 8), and this ' +
      `merge would also rewind it if the post-merge gates went red. Fix \`feature_branch\` on ` +
      `the ${input.featureSlug} feature note.`
    );
  }
  if (input.ticketBranch === base) {
    return (
      `refusing to merge ${input.ticketId}: its \`branch\` is ${input.ticketBranch}, the base ` +
      'branch. A successful merge deletes the ticket branch, so this would delete the base ' +
      "branch. Fix the ticket's `branch` field."
    );
  }
  if (input.ticketBranch === input.featureBranch) {
    return (
      `refusing to merge ${input.ticketId}: its \`branch\` and the feature branch are both ` +
      `${input.featureBranch}. The merge would be a no-op and would then delete the branch the ` +
      `${input.featureSlug} feature lives on.`
    );
  }
  return null;
}

async function runFeatureGates(input: MergeTicketInput, sha: string): Promise<GateResults> {
  const workspace = await input.featureWorkspace({
    featureSlug: input.featureSlug,
    branch: input.featureBranch,
    ref: sha,
    ticketId: input.ticketId,
  });

  try {
    return await input.gates.run(workspace.cwd, input.config.gates, {
      logPathFor: (gate: GateName) =>
        input.paths.gateLogPath(input.featureSlug, `${input.ticketId}-merge`, input.attempt, gate),
      maxOutputChars: input.config.gate_output_chars,
      timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      onGateFinished: async (gate, result) => {
        await input.events?.emit({
          type: 'gate_result',
          itemId: input.ticketId,
          gate,
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          logPath: result.logPath,
        });
      },
    });
  } finally {
    await workspace.dispose?.();
  }
}

/**
 * Every gate `skipped`, for the case where the run itself could not happen.
 *
 * `skipped`, never `pass`: `allGatesPassed` asks each gate for a `pass`, so a
 * run that never happened can never be mistaken for a green one.
 */
function unrunResults(config: FactoryConfig): GateResults {
  return emptyResults(config.gates, 'the post-merge gate run could not be started');
}

/**
 * Put the feature branch back where it was.
 *
 * The one operation that undoes a committed merge. A failure here is reported
 * rather than thrown: the caller has to be able to tell a human that the bad
 * merge is *still on the branch*, which is far more urgent than the red gate
 * that caused it, and throwing would replace that message with a stack trace.
 *
 * **`restore` runs first, and that is the whole safety property** — see the
 * header note. With the main checkout back on its own branch, `resetBranch`
 * gets `git branch --force` and touches no working tree; without it, it gets
 * `git reset --hard` in the operator's checkout. It is a parameter rather than
 * something this function reaches for so that there is exactly one place the
 * order can be got wrong, and it is visible in the signature.
 */
async function revert(
  input: MergeTicketInput,
  restore: () => Promise<void>,
  beforeSha: string,
  reason: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  await restore();
  try {
    await input.git.resetBranch(input.featureBranch, beforeSha);
    await input.events?.emit({
      type: 'merge_reverted',
      itemId: input.ticketId,
      branch: input.featureBranch,
      toSha: beforeSha,
      reason,
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.events?.emit({
      type: 'merge_revert_failed',
      itemId: input.ticketId,
      branch: input.featureBranch,
      toSha: beforeSha,
      error: message,
    });
    return { ok: false, error: message };
  }
}

async function removeTicketWorktree(input: MergeTicketInput): Promise<boolean> {
  const worktree = input.worktreePath;
  if (worktree === undefined || worktree === null || worktree === '') return false;

  try {
    await destroyWorktree(input.git, worktree);
    await input.events?.emit({
      type: 'worktree_removed',
      path: worktree,
      reason: `ticket ${input.ticketId} merged into ${input.featureBranch}`,
    });
    return true;
  } catch (error) {
    // Not fatal: the merge is verified and the ticket is done. Reconciliation
    // removes the worktree of a `done` ticket on the next cycle anyway — this
    // path is the one that makes the branch delete possible, not the one that
    // guarantees cleanup.
    await input.events?.emit({
      type: 'worktree_unaccounted',
      path: worktree,
      detail:
        `could not remove the worktree of merged ticket ${input.ticketId}: ` +
        `${error instanceof Error ? error.message : String(error)}. Reconciliation will retry it.`,
    });
    return false;
  }
}

/**
 * Delete the ticket branch (spec §10).
 *
 * `-D` rather than `-d`, because `-d`'s safety check is "merged into the branch
 * currently checked out", and by the time this runs the main checkout is about
 * to be put back on whatever it started on. The work is provably merged: the
 * merge commit was made moments ago and its gates went green. Skipped entirely
 * when the worktree could not be removed, because git will refuse anyway and a
 * refusal there reads as an unexplained error.
 */
async function deleteTicketBranch(
  input: MergeTicketInput,
  worktreeRemoved: boolean,
): Promise<boolean> {
  const hasWorktree =
    input.worktreePath !== undefined && input.worktreePath !== null && input.worktreePath !== '';
  if (hasWorktree && !worktreeRemoved) return false;

  try {
    await input.git.deleteBranch(input.ticketBranch, { force: true });
    await input.events?.emit({
      type: 'ticket_branch_deleted',
      itemId: input.ticketId,
      branch: input.ticketBranch,
    });
    return true;
  } catch (error) {
    await input.events?.emit({
      type: 'merge_cleanup_failed',
      itemId: input.ticketId,
      detail: `could not delete ${input.ticketBranch}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return false;
  }
}

/**
 * Return the main checkout to the branch (or detached SHA) it was on.
 *
 * Never throws. It runs in a `finally`, and an exception there would replace the
 * merge's real outcome — including a conflict a human needs to read about — with
 * a checkout error.
 *
 * **That silence is why `ShellGit.resetBranch` re-checks for uncommitted work.**
 * Since the review, this is also called *before* every revert, precisely so the
 * revert gets `git branch --force` instead of `git reset --hard` (header note).
 * A restore that fails here therefore fails quietly and hands the revert the
 * destructive path — real git refuses `git checkout <starting-branch>` when a
 * file the merge brought in has since been edited, which is exactly that case.
 * The re-check in `resetBranch` is the backstop, and it raises rather than
 * resetting. Do not make this throw to close that; the caller's contract is
 * that the merge's own outcome is what reaches the human.
 */
async function restoreCheckout(
  input: MergeTicketInput,
  branch: string | null,
  head: string | null,
): Promise<void> {
  try {
    const current = await input.git.currentBranch(input.git.repoRoot);
    if (branch !== null) {
      if (current === branch) return;
      await input.git.checkout(branch);
      return;
    }
    if (head === null) return;
    await input.git.checkout(head, { detach: true });
  } catch (error) {
    await input.events?.emit({
      type: 'merge_cleanup_failed',
      itemId: input.ticketId,
      detail:
        `could not return ${input.git.repoRoot} to ${branch ?? head ?? 'its previous HEAD'}: ` +
        `${error instanceof Error ? error.message : String(error)}. The checkout is left on ` +
        `${input.featureBranch}.`,
    });
  }
}

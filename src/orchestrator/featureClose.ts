/**
 * The feature close (plan Phase 11, spec §10, ADR-004) — the feature-level twin
 * of `./merge.ts`, and **the only code in the system permitted to write the base
 * branch** (plan Section E item 8).
 *
 * Two halves, deliberately split by who triggers them:
 *
 * 1. `runFeatureClose` — reached from the dispatcher when a feature sits at
 *    `awaiting_feature_close`. Runs the deterministic gates against the feature
 *    branch and, on green, parks the feature at the `final_acceptance`
 *    checkpoint with an approval summary. No agent is involved and none can be:
 *    `awaiting_feature_close` has no row in `FEATURE_STATE_ROLES`, exactly as
 *    `gates` and `merge` have none in the ticket table.
 * 2. `closeFeature` — reached from `factory approve`. `git merge --no-ff
 *    feature/<slug>` into the effective base branch, then the tag. Nothing else.
 *
 * ============================================================================
 * WHY THIS DOES NOT GO THROUGH `mergeTicket`
 * ============================================================================
 * Because `mergeTicket` **refuses** when its target is the base branch, and that
 * refusal must stay exactly as strict as it is. Phase 10 added it because both
 * branch names it works from arrive out of human-editable frontmatter (ADR-001),
 * so `feature_branch: main` on a feature note would have had the *ticket* merge
 * write the base branch and then rewind it. Routing the feature close through
 * the same function would mean weakening that guard to let one caller past —
 * turning a hard rule into a flag, and reopening the hole for every caller.
 *
 * So this is its own code. The two paths share `Git`, the dirty-checkout
 * refusal and the checkout restore, and share nothing else.
 *
 * ============================================================================
 * A FAILED BASE MERGE REVERTS NOTHING. THAT IS THE DECISION, NOT AN OMISSION.
 * ============================================================================
 * `mergeTicket` rewinds the feature branch when the post-merge gates go red,
 * and it has to: `git merge --abort` cannot undo a committed merge, and a
 * feature branch left carrying a bad merge poisons every later ticket. None of
 * that argument survives one level up, and three things replace it:
 *
 * 1. **There is no verdict here that can call the merge bad.** The gates run on
 *    the feature branch *before* the checkpoint, so by the time a human
 *    approves, the thing being merged has already been judged. The ticket merge
 *    reverts because its gates run *after* its merge; this one has nothing
 *    pending that could change its mind.
 * 2. **Nobody owns the base branch but the humans.** The factory owns
 *    `feature/<slug>` outright, so rewinding it can only lose a merge commit the
 *    factory itself just made. The base branch can have moved between the SHA
 *    read here and any later reset — a colleague's commit, a pull, a
 *    hand-merged hotfix — and a reset to a remembered SHA would silently drop
 *    it. That is unrecoverable in exactly the way the ticket-branch revert is
 *    not.
 * 3. **`reset --hard` is much more likely to fire here.** `Git.resetBranch`
 *    falls back to `git reset --hard` when the branch it must move is the one
 *    checked out in the operator's own checkout. For a feature branch that is
 *    the unusual case; for the *base* branch it is the normal one — an operator
 *    sitting on `main` is the default state of a repository.
 *
 * So the only failure after a successful merge is a failed tag, and its answer
 * is **leave it and escalate**: the feature stays parked, `pause_detail` says in
 * as many words that the merge is on the base branch and the tag is not, and the
 * transition guard refuses `done` because no tag was recorded. Re-approving is
 * safe and is the documented fix — `git merge --no-ff` of an already-merged
 * branch is a no-op that reports success, so the second attempt reaches the tag
 * with the base branch untouched.
 *
 * One consequence worth naming: because nothing is reverted, the "restore the
 * checkout *before* the revert" ordering that `./merge.ts`'s header is built
 * around has no equivalent here. There is no revert to order anything against,
 * and that absence is a reason not to add one rather than a gap to fill.
 *
 * ============================================================================
 * WHY A DIRTY MAIN CHECKOUT IS STILL A REFUSAL
 * ============================================================================
 * `ShellGit.mergeNoFf` runs `git checkout <base>` in the repo root — the
 * operator's own checkout. With uncommitted tracked changes there, two things go
 * wrong and neither is recoverable by retrying: git can refuse the checkout
 * outright with a message about the ticket's branch that has nothing to do with
 * the close, and the operator's edits end up sitting on top of the base branch
 * after a merge they did not ask for. Untracked and ignored files are
 * deliberately **not** a refusal, for the reasons `dirtyTrackedPaths` gives.
 *
 * ============================================================================
 * A COLLIDING TAG NAME REFUSES. IT IS NEVER MOVED AND NEVER SUFFIXED.
 * ============================================================================
 * `factory/<slug>/<ISO date>` is required to be deterministic from the slug and
 * the date (plan Phase 11), which means two closes of the same feature on the
 * same day want the same name. Three things could happen and only one is safe:
 *
 * - **Move it** (`tag --force`): rewrites the marker of a delivery that already
 *   happened. The tag is the only durable record that a given commit was the
 *   one shipped, and moving it destroys that with no trace.
 * - **Suffix it** (`-2`): makes the determinism claim false, and hides the fact
 *   that two different commits now both claim to be this feature's delivery.
 * - **Refuse** before touching the base branch, naming what the existing tag
 *   points at and what to do about it.
 *
 * The third. A collision is not a routine event: `done` is terminal, so a
 * feature cannot legitimately be closed twice, and the reject path never tags.
 * What it actually means is either a hand-made tag or a close that got as far as
 * the tag and no further — and in both cases a human deciding is right and a
 * machine guessing is not. The refusal message distinguishes the two.
 *
 * ============================================================================
 * THE BASE BRANCH IS VERIFIED TOO, AND A RED ONE BLOCKS THE MERGE (Phase 12)
 * ============================================================================
 * Phase 11 gated the branch being merged **from** and nothing gated the branch
 * being merged **into**, so a base branch that was already red took the merge
 * anyway and the delivery was tagged on top of somebody else's breakage
 * (requirements §16). Three pieces close that, and they are deliberately in
 * three different places:
 *
 * 1. `verifyBaseBranch`, on the dispatcher's side, is the only one that can run
 *    gates — and it asks a narrower question than "is the base green". It asks
 *    **"has the tree that will land been gated"**. When the base tip is already
 *    an ancestor of the verified feature commit, `git merge --no-ff` produces
 *    that commit's tree and the feature-branch run has just judged it, so
 *    nothing runs and `base_verified_sha` stays `null`. That is the normal
 *    shape of a close, which is why this costs nothing most of the time.
 * 2. `baseIsCovered`, inside `closeFeature`, re-checks the same fact at the
 *    last possible moment — the statement before the merge command. It runs no
 *    gates and never could: see the note on it.
 * 3. `describeCloseFailure` gives that one failure a different `resume_to`, so
 *    approving again hands the feature back to the loop instead of walking into
 *    the same refusal forever.
 *
 * Piece 2 is not redundant with piece 1. Piece 1 is a decision taken before a
 * human's attention span; piece 2 sits in the single function every path that
 * writes the base branch goes through, and closes both that window and any
 * caller written later. Same two-lock shape as the checkpoint's.
 *
 * **A red base branch is never the feature's fault.** Nothing is charged
 * against it, the feature-branch verdict stays in the note next to the base
 * one, and every message says which branch is broken in its first sentence.
 *
 * ============================================================================
 * WHERE THE GATES RUN
 * ============================================================================
 * **Not in the main checkout.** A throwaway worktree detached at the feature
 * branch tip, through the same `FeatureWorkspaceProvider` the ticket merge uses
 * (resolution A3). Same argument as Phase 10's, one level up: the main checkout
 * holds whatever the operator left in it, and a gate verdict from there is a
 * statement about their machine rather than about the commit a human is being
 * asked to approve.
 */
import { SECTION } from '../agents/context.js';
import type { FactoryConfig } from '../config/schema.js';
import { featureTagName } from '../git/paths.js';
import { dirtyTrackedPaths } from '../git/git.js';
import type { Git } from '../git/git.js';
import { featureBranchFor } from '../git/workspace.js';
import type { GateName, PauseReason } from '../domain/states.js';
import { historyLines } from '../domain/transitions.js';
import type { FeatureNote, IsoTimestamp, TicketNote } from '../domain/types.js';
import {
  allGatesPassed,
  describeGateFailure,
  emptyResults,
  renderGateResults,
} from '../gates/results.js';
import type { GateResults } from '../gates/results.js';
import { DEFAULT_GATE_TIMEOUT_MS } from '../gates/runner.js';
import type { EventSink } from '../log/events.js';
import { CHECKPOINTS, checkpointEnabled, pauseItem } from './checkpoints.js';
import type { Actionable, DispatchContext, DispatchDeps, DispatchOutcome } from './dispatchTypes.js';
import { composeNote, persist, refreshViews, transition, writeAnyNote } from './noteWrites.js';

// ---------------------------------------------------------------------------
// Capability.
// ---------------------------------------------------------------------------

/**
 * Can this dispatcher close a feature?
 *
 * The same three capabilities the ticket merge needs, for the same reasons: git
 * to move refs, the gate runner to produce the verdict a human approves against,
 * and somewhere other than the operator's checkout to run it. Without them the
 * feature is left visibly waiting at `awaiting_feature_close` rather than being
 * offered for approval on evidence nobody gathered.
 */
export function canCloseFeature(
  deps: Pick<DispatchDeps, 'git' | 'gates' | 'featureWorkspace'>,
): boolean {
  return deps.git !== undefined && deps.gates !== undefined && deps.featureWorkspace !== undefined;
}

// ---------------------------------------------------------------------------
// Part 2 (declared first because part 1 uses it): the base-branch merge.
// ---------------------------------------------------------------------------

/** Everything the base-branch merge needs. All injectable; nothing global. */
export interface CloseFeatureInput {
  readonly git: Git;
  readonly config: FactoryConfig;
  readonly featureId: string;
  readonly featureSlug: string;
  readonly featureBranch: string;
  /** Deterministic, from `featureTagName`. Never derived in here. */
  readonly tagName: string;
  /**
   * `base_verified_sha` off the feature note — the base commit a gate run
   * passed, or `null` when none was needed.
   *
   * Required rather than optional, and deliberately: an omitted field would
   * default to "no evidence" on a path that writes the base branch, and the one
   * shape this must never have is a caller who forgot. Every caller states what
   * it knows.
   */
  readonly baseVerifiedSha: string | null;
  /**
   * The feature commit the caller believes it is delivering.
   *
   * The commit that actually merges is whatever `feature/<slug>` points at when
   * `git merge --no-ff` runs, and on the dispatcher's path a **full gate run**
   * separates the caller reading that tip from this function merging it —
   * minutes, on a real repository. Anything landing inside that window would go
   * to the base branch ungated, carrying a tag, which is the whole failure the
   * close exists to prevent.
   *
   * So the caller's belief arrives here and is compared against the branch at
   * the last possible moment. Third time this project has needed the rule: the
   * plan's session log says any check on a destructive path must be re-taken at
   * the last possible moment, not once at the start.
   *
   * Required, and `null` refuses — a caller that does not know what it is
   * delivering must not deliver.
   */
  readonly expectedFeatureSha: string | null;
  readonly events?: EventSink;
}

export type CloseFeatureOutcome =
  | {
      readonly kind: 'closed';
      /** The base branch's new tip. Equal to `baseBeforeSha` on a re-run. */
      readonly sha: string;
      readonly baseBeforeSha: string;
      readonly tag: string;
      /** False when the tag already existed at this commit — a resumed close. */
      readonly tagCreated: boolean;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: readonly string[];
      readonly detail: string;
    }
  | {
      /**
       * The merge is on the base branch and the tag is not.
       *
       * Nothing is rewound — see the header. The feature must not reach `done`,
       * because the guard has no tag to be given.
       */
      readonly kind: 'tag_failed';
      readonly sha: string;
      readonly baseBeforeSha: string;
      readonly tag: string;
      readonly error: string;
    }
  | {
      /**
       * The feature branch moved between the caller's verdict and this merge.
       *
       * Its own kind rather than a plain `refused` for the same reason
       * `base_unverified` has one: clearing it needs a **gate run** on the
       * commit that is there now, and only the loop can do that — so approving
       * again has to hand the feature back rather than walk into the same
       * refusal.
       */
      readonly kind: 'feature_moved';
      readonly detail: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      /**
       * The base branch is not covered by any gate run. Nothing was attempted.
       *
       * Separate from `refused` because the way out is different: every
       * `refused` case is fixed in the repository or the note and re-approved
       * straight back into the close, while this one needs the **loop** to
       * verify both branches again. `describeCloseFailure` turns that into a
       * different `resume_to`, which is the only thing standing between the
       * operator and a refusal they cannot clear.
       */
      readonly kind: 'base_unverified';
      readonly detail: string;
      readonly baseSha: string;
    }
  | {
      /** Nothing was attempted. The base branch was not touched at all. */
      readonly kind: 'refused';
      readonly detail: string;
    };

/**
 * Merge a feature branch into the base branch and tag the result.
 *
 * Every exit path leaves the repository in a state a human can reason about: no
 * merge in progress, the main checkout on the branch it started on, and the base
 * branch either carrying the feature *and* the tag, or carrying neither.
 *
 * The one exception is `tag_failed`, which carries the merge and not the tag —
 * and it says so, loudly, rather than pretending otherwise.
 */
export async function closeFeature(input: CloseFeatureInput): Promise<CloseFeatureOutcome> {
  const { git } = input;
  const base = input.config.base_branch;

  const refusal = forbiddenClose(input);
  if (refusal !== null) return await refused(input, refusal);

  if (!(await git.branchExists(input.featureBranch))) {
    return await refused(
      input,
      `the feature branch ${input.featureBranch} does not exist, so there is nothing to merge ` +
        `into ${base}. Fix \`feature_branch\` on the ${input.featureSlug} feature note, or ` +
        'reject the feature back to development.',
    );
  }
  if (!(await git.branchExists(base))) {
    return await refused(
      input,
      `the base branch ${base} does not exist in ${git.repoRoot}. Fix \`base_branch\` in ` +
        'config.yml — nothing is merged anywhere until it names a real branch.',
    );
  }

  const baseBeforeSha = await git.revParse(git.repoRoot, base);
  if (baseBeforeSha === null) {
    return await refused(
      input,
      `${base} does not resolve to a commit, so there is nothing to merge into.`,
    );
  }

  const dirty = dirtyTrackedPaths(await git.statusEntries(git.repoRoot));
  if (dirty.length > 0) {
    return await refused(
      input,
      `the main checkout at ${git.repoRoot} has uncommitted changes to ${dirty.join(', ')}. The ` +
        `close checks ${base} out there to merge into it (spec §10), so those edits would end up ` +
        'sitting on top of the base branch after a merge you did not ask for — and git may ' +
        'refuse the checkout outright. Commit or stash them and approve again. Untracked files ' +
        'are fine and are not the reason for this refusal.',
    );
  }

  // Read before anything moves. A tag that already exists is never moved and
  // never suffixed — see the header.
  const existingTag = await git.revParse(git.repoRoot, `refs/tags/${input.tagName}`);
  if (existingTag !== null) {
    return await refused(input, describeTagCollision(input, existingTag, baseBeforeSha, base));
  }

  // ==========================================================================
  // THE LAST-MOMENT LOCK ON THE BASE BRANCH
  // ==========================================================================
  // The gates that judged the base branch ran on the dispatcher's side, before
  // the checkpoint. This is the final statement before the merge command, and
  // it is here rather than only in `factory approve` on purpose: **this is the
  // single function every path that writes the base branch goes through** (plan
  // Section E item 8). `approve` checks too, because it can give a far better
  // message and a route back; this one closes the door for the auto-approve
  // path and for any caller written later.
  //
  // It runs no gates. That is the whole shape of the resolution — the same one
  // `verified_sha` uses one level down, and for the same reason `staleVerdict`
  // gives: putting a gate runner and a workspace provider into the CLI's action
  // context to re-verify here would hand every `approve`/`reject`/`kill` the
  // ability to run subprocesses in the target repo, to do a job the loop
  // already does on its next cycle. So it compares, and it refuses.
  const featureSha = await git.revParse(git.repoRoot, input.featureBranch);
  if (featureSha === null) {
    return await refused(
      input,
      `${input.featureBranch} no longer resolves to a commit, so there is no way to tell what ` +
        `merging it into ${base} would land.`,
    );
  }

  // ==========================================================================
  // AND THE SAME LAST-MOMENT COMPARISON FOR THE BRANCH BEING MERGED **FROM**
  // ==========================================================================
  // `factory approve` re-checks the tip against `verified_sha` too, but it does
  // so before calling this function; on the dispatcher's path the gap between
  // the caller's read and this merge is an entire gate run. This is the
  // statement before the merge command, in the one function every base-branch
  // write goes through, so both paths get the guarantee at the same moment.
  if (input.expectedFeatureSha === null || input.expectedFeatureSha !== featureSha) {
    const detail =
      `refusing to close ${input.featureId}: ${input.featureBranch} is at ` +
      `${featureSha.slice(0, 8)}, and what was verified and approved was ` +
      `${input.expectedFeatureSha === null ? 'never recorded' : input.expectedFeatureSha.slice(0, 8)}. ` +
      `A commit landed on the branch after its gates ran, so merging now would put code no gate ` +
      `run has seen onto ${base} and tag it as a delivery. Nothing was merged and nothing was ` +
      `tagged.\n\n**Approve ${input.featureId} again** to send it back to be verified: the gates ` +
      `re-run on ${input.featureBranch} as it now is, and you are asked again with a fresh summary.`;
    await input.events?.emit({
      type: 'feature_close_refused',
      featureId: input.featureId,
      detail,
    });
    return {
      kind: 'feature_moved',
      detail,
      expected: input.expectedFeatureSha ?? '',
      actual: featureSha,
    };
  }

  const baseCover = await baseIsCovered(input, baseBeforeSha, featureSha);
  if (baseCover !== null) {
    await input.events?.emit({
      type: 'feature_close_refused',
      featureId: input.featureId,
      detail: baseCover,
    });
    return { kind: 'base_unverified', detail: baseCover, baseSha: baseBeforeSha };
  }

  // ==========================================================================
  // A RESUMED CLOSE MUST NOT TAG WHATEVER THE BASE BRANCH HAS DRIFTED TO
  // ==========================================================================
  // `git merge --no-ff` of a branch that is already merged commits **nothing**
  // and reports success, which is what makes re-approving after a failed tag
  // safe. But the tag is then created on `revParse(base)` — and if a colleague
  // pushed between the failed tag and the re-approval, that is *their* commit.
  // The delivery marker would name a tree nobody gated and the history line
  // would claim it as what was merged.
  //
  // So on a resumed close the base tip has to be the merge this close made:
  // the verified feature commit must be one of its parents. It is checked
  // **before** the merge command rather than after, so the refusal keeps the
  // `refused` contract — nothing attempted, base branch untouched.
  //
  // It refuses rather than tagging a remembered SHA. Remembering a commit and
  // acting on it later is the same pattern this module's header rejects for
  // `reset`: the repository can have moved past it, and a marker placed on a
  // commit chosen from memory is exactly as wrong as one placed on a commit
  // chosen by accident. A human deciding is right and a machine guessing is not
  // — the same answer `describeTagCollision` gives to the same shape of
  // problem.
  const resumed = await resumedTagTarget(input, baseBeforeSha, featureSha);
  if (resumed === 'moved-on') {
    return await refused(
      input,
      `${input.featureBranch} (${featureSha.slice(0, 8)}) is already merged into ${base}, but ` +
        `${base} has moved on since: its tip ${baseBeforeSha.slice(0, 8)} is not the merge that ` +
        `carries the feature. Merging again would commit nothing, so ${input.tagName} would be ` +
        `created on ${baseBeforeSha.slice(0, 8)} — a commit carrying work no gate run has seen, ` +
        `recorded as this feature's delivery.\n\nNothing was merged and nothing was tagged. The ` +
        `delivery commit is the merge that carries ${featureSha.slice(0, 8)}; find it with ` +
        `\`git log --ancestry-path --merges ${featureSha.slice(0, 8)}..${base}\` and tag it ` +
        `${input.tagName} yourself if you want the marker now — that is a git command, not a ` +
        `note edit.\n\nTo clear this without editing anything: \`factory reject ${input.featureId}\` ` +
        `sends the feature back to development, which does **not** unmerge it — its work stays on ` +
        `${base}. Approving again comes straight back to this message. Editing the note directly ` +
        'is only safe with the factory stopped (`factory kill`), per resolution A8.',
    );
  }
  if (resumed !== 'no' && resumed !== 'at-tip') {
    return await refused(
      input,
      `git could not say what ${base} (${baseBeforeSha.slice(0, 8)}) is made of, so there is no ` +
        `way to tell whether ${input.tagName} would mark the merge that carries ` +
        `${featureSha.slice(0, 8)} or some later commit: ${resumed}. Nothing was merged and ` +
        'nothing was tagged.',
    );
  }

  // Captured before anything moves, so the operator's checkout can be put back.
  const startingBranch = await git.currentBranch(git.repoRoot);
  const startingHead = startingBranch === null ? await git.revParse(git.repoRoot, 'HEAD') : null;

  await input.events?.emit({
    type: 'feature_close_started',
    featureId: input.featureId,
    from: input.featureBranch,
    into: base,
    baseBeforeSha,
  });

  try {
    let merged: Awaited<ReturnType<Git['mergeNoFf']>>;
    try {
      merged = await git.mergeNoFf(base, input.featureBranch);
    } catch (error) {
      // `ShellGit.mergeNoFf` raises when `git checkout <base>` is refused, which
      // real git does when an untracked file in the main checkout is tracked on
      // the base branch. Nothing was merged. This must not escape: an unhandled
      // raise here would reach `factory approve` as a stack trace, and on the
      // dispatcher's path it would be read as a dispatch failure and retried
      // every cycle with nobody told.
      return await refused(
        input,
        `the merge of ${input.featureBranch} into ${base} could not be started: ` +
          `${error instanceof Error ? error.message : String(error)}\n\nNothing was merged and ` +
          `${base} is untouched. Most often the main checkout at ${git.repoRoot} holds an ` +
          'untracked file that the base branch tracks — remove or move it, then approve again.',
      );
    }

    if (!merged.ok) {
      // `mergeNoFf` has already run `git merge --abort`: nothing is committed
      // and nothing is half-merged. Spec §10 — a conflict here escalates and is
      // never retried, and no agent resolves it (ADR-004).
      await input.events?.emit({
        type: 'feature_close_conflict',
        featureId: input.featureId,
        from: input.featureBranch,
        into: base,
        conflicts: merged.conflicts,
        detail: merged.detail,
      });
      return { kind: 'conflict', conflicts: merged.conflicts, detail: merged.detail };
    }

    const sha = await git.revParse(git.repoRoot, base);
    if (sha === null) {
      // Unreachable: a successful merge leaves a commit. Handled rather than
      // asserted because the alternative is a `done` feature with no evidence.
      return await refused(
        input,
        `${base} carried no commit after a merge git reported as successful.`,
      );
    }

    try {
      await git.tag(input.tagName, sha);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.events?.emit({
        type: 'feature_tag_failed',
        featureId: input.featureId,
        tag: input.tagName,
        sha,
        error: message,
      });
      // Nothing is rewound. See the header for the whole argument.
      return { kind: 'tag_failed', sha, baseBeforeSha, tag: input.tagName, error: message };
    }

    await input.events?.emit({
      type: 'feature_tagged',
      featureId: input.featureId,
      tag: input.tagName,
      sha,
    });
    await input.events?.emit({
      type: 'feature_closed',
      featureId: input.featureId,
      from: input.featureBranch,
      into: base,
      sha,
      tag: input.tagName,
    });

    return { kind: 'closed', sha, baseBeforeSha, tag: input.tagName, tagCreated: true };
  } finally {
    await restoreCheckout(input, startingBranch, startingHead);
  }
}

/**
 * Why this close must not be attempted at all, or `null`.
 *
 * `feature_branch` arrives from human-editable frontmatter (ADR-001) and
 * `featureBranchFor` returns it unconditionally, so it can name the base branch
 * — which would have this function merge the base branch into itself and then
 * tag it as a delivery of nothing.
 */
function forbiddenClose(input: CloseFeatureInput): string | null {
  const base = input.config.base_branch;

  if (input.featureBranch === base) {
    return (
      `refusing to close ${input.featureId}: its feature branch is ${input.featureBranch}, which ` +
      `is the base branch. Merging ${base} into itself and tagging the result would record a ` +
      `delivery of nothing. Fix \`feature_branch\` on the ${input.featureSlug} feature note.`
    );
  }
  if (input.tagName.trim() === '') {
    return `refusing to close ${input.featureId}: no tag name was derived, so nothing would mark the delivery.`;
  }
  return null;
}

/**
 * Is this a **resumed** close, and if so is the base tip still the merge it
 * made?
 *
 * `'no'` — the feature is not on the base branch yet, so a real merge is about
 * to happen and its commit is the tag target by construction.
 * `'at-tip'` — the feature is on the base branch and the tip is the merge that
 * carries it, so merging again is the documented no-op and the tag lands where
 * it should.
 * `'moved-on'` — the feature is on the base branch and the tip is something
 * else. Anything else returned is git's own failure text, which refuses too:
 * "we could not tell" is never "it is fine".
 */
async function resumedTagTarget(
  input: CloseFeatureInput,
  baseSha: string,
  featureSha: string,
): Promise<'no' | 'at-tip' | 'moved-on' | string> {
  let merged: boolean;
  try {
    merged = await input.git.isAncestor(featureSha, baseSha);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!merged) return 'no';

  let parents: readonly string[];
  try {
    parents = await input.git.parentsOf(baseSha);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return parents.includes(featureSha) ? 'at-tip' : 'moved-on';
}

/**
 * Why merging into the base branch right now would land ungated code, or
 * `null` when it would not.
 *
 * Two ways for the base branch to be covered, and they are not alternatives so
 * much as the same rule seen twice:
 *
 * 1. **The base tip is already an ancestor of the feature branch tip.** Then
 *    `git merge --no-ff` produces a commit whose *tree is the feature branch
 *    tip's tree*, and that tree is what the pre-approval gates passed. This is
 *    the normal case — the feature branch was cut from the base branch — and it
 *    is why there is no second gate run on a typical close.
 * 2. **A gate run passed on the base branch at exactly this commit.** That is
 *    `base_verified_sha`, recorded by `verifyBaseBranch` when case 1 did not
 *    hold. Exact equality, because a base branch that moved *again* after being
 *    verified is back to carrying commits nothing has judged.
 *
 * The feature branch tip is used for case 1 rather than the note's
 * `verified_sha` because by the time this runs the two are the same thing:
 * `factory approve` refuses when the branch has moved off `verified_sha`, and
 * the auto-approve path merges inside the same dispatch that gated it. Reading
 * the branch here keeps this function's inputs to what git can answer.
 *
 * Anything git cannot answer blocks. See `verifyBaseBranch`.
 */
async function baseIsCovered(
  input: CloseFeatureInput,
  baseSha: string,
  featureSha: string,
): Promise<string | null> {
  const base = input.config.base_branch;

  if (input.baseVerifiedSha !== null && input.baseVerifiedSha === baseSha) return null;

  let contained: boolean;
  try {
    contained = await input.git.isAncestor(baseSha, featureSha);
  } catch (error) {
    return (
      `refusing to close ${input.featureId}: git could not say whether ${base} ` +
      `(${baseSha.slice(0, 8)}) is already contained in ${input.featureBranch} ` +
      `(${featureSha.slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}. ` +
      `Nothing was merged and nothing was tagged, because a base branch that cannot be judged is ` +
      'never assumed green.'
    );
  }
  if (contained) return null;

  // The other direction: the feature is **already on** the base branch, so
  // `git merge --no-ff` reports "Already up to date." and commits nothing. This
  // is the resumed close — a first attempt that merged and then failed at the
  // tag — and it must stay possible, because leaving the merge and re-approving
  // is the documented fix for that state (see the header). Nothing lands, so
  // there is nothing ungated to land.
  try {
    if (await input.git.isAncestor(featureSha, baseSha)) return null;
  } catch {
    // Already handled above for the direction that matters; a failure here only
    // means this shortcut cannot be taken, and the refusal below is correct.
  }

  const verified =
    input.baseVerifiedSha === null
      ? 'no gate run has ever covered it'
      : `the gate run that covered it was taken at ${input.baseVerifiedSha.slice(0, 8)}`;

  return (
    `refusing to close ${input.featureId}: ${base} is at ${baseSha.slice(0, 8)} and carries ` +
    `commits that ${input.featureBranch} (${featureSha.slice(0, 8)}) does not, and ${verified}. ` +
    `Merging now would put a tree nobody has gated onto ${base} and tag it as a delivery. ` +
    `Nothing was merged and nothing was tagged.\n\nThis is not a judgement about ${base} — it may ` +
    `well be fine. **Approve ${input.featureId} again** to send it back to be verified: the gates ` +
    `re-run on both branches as they now are, and you are asked again with a fresh summary.`
  );
}

/** What an already-existing tag means, in terms a human can act on. */
function describeTagCollision(
  input: CloseFeatureInput,
  existingTag: string,
  baseBeforeSha: string,
  base: string,
): string {
  const shared =
    `The tag is never moved and never given a suffix: moving it would erase the marker of a ` +
    `delivery that already happened, and a suffix would make ${input.tagName} stop being ` +
    'derivable from the slug and the date, which is the only thing that makes this collision ' +
    'visible at all.';

  if (existingTag === baseBeforeSha) {
    return (
      `refusing to close ${input.featureId}: the tag ${input.tagName} already exists and already ` +
      `points at the tip of ${base} (${existingTag}). That is what a close which got as far as ` +
      'the tag and no further looks like, so this feature may already be on the base branch. ' +
      `Check \`git log ${base}\`; if that tip is this feature's merge, delete the tag ` +
      `(\`git tag -d ${input.tagName}\`) and approve again — the merge is already there, so git ` +
      'reports it up to date and the close goes straight to re-creating the tag and recording ' +
      `the feature done. No note editing is needed. ${shared} Nothing was merged.`
    );
  }
  return (
    `refusing to close ${input.featureId}: the tag ${input.tagName} already exists and points at ` +
    `${existingTag}, which is not the tip of ${base} (${baseBeforeSha}). Something else made ` +
    `this tag. Delete it if it was a mistake, then approve again. ${shared} Nothing was merged.`
  );
}

async function refused(input: CloseFeatureInput, detail: string): Promise<CloseFeatureOutcome> {
  await input.events?.emit({
    type: 'feature_close_refused',
    featureId: input.featureId,
    detail,
  });
  return { kind: 'refused', detail };
}

/**
 * Return the main checkout to the branch (or detached SHA) it was on.
 *
 * `mergeNoFf` leaves the repo on the branch it merged into — the base branch.
 * The operator's checkout is theirs; the close borrowed it for one command, and
 * the alternative is a human's next `git status` reporting a branch they never
 * switched to.
 *
 * **Never throws.** It runs in a `finally`, and an exception there would replace
 * the close's real outcome — including a conflict a human needs to read about —
 * with a checkout error. Unlike `./merge.ts`'s equivalent, no destructive
 * command hides behind a silent failure here, because nothing is ever reverted.
 */
async function restoreCheckout(
  input: CloseFeatureInput,
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
    // NOT `feature_close_refused`: by the time a restore can fail, the merge has
    // landed. That event says "nothing was attempted", and a log line claiming
    // nothing happened on a path where the base branch moved is worse than no
    // line at all.
    await input.events?.emit({
      type: 'feature_close_cleanup_failed',
      featureId: input.featureId,
      detail:
        `the close finished but ${input.git.repoRoot} could not be returned to ` +
        `${branch ?? head ?? 'its previous HEAD'}: ` +
        `${error instanceof Error ? error.message : String(error)}. The checkout is left on ` +
        `${input.config.base_branch}.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Part 1: the dispatcher's side — gates on the feature branch, then the
// checkpoint.
// ---------------------------------------------------------------------------

/**
 * A feature whose tickets are all done: verify the branch, then ask a human.
 *
 * Reached only from `handle` in `./dispatch.ts`, and only when
 * `canCloseFeature` holds. Everything it writes lands in **one** note write per
 * outcome, for the reason `./dispatch.ts`'s header gives.
 */
export async function runFeatureClose(
  deps: DispatchDeps,
  item: Actionable,
  context: DispatchContext,
): Promise<DispatchOutcome> {
  const git = deps.git;
  const gates = deps.gates;
  const featureWorkspace = deps.featureWorkspace;
  if (git === undefined || gates === undefined || featureWorkspace === undefined) {
    return idle(item, 'no feature-close capability is available');
  }

  const feature = item.note as FeatureNote;
  const attempt = feature.frontmatter.attempts + 1;
  const featureBranch = await featureBranchFor(deps, item.slug);

  if (featureBranch === deps.config.base_branch) {
    return await pauseFeature(deps, item, deps.now(), 'escalation', {
      detail:
        `refusing to verify ${item.id}: its feature branch is ${featureBranch}, which is the ` +
        'base branch. Only the feature close may write the base branch (plan Section E item 8) ' +
        `and it will not do it to a branch that is already there. Fix \`feature_branch\` on the ` +
        `${item.slug} feature note.`,
      resumeTo: 'awaiting_feature_close',
    });
  }

  const ref = await git.revParse(git.repoRoot, featureBranch);
  if (ref === null) {
    return await pauseFeature(deps, item, deps.now(), 'escalation', {
      detail:
        `${featureBranch} does not resolve to a commit, so there is nothing to verify or merge ` +
        `for ${item.id}. Every one of its tickets is done, so the branch should carry their ` +
        'merges — check that `feature_branch` on the feature note names the right branch.',
      resumeTo: 'awaiting_feature_close',
    });
  }

  let results: GateResults;
  try {
    results = await runCloseGates(deps, item, featureBranch, ref, attempt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return await pauseFeature(deps, item, deps.now(), 'escalation', {
      detail:
        `the gates on ${featureBranch} could not be run for ${item.id}: ${reason}. The feature ` +
        'is not offered for final acceptance on evidence that was never gathered.',
      resumeTo: 'awaiting_feature_close',
      section: [
        SECTION.gateResults,
        renderCloseGateResults(unrunResults(deps.config), { branch: featureBranch, sha: ref, attempt }),
      ],
    });
  }

  const green = allGatesPassed(results);
  await deps.events?.emit({
    type: 'gates_finished',
    itemId: item.id,
    attempt,
    green,
    commitSha: ref,
    detail: describeGateFailure(results),
  });

  const gateSection: readonly [string, string] = [
    SECTION.gateResults,
    renderCloseGateResults(results, { branch: featureBranch, sha: ref, attempt }),
  ];

  if (!green) {
    // ========================================================================
    // A RED FEATURE BRANCH IS NEVER OFFERED FOR APPROVAL
    // ========================================================================
    // The checkpoint's whole value is that a human approves something that has
    // been verified. Offering a red branch would ask them to authorise a base
    // merge on evidence that says not to, and the answer they gave would then
    // be the only thing standing between a red branch and the base branch.
    return await pauseFeature(deps, item, deps.now(), 'escalation', {
      detail:
        `${describeGateFailure(results)} on ${featureBranch} at ${ref.slice(0, 8)}. Every ticket ` +
        `in ${item.id} passed its own gates and the branch they landed on does not, so the ` +
        'feature is not offered for final acceptance. Fix the branch, or reject the feature back ' +
        'to development for another ticket.',
      resumeTo: 'awaiting_feature_close',
      section: gateSection,
    });
  }

  // ==========================================================================
  // THE BASE BRANCH IS VERIFIED TOO, AND A RED ONE BLOCKS THE MERGE
  // ==========================================================================
  // Everything above judges `feature/<slug>`. The thing that actually happens
  // on approval is a merge into a branch nobody in the factory owns, and until
  // this ran the close never looked at it — so a base branch that was already
  // red took the merge anyway and the feature was tagged as delivered on top of
  // it (requirements §16's "a deliberately red base branch blocks merge").
  //
  // What is being asked is narrower than "is the base branch green": it is
  // **has the tree that will land been gated**. See `verifyBaseBranch`.
  const baseCheck = await verifyBaseBranch(deps, item, ref, attempt);
  if (baseCheck.kind !== 'ok') {
    return await pauseFeature(deps, item, deps.now(), 'escalation', {
      detail: baseCheck.detail,
      resumeTo: 'awaiting_feature_close',
      ...(baseCheck.section === undefined ? {} : { section: baseCheck.section }),
    });
  }

  // ==========================================================================
  // ONE CLOCK READING, AND IT IS THE AUTHORITY FOR THE TAG NAME
  // ==========================================================================
  // The summary promises a tag name and the close creates one. They used to read
  // the clock separately, so a human approving the next day was promised
  // `factory/<slug>/<yesterday>` and given `factory/<slug>/<today>` — proven on
  // injected clocks, not left to wall-clock luck. `pausedAt` is read once here,
  // becomes the `paused_at` field via `pauseItem`, and is what `factory approve`
  // re-derives the name from, so the promise and the tag cannot disagree.
  //
  // It also dates the delivery by **when it was verified** rather than by when
  // somebody got round to clicking, which is the more useful of the two and the
  // only one that is stable across a retry.
  // ==========================================================================
  // A STANDING APPROVAL, AND WHY IT IS VOID THE MOMENT THE FEATURE MOVES
  // ==========================================================================
  // `factory approve` records one when a human approved this feature and the
  // **base** branch had moved out from under it — see `recordStandingApproval`.
  // The person judged the feature commit; the summary never showed them the
  // base branch; so their answer is still an answer, and the only thing that
  // was missing was a gate run on the base branch, which has now happened.
  //
  // It is honoured **only** when it names the commit the gates have just
  // verified. A feature branch that moved means what they approved is not what
  // would land, so the approval is cleared here and a person is asked again —
  // the same line `verified_sha` draws one level down, in the same direction.
  const approvedSha = feature.frontmatter.approved_sha;
  const standing =
    approvedSha !== null && approvedSha !== undefined && approvedSha === ref
      ? {
          note: feature.frontmatter.approved_note ?? null,
          tag: feature.frontmatter.approved_tag ?? null,
        }
      : null;

  const pausedAt = deps.now();
  // ==========================================================================
  // A STANDING APPROVAL KEEPS THE NAME IT WAS PROMISED
  // ==========================================================================
  // Phase 11 note 6 made `paused_at` the single authority for the date so that
  // the tag a person is shown is the tag that gets created. A standing approval
  // outlives its pause — `clearPause` nulls `paused_at`, and a red base branch
  // in between overwrites it — so the promised name travels with the approval
  // in `approved_tag` rather than being re-derived from a clock that has moved
  // on. Falling back to this instant covers only a hand-edited note.
  const tagName = standing?.tag ?? featureTagName(item.slug, pausedAt);

  const tickets = context.tickets.filter((ticket) => ticket.frontmatter.feature === item.slug);
  const summary = renderApprovalSummary({
    featureId: item.id,
    featureBranch,
    baseBranch: deps.config.base_branch,
    sha: ref,
    tickets,
    tagName,
  });

  // Body sections only, and no `gate_results` frontmatter. That field belongs to
  // a ticket (`TicketFrontmatter`) and is read by `gatesAllGreen` to answer a
  // question about one ticket's own verdict; putting a feature-branch run there
  // would be an untyped key on a feature note answering a different question.
  // `merge.ts` made the same call for the same reason.
  //
  // `verified_sha` **is** frontmatter, and it has to be: it is the commit the
  // gates just passed, and `factory approve` re-checks it against the branch tip
  // before it merges anything. Written in the same single write as the pause, so
  // there is no window in which the note offers an approval without recording
  // what the approval is for.
  const staged = composeNote({
    note: feature,
    sections: [gateSection, [SECTION.notes, summary]],
    frontmatter: {
      verified_sha: ref,
      base_verified_sha: baseCheck.baseVerifiedSha,
      // A stale approval is erased rather than left to be read as current.
      ...(standing === null
        ? { approved_sha: null, approved_note: null, approved_tag: null }
        : {}),
    },
  });

  if (standing !== null) {
    return await mergeAndFinish(
      deps,
      item,
      staged,
      featureBranch,
      tagName,
      `approved by a human at ${ref.slice(0, 8)}, held until ${deps.config.base_branch} was verified`,
      { note: standing.note },
    );
  }

  if (checkpointEnabled(deps.config, 'final_acceptance')) {
    const spec = CHECKPOINTS.final_acceptance;
    const paused = pauseItem(staged, {
      reason: 'checkpoint',
      detail: spec.description,
      resumeTo: spec.resumeTo,
      rejectTo: spec.rejectTo,
      now: pausedAt,
      actor: 'orchestrator',
      historyNote: `checkpoint ${spec.name}`,
    });

    await writeAnyNote(deps.storage, item.path, paused);
    await deps.events?.emit({
      type: 'item_paused',
      itemId: item.id,
      pauseReason: 'checkpoint',
      detail: spec.description,
      resumeTo: spec.resumeTo,
      rejectTo: spec.rejectTo,
    });
    await refreshViews(deps);
    await deps.hooks?.crash?.('after_persist', { itemId: item.id, role: null });

    return {
      itemId: item.id,
      claimed: true,
      ran: null,
      from: item.stage,
      to: 'needs_human',
      paused: true,
    };
  }

  // ==========================================================================
  // `final_acceptance: false` — the operator pre-authorised this close
  // ==========================================================================
  // A disabled checkpoint is skipped **entirely**: the feature does not pause
  // and does not touch `needs_human` (`checkpointEnabled`). So the close happens
  // here, in the same dispatch, with no person involved.
  //
  // The transition is therefore recorded with the **`orchestrator`** actor,
  // because that is who took it. `awaiting_feature_close → done` was widened to
  // permit the orchestrator for exactly this reason: `actor` is the
  // machine-readable field a later query trusts, and writing `human` for a move
  // **nobody decided** is a false audit trail. The history note says *why* it
  // was permitted — the config switch — so the record carries both facts.
  //
  // ==========================================================================
  // WHAT `actor` RECORDS IS THE DECISION, NOT WHO RAN THE COMMAND
  // ==========================================================================
  // Stated precisely, because the standing-approval close above would otherwise
  // read as a contradiction of the paragraph you just read: it records `human`
  // for a `git merge` the orchestrator's own process performed.
  //
  // Both are the same rule. Every close in this file is executed by the
  // orchestrator — `factory approve` merges in the CLI process, and that is
  // machinery too. What differs is **whose answer authorised it**: the config
  // switch here (nobody's, so `orchestrator`), and a named person's approval of
  // this exact commit there (theirs, so `human`). A later query asking "did a
  // person sign off on this delivery?" gets the truth from both lines, which is
  // the only question `actor` is ever asked about a close.
  //
  // The falsehood Phase 11 removed was `human` on a line **no person had any
  // part in**, not `human` on a line a person caused.
  return await mergeAndFinish(
    deps,
    item,
    staged,
    featureBranch,
    tagName,
    'the final_acceptance checkpoint is disabled in config',
  );
}

/**
 * Merge into base, tag, and set the feature `done` — or park it.
 *
 * Only the disabled-checkpoint path reaches this. `factory approve` performs the
 * same close through `closeFeature` and writes its own note, because the note it
 * writes carries a human's approval text and this one carries a config setting.
 * What the two share is `describeCloseFailure`, so they cannot end up telling a
 * human different things about the same failed merge.
 *
 * ============================================================================
 * THE SECOND LOCK ON THE HUMAN CHECKPOINT
 * ============================================================================
 * Read `approval` first: the lock is "the checkpoint is on **and** no human has
 * approved this commit". A standing approval is a real approval — a person gave
 * it, for this commit, and only the base branch's gate run was outstanding — so
 * it opens the lock, and the close it produces records `human` as the actor.
 * `awaiting_feature_close → done` permits the orchestrator (see the transition
 * table), so the transition table no longer stops this function from closing a
 * feature whose checkpoint is **enabled**. Nor does the guard: the guard demands
 * a clean base merge and a tag, and this function is the code that produces
 * both — by the time it asks, it can answer.
 *
 * What stops it is that the checkpoint decision is made **before any
 * base-branch write**, in the one caller above, which returns at the pause. So
 * the facts the guard needs are never produced for a feature that should be
 * waiting on a person.
 *
 * That is a single `if` in a single caller, which is thinner than the property
 * deserves. This re-check is the second lock on the same door, in the shape
 * `dispatch.ts` already uses for the hard gate: **not redundant, because it
 * closes a different route in.** A future caller of this function — a retry
 * path, a resume, a dashboard action — would otherwise merge into the base
 * branch and mark the feature delivered while the note still said a human had
 * to approve it, and the transition table would permit every step.
 *
 * It refuses rather than idling so that a human is told, and it refuses
 * *before* `closeFeature`, so nothing is merged and nothing is tagged.
 *
 * **Exported only so that the lock can be tested.** The review found it
 * unreachable and therefore unverified — removing it left the whole suite green,
 * because nothing outside this module could call it. A lock nothing can drive is
 * a lock nobody knows works, so the export exists for
 * `test/unit/orchestrator/featureClose.test.ts` and for no production caller.
 * The same reasoning as `payloadChars` and `parsePorcelainZ`: the part that can
 * be wrong invisibly is the part that gets a seam.
 */
export async function mergeAndFinish(
  deps: DispatchDeps,
  item: Actionable,
  staged: FeatureNote,
  featureBranch: string,
  /** Derived once by the caller, from the same instant the summary quoted. */
  tagName: string,
  because: string,
  /**
   * A human's standing approval for the commit being closed, when there is one.
   *
   * Its presence is what lets this run with the checkpoint **enabled** — see
   * the second lock below — and it is what makes the recorded actor `human`.
   * The caller has already confirmed that the approval names the commit the
   * gates just verified; this function does not re-derive that, because the
   * note it is handed is the one the caller composed from that check.
   */
  approval?: { readonly note: string | null },
): Promise<DispatchOutcome> {
  const git = deps.git;
  if (git === undefined) return idle(item, 'no git handle is available to close the feature');

  const now = deps.now();

  if (checkpointEnabled(deps.config, 'final_acceptance') && approval === undefined) {
    return await pauseFeature(deps, item, now, 'escalation', {
      detail:
        `refusing to close ${item.id} without an approval: the final_acceptance checkpoint is ` +
        'enabled and no human has approved this commit, so this feature must pause and wait for ' +
        `one before anything is merged into ${deps.config.base_branch}. Nothing was merged and ` +
        'nothing was tagged. Reaching this message means some code path asked for the close while ' +
        'the checkpoint was on, which is a bug in the orchestrator rather than anything wrong ' +
        'with the feature — the checkpoint is what makes the approval mandatory, and it must not ' +
        'be reachable around.',
      resumeTo: 'awaiting_feature_close',
      note: staged,
    });
  }
  const outcome = await closeFeature({
    git,
    config: deps.config,
    featureId: item.id,
    featureSlug: item.slug,
    featureBranch,
    tagName,
    // Straight off the note the caller just staged, so the second lock reads
    // the same fact the checkpoint would have recorded rather than a value
    // this function invented. `verified_sha` is the commit the gates that ran
    // moments ago actually passed — the branch may have moved since, and that
    // is exactly what `expectedFeatureSha` exists to catch.
    baseVerifiedSha: staged.frontmatter.base_verified_sha,
    expectedFeatureSha: staged.frontmatter.verified_sha,
    ...(deps.events === undefined ? {} : { events: deps.events }),
  });

  if (outcome.kind !== 'closed') {
    const parked = describeCloseFailure(outcome, {
      featureId: item.id,
      featureBranch,
      baseBranch: deps.config.base_branch,
    });
    return await pauseFeature(deps, item, now, parked.reason, {
      // `resumeTo` comes from the failure rather than being hardcoded: an
      // unverified base branch is the one failure `factory approve` cannot
      // clear on its own, so approving again has to hand it back to the loop.
      resumeTo: parked.resumeTo,
      detail: parked.detail,
      note: staged,
    });
  }

  const actor = approval === undefined ? 'orchestrator' : 'human';
  const historyNote =
    `final acceptance ${approval === undefined ? 'auto-approved' : 'approved'} (${because}): ` +
    `merged ${outcome.sha.slice(0, 8)} into ${deps.config.base_branch}, tagged ${outcome.tag}` +
    (approval?.note === undefined || approval.note === null ? '' : ` — ${approval.note}`);

  const delivered =
    approval === undefined
      ? composeNote({ note: staged, frontmatter: { tag: outcome.tag } })
      : composeNote({
          note: staged,
          sections: [
            [
              SECTION.notes,
              `**Closed on the approval already given** — \`${featureBranch}\` merged into ` +
                `\`${deps.config.base_branch}\` at \`${outcome.sha}\`, tagged ` +
                `\`${outcome.tag}\`.` +
                (approval.note === null ? '' : `\n\n${approval.note}`),
            ],
          ],
          frontmatter: { tag: outcome.tag },
        });

  const next = transition(
    delivered,
    'done',
    // Whoever actually took this move is what the audit trail records: the
    // orchestrator when the checkpoint is switched off, and the **human** when
    // it is on and they had already approved this commit. See the note above
    // the call to this function.
    actor,
    now,
    // Without both of these the guard refuses — see `featureCloseVerified`.
    { baseMergeClean: true, featureTag: outcome.tag },
    historyNote,
  );
  await persist(deps, item, next, 'done', actor, now, null, historyNote);

  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: 'done',
    paused: false,
  };
}

/**
 * What a failed close means for the note: the pause reason, and the text a human
 * reads first.
 *
 * Exported because `factory approve` reaches the same four outcomes and must
 * describe them identically — two copies of "what does a base-branch merge
 * failure mean" is one copy too many, and the one that drifts is the one nobody
 * is looking at.
 */
export function describeCloseFailure(
  outcome: Exclude<CloseFeatureOutcome, { kind: 'closed' }>,
  context: {
    readonly featureId: string;
    readonly featureBranch: string;
    readonly baseBranch: string;
  },
): {
  readonly reason: PauseReason;
  readonly detail: string;
  /**
   * Where approving again should send the feature.
   *
   * `done` for everything a human fixes in git and re-approves straight back
   * into the close. `awaiting_feature_close` only for the base branch, because
   * clearing that one needs a gate run and `factory approve` deliberately
   * cannot do one — so approving again has to hand the feature back to the loop
   * instead of walking into the same refusal forever.
   */
  readonly resumeTo: 'done' | 'awaiting_feature_close';
} {
  if (outcome.kind === 'base_unverified' || outcome.kind === 'feature_moved') {
    return {
      reason: 'escalation',
      detail: outcome.detail,
      resumeTo: 'awaiting_feature_close',
    };
  }

  if (outcome.kind === 'conflict') {
    const named =
      outcome.conflicts.length > 0
        ? `Conflicted paths: ${outcome.conflicts.join(', ')}.`
        : 'git named **no conflicted paths**, so nothing has conflict markers in it — the merge ' +
          'was refused for another reason, and the most common one is an untracked file in the ' +
          "main checkout that the merge would have overwritten. Read git's own message below.";
    return {
      reason: 'merge_conflict',
      resumeTo: 'done',
      detail:
        `${context.featureBranch} does not merge cleanly into ${context.baseBranch}. ${named} ` +
        'The merge was aborted, so the base branch is exactly where it was and the repository ' +
        'holds no half-merged state. **This is never retried automatically and no agent resolves ' +
        'it** (spec §10, ADR-004): rebase or fix the feature branch by hand and approve again, or ' +
        `reject ${context.featureId} back to development.\n\n${outcome.detail}`,
    };
  }

  if (outcome.kind === 'tag_failed') {
    return {
      reason: 'escalation',
      resumeTo: 'done',
      detail:
        `**${context.featureBranch} is merged into ${context.baseBranch} and the tag is not ` +
        `there.** ${context.baseBranch} is at ${outcome.sha} (it was ${outcome.baseBeforeSha}), ` +
        `and \`git tag ${outcome.tag}\` failed: ${outcome.error}\n\nNothing has been rewound, ` +
        'deliberately — rewinding a base branch can drop commits that were never ours to drop. ' +
        `${context.featureId} stays parked because it is not tagged, and it must not be recorded ` +
        'as delivered without the marker of what was delivered. Approving again is safe: the ' +
        'merge is already there, so git reports it as up to date and the close goes straight to ' +
        'the tag.',
    };
  }

  return {
    reason: 'escalation',
    resumeTo: 'done',
    detail: `refusing to close ${context.featureId}: ${outcome.detail}`,
  };
}

/** The `## Gate Results` text for a feature-branch verification run. */
export function renderCloseGateResults(
  results: GateResults,
  context: { readonly branch: string; readonly sha: string; readonly attempt: number },
): string {
  return [
    `**Feature-branch gates** — \`${context.branch}\` at \`${context.sha}\`, run before final ` +
      'acceptance. Every ticket passed its own gates and passed them again on the branch it ' +
      'merged into; this is the run that judges the branch as a whole, and it is what a human ' +
      'approves the base-branch merge against.',
    renderGateResults(results, { attempt: context.attempt, commitSha: context.sha }),
  ].join('\n\n');
}

/**
 * The `## Gate Results` text for a **base**-branch verification run.
 *
 * Deliberately a different first line from the feature-branch one. The two runs
 * answer different questions and the answers have different owners: a red
 * feature branch is the factory's problem, and a red base branch is somebody
 * else's. Whoever opens the note after a refusal has to be able to tell which
 * one they are looking at from the first sentence.
 */
export function renderBaseGateResults(
  results: GateResults,
  context: { readonly branch: string; readonly sha: string; readonly attempt: number },
): string {
  return [
    `**Base-branch gates** — \`${context.branch}\` at \`${context.sha}\`, run before final ` +
      'acceptance. The base branch carries commits the verified feature commit does not, so the ' +
      'merge would land a tree nobody has judged; this run judges the branch being merged **into**. ' +
      'It is not a verdict on the feature.',
    renderGateResults(results, { attempt: context.attempt, commitSha: context.sha }),
  ].join('\n\n');
}

/**
 * The approval summary — what a human is actually being asked about.
 *
 * Tickets, the commit each one merged as, the branch and commit the gates ran
 * against, and the tag that will be created. Every one of those is a thing the
 * approver would otherwise have to go and look up in git, and an approval given
 * without looking is the failure this section exists to prevent.
 */
export function renderApprovalSummary(input: {
  readonly featureId: string;
  readonly featureBranch: string;
  readonly baseBranch: string;
  readonly sha: string;
  readonly tickets: readonly TicketNote[];
  readonly tagName: string;
}): string {
  const ordered = [...input.tickets].sort(
    (left, right) => left.frontmatter.ordinal - right.frontmatter.ordinal,
  );

  const rows = ordered.map((ticket) => {
    const front = ticket.frontmatter;
    const commit = mergeCommitOf(ticket);
    return (
      `- \`${front.id}\` — ${front.title} — ${front.status}` +
      (commit === null ? ' — merge commit not recorded' : ` — merged as \`${commit}\``)
    );
  });

  return [
    `**Final acceptance — ${input.featureId}**`,
    '',
    `Approving merges \`${input.featureBranch}\` into \`${input.baseBranch}\` with \`--no-ff\` ` +
      `and tags the result \`${input.tagName}\`. Rejecting sends the feature back to development ` +
      'with your reason.',
    '',
    `Verified at \`${input.sha}\` on \`${input.featureBranch}\`. Gate results are in the section ` +
      'above.',
    '',
    rows.length === 0
      ? '- (no tickets found for this feature, which should not be possible at this state)'
      : `${String(ordered.length)} ticket(s):\n\n${rows.join('\n')}`,
  ].join('\n');
}

/**
 * The commit a ticket merged as, read back out of its own `## History`.
 *
 * The merge writes `merged <sha> into <branch>` as the history note of its
 * `merge → done` line (`runMerge` in `./dispatch.ts`), and that line is the only
 * record of the SHA that survives: the ticket branch is deleted on success, so
 * there is nothing left to `rev-parse`, and `TicketFrontmatter` has no field for
 * it.
 *
 * Returns `null` rather than guessing when the line is not there — a summary
 * that invented a plausible SHA would be worse than one that says it does not
 * know, because the whole point of the number is that a human can check it.
 */
export function mergeCommitOf(ticket: TicketNote): string | null {
  for (const line of historyLines(ticket.body)) {
    const parts = line.split('|').map((part) => part.trim());
    const move = parts[1] ?? '';
    if (!move.startsWith('merge ') || !move.endsWith('done')) continue;
    const note = parts.slice(3).join(' | ');
    const sha = /\b[0-9a-f]{7,40}\b/.exec(note);
    if (sha !== null) return sha[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pieces.
// ---------------------------------------------------------------------------

async function runCloseGates(
  deps: DispatchDeps,
  item: Actionable,
  branch: string,
  ref: string,
  attempt: number,
  /**
   * Which branch is being judged: the feature's own, or the base branch it is
   * about to be merged into. It picks the throwaway directory's name and the
   * gate log's, and nothing else — the run itself is identical, because the
   * question is identical.
   */
  kind: 'close' | 'base' = 'close',
): Promise<GateResults> {
  const gates = deps.gates;
  const provide = deps.featureWorkspace;
  if (gates === undefined || provide === undefined) {
    throw new Error('runCloseGates called without a gate runner or a workspace provider');
  }

  const workspace = await provide({
    featureSlug: item.slug,
    branch,
    ref,
    // `FeatureVerifyRequest.ticketId` names the item the tree belongs to; here
    // that is the feature itself. `label` keeps the directory from claiming to
    // be a merge verification, which this is not.
    ticketId: item.id,
    label: `${item.id}-${kind}`,
  });

  try {
    return await gates.run(workspace.cwd, deps.config.gates, {
      // ====================================================================
      // THE COMMIT IS IN THE LOG PATH, AND IT HAS TO BE
      // ====================================================================
      // A feature's `attempts` never moves, so every close verification used
      // `attempt 1` and a re-verification after a reject **overwrote the
      // earlier run's logs** — destroying exactly the run whoever is debugging
      // a rejected feature came to read. Phase 5 settled the principle: a run
      // keeps its own transcript rather than overwriting one.
      //
      // Keyed on the verified commit rather than on a counter, because that is
      // the thing that actually distinguishes two runs. Two verifications of
      // the *same* commit produce the same verdict, so sharing a path there is
      // correct rather than lossy; two verifications of different commits are
      // the case that matters and they now land in different files.
      //
      // Deliberately **not** by incrementing the feature's `attempts`: nothing
      // reads a feature's attempt count, and `attempts.ts`'s own rule is that a
      // number nobody acts on should not be written.
      logPathFor: (gate: GateName) =>
        deps.paths.gateLogPath(item.slug, `${item.id}-${kind}-${ref.slice(0, 8)}`, attempt, gate),
      maxOutputChars: deps.config.gate_output_chars,
      timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      onGateFinished: async (gate, result) => {
        await deps.events?.emit({
          type: 'gate_result',
          itemId: item.id,
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
 * Has the base branch been judged, and by what?
 *
 * `baseVerifiedSha` is what reaches `base_verified_sha` on the note: the base
 * commit a gate run actually passed, or `null` when no run was needed.
 */
type BaseVerification =
  | { readonly kind: 'ok'; readonly baseVerifiedSha: string | null }
  | {
      readonly kind: 'blocked';
      readonly detail: string;
      readonly section?: readonly [heading: string, markdown: string];
    };

/**
 * Verify the branch the feature is about to be merged **into**.
 *
 * ============================================================================
 * THE QUESTION IS "HAS THE TREE THAT WILL LAND BEEN GATED", NOT "IS BASE GREEN"
 * ============================================================================
 * That distinction is what keeps this from being a second full gate run on
 * every single close. `git merge --no-ff <base> <- <feature>` where the base tip
 * is already an **ancestor** of the verified feature commit produces a merge
 * commit whose *tree is that feature commit's tree* — the very tree the
 * feature-branch gates just passed. There is nothing left to judge, so nothing
 * is run, and `base_verified_sha` stays `null`.
 *
 * That is also the normal case: the feature branch was cut from the base branch
 * and every ticket merged into it, so the base is behind it by construction. A
 * base branch that is *not* an ancestor is one that has moved on its own — a
 * colleague's commit, a pull, a hotfix — and that is exactly the situation
 * requirements §16 describes: commits that will land on approval and that no
 * gate run has ever seen. Those get their own run.
 *
 * ============================================================================
 * A RED BASE BRANCH IS NOT THE FEATURE'S FAULT, AND MUST NOT READ LIKE IT
 * ============================================================================
 * Every message below says so in its first sentence, and the feature is parked
 * at `escalation` with `resume_to: awaiting_feature_close` — fix the base, then
 * approve, and the whole verification is taken again from scratch. Nothing is
 * charged against the feature: a feature's `attempts` is never incremented by
 * the close at all, and the feature-branch gate verdict written above stays in
 * the note, green, next to the base run that is not.
 *
 * ============================================================================
 * A BASE THAT CANNOT BE GATED REFUSES. IT IS NEVER ASSUMED GREEN.
 * ============================================================================
 * `git merge-base` failing, the base not resolving, and the gate run throwing
 * are all "we do not know", and plan Section E item 3's rule is that an absence
 * of evidence never advances anything. Each one blocks.
 */
async function verifyBaseBranch(
  deps: DispatchDeps,
  item: Actionable,
  /** The verified feature commit. What would actually be merged. */
  featureSha: string,
  attempt: number,
): Promise<BaseVerification> {
  const git = deps.git;
  const base = deps.config.base_branch;
  if (git === undefined) {
    return { kind: 'blocked', detail: 'no git handle is available to verify the base branch' };
  }

  const baseSha = await git.revParse(git.repoRoot, base);
  if (baseSha === null) {
    return {
      kind: 'blocked',
      detail:
        `the base branch ${base} does not resolve to a commit in ${git.repoRoot}, so there is ` +
        `nothing for ${item.id} to be merged into and nothing that could be verified. This is a ` +
        `problem with ${base} or with \`base_branch\` in config.yml, not with the feature — its ` +
        'own branch passed its gates. Fix the branch name, then approve to verify again.',
    };
  }

  let contained: boolean;
  try {
    contained = await git.isAncestor(baseSha, featureSha);
  } catch (error) {
    return {
      kind: 'blocked',
      detail:
        `git could not say whether ${base} (${baseSha.slice(0, 8)}) is already contained in the ` +
        `verified commit ${featureSha.slice(0, 8)}: ` +
        `${error instanceof Error ? error.message : String(error)}. Without that answer there is ` +
        `no way to tell whether the merge would land code nobody has gated, so ${item.id} is not ` +
        'offered for final acceptance. Nothing is wrong with the feature itself.',
    };
  }

  // The merge would produce the verified commit's tree. Already judged.
  if (contained) return { kind: 'ok', baseVerifiedSha: null };

  let results: GateResults;
  try {
    results = await runCloseGates(deps, item, base, baseSha, attempt, 'base');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: 'blocked',
      detail:
        `the gates on the base branch ${base} could not be run: ${reason}. ${base} has moved on ` +
        `since ${item.id}'s branch was cut, so approving would merge into commits no gate run ` +
        'has seen — and a base branch that cannot be judged is never assumed green (plan ' +
        'Section E item 3). The feature itself passed its own gates.',
      section: [
        SECTION.gateResults,
        renderBaseGateResults(unrunResults(deps.config), {
          branch: base,
          sha: baseSha,
          attempt,
        }),
      ],
    };
  }

  // ==========================================================================
  // TWO `gates_finished` LINES, ONE ITEM, ONE ATTEMPT NUMBER
  // ==========================================================================
  // A diverged close really does run the gates twice, so two lines is the
  // truthful record and collapsing them would hide a whole subprocess run. They
  // are told apart by `commitSha` — and, because a reader should not have to
  // cross-reference SHAs to know which branch they are looking at, by the
  // branch name in `detail`. No field was added to the event: a feature's
  // `attempts` never moves, so `attempt` is `1` on both lines and would stay
  // ambiguous whatever was added next to it, and nothing consumes these events
  // today.
  await deps.events?.emit({
    type: 'gates_finished',
    itemId: item.id,
    attempt,
    green: allGatesPassed(results),
    commitSha: baseSha,
    detail: `base branch ${base}: ${describeGateFailure(results)}`,
  });

  if (!allGatesPassed(results)) {
    return {
      kind: 'blocked',
      detail:
        `**the base branch ${base} is red, and that is not ${item.id}'s doing.** ` +
        `${describeGateFailure(results)} on ${base} at ${baseSha.slice(0, 8)}, which is a commit ` +
        `the feature never touched — its own branch passed every gate at ${featureSha.slice(0, 8)}. ` +
        `Merging into a red branch would record a delivery on top of somebody else's breakage and ` +
        `tag it, so the merge is blocked rather than the feature being blamed. Fix ${base}, then ` +
        `approve ${item.id} to verify both branches again. Rejecting sends the feature back to ` +
        'development, which is not what is wrong here.',
      section: [
        SECTION.gateResults,
        renderBaseGateResults(results, { branch: base, sha: baseSha, attempt }),
      ],
    };
  }

  return { kind: 'ok', baseVerifiedSha: baseSha };
}

/**
 * Every gate `skipped`, for a run that could not happen.
 *
 * `skipped`, never `pass`: `allGatesPassed` asks each gate for a `pass`, so a
 * run that never happened can never be mistaken for a green one.
 */
function unrunResults(config: FactoryConfig): GateResults {
  return emptyResults(config.gates, 'the feature-branch gate run could not be started');
}

/**
 * Park the feature and say why.
 *
 * `rejectTo` is always `in_development`: whatever went wrong, the other answer a
 * human has is "send it back for more work", and `needs_human → in_development`
 * is already in the transition table. `resumeTo` is the caller's, because it is
 * the one thing that differs — a red gate resumes to `awaiting_feature_close` to
 * be verified again, while a failed merge resumes to `done` so that approving
 * re-runs the close.
 */
async function pauseFeature(
  deps: DispatchDeps,
  item: Actionable,
  now: IsoTimestamp,
  reason: PauseReason,
  options: {
    readonly detail: string;
    readonly resumeTo: 'awaiting_feature_close' | 'done';
    readonly section?: readonly [heading: string, markdown: string];
    /** A note already composed by the caller, when it has one. */
    readonly note?: FeatureNote;
    /**
     * Spread over the frontmatter in the same single write as the pause.
     *
     * `verified_sha` and `base_verified_sha` default to `null` here, and that
     * default is the point: a pause means the close did not happen, so whatever
     * the gates last verified is no longer the thing anybody is being asked to
     * approve. Leaving a stale green SHA behind would be evidence for a claim
     * nobody made.
     */
    readonly frontmatter?: object;
  },
): Promise<DispatchOutcome> {
  const paused = pauseItem(
    composeNote({
      note: options.note ?? (item.note as FeatureNote),
      sections: options.section === undefined ? [] : [options.section],
      frontmatter: { verified_sha: null, base_verified_sha: null, ...(options.frontmatter ?? {}) },
    }),
    {
      reason,
      detail: options.detail,
      resumeTo: options.resumeTo,
      rejectTo: 'in_development',
      now,
      actor: 'orchestrator',
      historyNote: `${reason} at feature close`,
    },
  );

  await writeAnyNote(deps.storage, item.path, paused);
  await deps.events?.emit({
    type: 'item_paused',
    itemId: item.id,
    pauseReason: reason,
    detail: options.detail,
    resumeTo: options.resumeTo,
    rejectTo: 'in_development',
  });
  await refreshViews(deps);
  await deps.hooks?.crash?.('after_persist', { itemId: item.id, role: null });

  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: 'needs_human',
    paused: true,
    reason: options.detail,
  };
}

/** The same shape `./dispatch.ts`'s own `idle` produces. */
function idle(item: Actionable, reason: string): DispatchOutcome {
  return {
    itemId: item.id,
    claimed: true,
    ran: null,
    from: item.stage,
    to: null,
    paused: false,
    reason,
  };
}

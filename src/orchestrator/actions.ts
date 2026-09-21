/**
 * `approve`, `reject` and `kill` — the single write path (spec §6, §14).
 *
 * The CLI calls these functions and the M7 dashboard will call the identical
 * ones. That is the whole reason they are functions in the orchestrator rather
 * than logic inside `src/cli/approve.ts`: two implementations of "resolve a
 * paused item" would drift, and the one that drifts is the one nobody is
 * looking at.
 *
 * SPREAD, NEVER REBUILD. Both resolvers extend the existing frontmatter object.
 * A human who annotated their note in Obsidian and then approved it must not
 * lose the annotation to the approval, and `Note<T>` has no type slot that
 * would make a rebuild here a compile error.
 */
import { unlink, writeFile } from 'node:fs/promises';

import { SECTION } from '../agents/context.js';
import type { FactoryConfig } from '../config/schema.js';
import type { PauseReason, WorkItemState } from '../domain/states.js';
import { applyTransition } from '../domain/transitions.js';
import type { AnyNote, FeatureNote, IsoTimestamp } from '../domain/types.js';
import type { Git } from '../git/git.js';
import { featureTagName } from '../git/paths.js';
import { featureBranchFor } from '../git/workspace.js';
import type { EventSink } from '../log/events.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import { clearPause } from './checkpoints.js';
import { closeFeature, describeCloseFailure } from './featureClose.js';
import { composeNote, refreshViews, writeAnyNote } from './noteWrites.js';
import { scanVault } from './scan.js';
import type { VaultScan } from './scan.js';

export class ActionError extends Error {
  readonly itemId: string;

  constructor(itemId: string, message: string) {
    super(message);
    this.name = 'ActionError';
    this.itemId = itemId;
  }
}

export interface ActionContext {
  readonly paths: VaultPaths;
  readonly storage: Storage;
  readonly config: FactoryConfig;
  readonly now: () => IsoTimestamp;
  readonly events?: EventSink;
  /**
   * The target repo (Phase 11).
   *
   * `approve` on a feature at the `final_acceptance` checkpoint is the one
   * action that touches git: it merges the feature branch into the base branch
   * and tags it. Optional because every other action is a note write and because
   * dozens of tests build an `ActionContext` for those — and its absence is a
   * **refusal**, not a silent skip. Approving a feature close without a way to
   * merge would otherwise mark it `done` on a merge that never happened, which
   * is exactly what `featureCloseVerified` exists to stop.
   */
  readonly git?: Git;
}

export interface ActionResult {
  readonly id: string;
  readonly kind: 'feature' | 'ticket';
  readonly from: WorkItemState;
  readonly to: WorkItemState;
  readonly path: string;
}

/**
 * `factory approve <id> ["note"]` — resolve a paused item to its `resume_to`.
 *
 * The human's note goes into `## History` and into `## Notes`. History is the
 * audit trail; `## Notes` is the part the next agent's context actually
 * injects, and an approval that said "yes but keep the API shape" is worth
 * nothing if only the audit trail records it.
 */
export async function approve(
  ctx: ActionContext,
  id: string,
  note?: string,
): Promise<ActionResult> {
  return await resolve(ctx, id, 'approve', note);
}

/** `factory reject <id> "<reason>"` — resolve to `reject_to`, reason recorded. */
export async function reject(
  ctx: ActionContext,
  id: string,
  reason: string,
): Promise<ActionResult> {
  if (reason.trim().length === 0) {
    throw new ActionError(id, 'a rejection needs a reason — it is what the next agent acts on');
  }
  return await resolve(ctx, id, 'reject', reason);
}

async function resolve(
  ctx: ActionContext,
  id: string,
  action: 'approve' | 'reject',
  text?: string,
): Promise<ActionResult> {
  const scan = await scanVault(ctx.storage, ctx.paths);
  const found = findItem(scan, id);

  if (found === null) {
    const parked = parkedIds(scan);
    throw new ActionError(
      id,
      `no feature or ticket with id ${JSON.stringify(id)} in this vault. ` +
        (parked.length === 0
          ? 'Nothing is currently waiting for you.'
          : `Waiting for you: ${parked.join(', ')}.`),
    );
  }

  const front = found.note.frontmatter;
  if (front.status !== 'needs_human') {
    throw new ActionError(
      id,
      `${id} is ${front.status}, not needs_human. There is nothing to ${action} — ` +
        'the factory only pauses for a human at a checkpoint or an escalation.',
    );
  }

  const target = action === 'approve' ? front.resume_to : front.reject_to;

  // ==========================================================================
  // THE ONE APPROVAL THAT DOES SOMETHING BEFORE IT WRITES A NOTE (Phase 11)
  // ==========================================================================
  // Every other resolution is a note write. This one merges the feature branch
  // into the base branch and tags it, and only then may the note say `done` —
  // `featureCloseVerified` refuses the transition without both facts, and
  // nothing else in the system produces them. So the order is forced: do the
  // git work, then transition on what it reported. There is no path here that
  // marks a feature delivered first and merges afterwards.
  //
  // Keyed on `resume_to === 'done'` rather than on `pause_reason`, because the
  // target is what matters: `done` is the only state a feature can be resumed
  // to that requires a base-branch write, and a hand-edited note that asks for
  // it still gets the verified path rather than a shortcut.
  if (action === 'approve' && found.kind === 'feature' && target === 'done') {
    return await approveFeatureClose(ctx, found, text);
  }

  if (target === null || target === undefined) {
    throw new ActionError(
      id,
      `${id} paused with \`pause_reason: ${front.pause_reason ?? 'unspecified'}\` and no ` +
        `${action === 'approve' ? 'resume_to' : 'reject_to'}, so it cannot be ${action}d. ` +
        (action === 'reject'
          ? 'This kind of pause is resolved by fixing what the agent was stuck on and approving.'
          : 'Fix the item by hand and restart the factory.'),
    );
  }

  const now = ctx.now();
  const trimmed = text?.trim() ?? '';
  const heading = action === 'approve' ? 'Approved by a human' : 'Rejected by a human';
  const noteBlock = trimmed.length === 0 ? `**${heading}**` : `**${heading}**\n\n${trimmed}`;

  // ==========================================================================
  // A STANDING APPROVAL DIES WITH THE WORK IT WAS FOR
  // ==========================================================================
  // `awaiting_feature_close` is the one target that keeps it: that is the
  // "go and verify this again" route, and the approval is exactly what is
  // waiting on that verification. Every other target — `in_development` after
  // a reject, back to `refining`, anywhere else — means the feature is being
  // reworked, so an approval for the commit it used to be at must not survive
  // to close a commit nobody has seen. `reject` always lands here, because its
  // target is `reject_to`, which for a feature close is `in_development`.
  const voidsApproval = found.kind === 'feature' && target !== 'awaiting_feature_close';

  const staged = composeNote({
    note: found.note,
    sections: [[SECTION.notes, noteBlock]],
    frontmatter: {
      ...clearPause(found.note.frontmatter),
      ...(voidsApproval ? { approved_sha: null, approved_note: null, approved_tag: null } : {}),
    },
  });

  const next = applyTransition(staged as never, target as never, 'human', {
    now,
    ...(trimmed.length === 0 ? {} : { note: `${action}: ${trimmed}` }),
  }) as AnyNote;

  await writeAnyNote(ctx.storage, found.path, next);
  await ctx.events?.emit({
    type: 'item_transitioned',
    itemId: id,
    from: 'needs_human',
    to: target,
    actor: 'human',
    ...(trimmed.length === 0 ? {} : { note: `${action}: ${trimmed}` }),
  });
  await refreshViews(ctx);

  return { id, kind: found.kind, from: 'needs_human', to: target, path: found.path };
}

/**
 * `factory approve <feature>` at the `final_acceptance` checkpoint (Phase 11).
 *
 * Merge `feature/<slug>` into the effective base branch with `--no-ff`, tag the
 * result `factory/<slug>/<ISO date>`, and set the feature `done`. A conflict
 * escalates and is never retried (spec §10, ADR-004).
 *
 * On any failure the feature is left parked with a `pause_detail` that says what
 * did and did not happen, and the command exits non-zero. It deliberately does
 * **not** return an `ActionResult`: an approval that did not approve anything
 * must not print "Approved FEAT-X: needs_human → done".
 */
async function approveFeatureClose(
  ctx: ActionContext,
  found: FoundItem,
  text?: string,
): Promise<ActionResult> {
  const feature = found.note as FeatureNote;
  const id = feature.frontmatter.id;
  const slug = feature.frontmatter.slug;
  const git = ctx.git;

  if (git === undefined) {
    // Fails toward a stuck feature, which is the whole design of the guard on
    // this transition. Marking it `done` here would record a delivery that is
    // not on the base branch, and `done` is terminal.
    throw new ActionError(
      id,
      `${id} is waiting at final acceptance, and approving it merges its branch into ` +
        `${ctx.config.base_branch} and tags the result. This process has no handle on ` +
        `${ctx.config.target_repo}, so it cannot do either — and it will not mark the feature ` +
        'done on a merge that did not happen. Run `factory approve` from a build that can reach ' +
        'the target repo.',
    );
  }

  const featureBranch = await featureBranchFor(ctx, slug);
  const now = ctx.now();

  // ==========================================================================
  // THE GATE VERDICT GOES STALE, SO IT IS RE-CHECKED HERE
  // ==========================================================================
  // The feature-branch gates ran before the checkpoint; this approval arrives
  // whenever a person got to it. Anything that landed on the feature branch in
  // between was never gated and was never in the summary the human read — and
  // without this check it goes to the base branch on their signature, tagged as
  // a delivery. Probed on real git before the check existed: a failing test
  // committed after the checkpoint reached `main` and was tagged.
  //
  // This is Phase 10's fix one level up. There the window was as long as a test
  // suite; here it is as long as a human's attention span, which is worse.
  //
  // **It refuses rather than re-running the gates.** Refusing fails toward a
  // stuck feature rather than an unverified base branch, and re-running the
  // gates from here would need a gate runner and a worktree provider in the
  // CLI's action context — giving every `approve`/`reject`/`kill` the ability to
  // run subprocesses in the target repo, to do a job the loop already does on
  // its next cycle. The refusal rewrites `resume_to` so approving again sends
  // the feature back to be verified afresh, because a refusal with no way out
  // is its own bug.
  const stale = await staleVerdict(ctx, git, feature, featureBranch);
  if (stale.kind === 'refuse') {
    // Spec §12 wants one line per decision, and refusing to close is one. Its
    // contract fits exactly: nothing was attempted and the base branch was not
    // touched. Without this the attempt exists only in the note, so a log
    // reader sees an approval that simply never happened.
    await ctx.events?.emit({
      type: 'feature_close_refused',
      featureId: id,
      detail: stale.detail,
    });
    await reparkFeature(ctx, found, feature, {
      reason: 'escalation',
      detail: stale.detail,
      resumeTo: 'awaiting_feature_close',
      now,
    });
    throw new ActionError(id, stale.detail);
  }
  if (stale.kind === 'defer') {
    return await recordStandingApproval(ctx, found, feature, stale, text, now);
  }

  const outcome = await closeFeature({
    git,
    config: ctx.config,
    featureId: id,
    featureSlug: slug,
    featureBranch,
    // `paused_at`, not `now`: the summary promised a name derived from the
    // moment the feature was put in front of a human, and a tag that does not
    // match what they were asked to approve is a different delivery record.
    // See `runFeatureClose`, which reads that instant once. Falling back to
    // `now` covers only a hand-edited note with no `paused_at`.
    tagName: featureTagName(slug, feature.frontmatter.paused_at ?? now),
    // The second lock on the base branch. `staleVerdict` above has already
    // asked the same question with a better message and a route back; this is
    // the copy that lives inside the only function that writes the base branch,
    // so a path added later cannot get past it.
    baseVerifiedSha: feature.frontmatter.base_verified_sha,
    // `staleVerdict` compared these moments ago; this is the copy that lives
    // inside the only function that writes the base branch, so the guarantee
    // holds for the dispatcher's path too, where a whole gate run separates the
    // two reads.
    expectedFeatureSha: feature.frontmatter.verified_sha,
    ...(ctx.events === undefined ? {} : { events: ctx.events }),
  });

  if (outcome.kind !== 'closed') {
    const parked = describeCloseFailure(outcome, {
      featureId: id,
      featureBranch,
      baseBranch: ctx.config.base_branch,
    });

    // `resume_to` is usually `done`: fixing the conflict and approving again is
    // the documented route, and it comes straight back here. The exception is
    // an unverified base branch, which no amount of re-approving *here* can
    // clear — that one goes back to the loop. `describeCloseFailure` owns the
    // choice so both close paths make it the same way.
    await reparkFeature(ctx, found, feature, {
      reason: parked.reason,
      detail: parked.detail,
      resumeTo: parked.resumeTo,
      now,
    });

    throw new ActionError(id, parked.detail);
  }

  const trimmed = text?.trim() ?? '';
  const noteBlock =
    `**Approved by a human** — final acceptance.\n\n` +
    `\`${featureBranch}\` merged into \`${ctx.config.base_branch}\` at \`${outcome.sha}\`, ` +
    `tagged \`${outcome.tag}\`.` +
    (trimmed.length === 0 ? '' : `\n\n${trimmed}`);

  const historyNote =
    `final acceptance approved: merged ${outcome.sha.slice(0, 8)} into ${ctx.config.base_branch}, ` +
    `tagged ${outcome.tag}` +
    (trimmed.length === 0 ? '' : ` — ${trimmed}`);

  const staged = composeNote({
    note: feature,
    sections: [[SECTION.notes, noteBlock]],
    frontmatter: { ...clearPause(feature.frontmatter), tag: outcome.tag },
  });

  const next = applyTransition(staged, 'done', 'human', {
    now,
    note: historyNote,
    // Without both of these the guard refuses. See `featureCloseVerified`.
    ctx: { baseMergeClean: true, featureTag: outcome.tag },
  });

  await writeAnyNote(ctx.storage, found.path, next);
  await ctx.events?.emit({
    type: 'item_transitioned',
    itemId: id,
    from: 'needs_human',
    to: 'done',
    actor: 'human',
    note: historyNote,
  });
  await refreshViews(ctx);

  return { id, kind: 'feature', from: 'needs_human', to: 'done', path: found.path };
}

/**
 * Has anything moved since the gates verified it?
 *
 * Two branches are checked, in order: the feature's own, and — in
 * `staleBaseVerdict` — the base branch it is about to be merged into. The two
 * have **different answers on failure**, and that difference is the whole
 * point: a feature branch that moved means the human approved something that
 * is no longer what would land, so their answer is void; a base branch that
 * moved means somebody else committed, which changes nothing about what they
 * were shown, so their answer stands and only its timing has to change.
 *
 * `verified_sha` is recorded in the same write as the checkpoint pause. `null`
 * is a refusal rather than a pass, for the same reason `featureCloseVerified`
 * reads `!== true`: absent evidence is not evidence, and a hand-edited note is a
 * supported way into any state (ADR-001).
 *
 * Note this is **not** the same question as "do the gates still pass". A commit
 * added after the checkpoint might be perfectly green and would still be one no
 * approver ever saw. What is being checked is that the thing approved is the
 * thing that lands.
 */
type ApprovalCheck =
  | { readonly kind: 'ok' }
  /** Nothing is recorded and nothing happens but the refusal. */
  | { readonly kind: 'refuse'; readonly detail: string }
  /**
   * The approval stands, but it cannot be acted on here.
   *
   * What the human judged — the feature commit — is unchanged; what moved is
   * the base branch, which the approval summary never showed them. So the
   * approval is recorded and the feature is handed back to the loop, the only
   * thing that can gate the base branch as it now is.
   */
  | { readonly kind: 'defer'; readonly detail: string; readonly verified: string };

async function staleVerdict(
  ctx: ActionContext,
  git: Git,
  feature: FeatureNote,
  featureBranch: string,
): Promise<ApprovalCheck> {
  const id = feature.frontmatter.id;
  const verified = feature.frontmatter.verified_sha;

  // A `feature_branch` that names the base branch is a misconfigured note, not
  // a stale verdict, and `closeFeature.forbiddenClose` owns that message —
  // which tells the operator to fix the field. Answering here first would
  // replace it with "the branch has moved", which is true and useless. Nothing
  // is merged either way: that refusal fires before any git write.
  if (featureBranch === ctx.config.base_branch) return { kind: 'ok' };

  if (verified === null || verified === undefined || verified.trim() === '') {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: its note records no verified commit, so there is no evidence ` +
        `that anything on ${featureBranch} passed the gates. Nothing was merged and nothing was ` +
        `tagged. Approve again to send the feature back to be verified, which records what is ` +
        'being approved before it asks you again.',
    };
  }

  const tip = await git.revParse(git.repoRoot, featureBranch);
  if (tip === null) {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: ${featureBranch} no longer resolves to a commit, so there is ` +
        `nothing to merge into ${ctx.config.base_branch}. Nothing was merged and nothing was tagged.`,
    };
  }
  if (tip !== verified) {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: ${featureBranch} has moved since its gates ran. The approval you ` +
        `are giving was for ${verified}, and the branch is now at ${tip} — so the commit that ` +
        'would land on ' +
        `${ctx.config.base_branch} is one that has never been gated and was never in the summary ` +
        'you read. Nothing was merged and nothing was tagged.\n\nThis is not a judgement about ' +
        'the new commit; it may well be fine. It has simply never been verified, and a stale ' +
        'green must not do what a red gate is never allowed to do (plan Section E item 3). ' +
        `**Approve again** to send ${id} back to be re-verified: the gates will re-run on ` +
        `${featureBranch} as it now is, and you will be asked again with a fresh summary.`,
    };
  }

  return await staleBaseVerdict(ctx, git, feature, featureBranch, tip);
}

/**
 * Has the **base** branch moved off what the pre-approval gates covered?
 *
 * The same window, one branch over, and the more dangerous one: the feature
 * branch belongs to the factory and only the factory moves it, while the base
 * branch belongs to everybody and moves whenever a colleague pushes. So the
 * verdict on it goes stale more often and for reasons nobody involved in this
 * feature can see.
 *
 * Covered means one of two things, and `baseIsCovered` in `./featureClose.ts`
 * holds the canonical statement of both — this asks the same question earlier so
 * that the operator gets a message written for them and a `resume_to` that leads
 * somewhere. The base tip being an ancestor of the verified commit is the usual
 * answer and needs no gate run at all; otherwise `base_verified_sha` must name
 * this exact commit.
 *
 * Like its sibling it **refuses rather than re-verifying**, for the reason the
 * comment above `staleVerdict` gives: re-running the gates from here would put a
 * gate runner and a worktree provider in the CLI's action context. The refusal
 * rewrites `resume_to` to `awaiting_feature_close`, so approving again hands the
 * feature back to the loop, which re-gates both branches and offers a fresh
 * checkpoint.
 */
async function staleBaseVerdict(
  ctx: ActionContext,
  git: Git,
  feature: FeatureNote,
  featureBranch: string,
  /** The verified feature commit, already confirmed to be the branch tip. */
  verified: string,
): Promise<ApprovalCheck> {
  const id = feature.frontmatter.id;
  const base = ctx.config.base_branch;

  const baseTip = await git.revParse(git.repoRoot, base);
  if (baseTip === null) {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: the base branch ${base} does not resolve to a commit in ` +
        `${git.repoRoot}, so there is nothing to merge into. Nothing was merged and nothing was ` +
        'tagged. This is a problem with the repository or with `base_branch` in config.yml, not ' +
        'with the feature.',
    };
  }

  let contained: boolean;
  try {
    contained = await git.isAncestor(baseTip, verified);
  } catch (error) {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: git could not say whether ${base} (${baseTip.slice(0, 8)}) is ` +
        `already contained in ${featureBranch} (${verified.slice(0, 8)}): ` +
        `${error instanceof Error ? error.message : String(error)}. Without that answer there is ` +
        'no way to tell whether the merge would land code nobody has gated, and a base branch ' +
        'that cannot be judged is never assumed green. Nothing was merged and nothing was tagged.',
    };
  }
  if (contained) return { kind: 'ok' };

  // The feature is already **on** the base branch: a close that merged and then
  // failed at the tag. `git merge --no-ff` of an already-merged branch commits
  // nothing, so re-approving lands no ungated code — and re-approving is the
  // documented fix for that state.
  //
  // Wrapped for the same reason the call above is, and it is not decoration:
  // this function runs inside `factory approve`, so an unhandled
  // `GitCommandError` here leaves the command with a stack trace, the note
  // untouched and nothing in the event log — the one path in the close that
  // could fail without leaving a record.
  try {
    if (await git.isAncestor(verified, baseTip)) return { kind: 'ok' };
  } catch (error) {
    return {
      kind: 'refuse',
      detail:
        `refusing to close ${id}: git could not say whether ${featureBranch} ` +
        `(${verified.slice(0, 8)}) is already merged into ${base}: ` +
        `${error instanceof Error ? error.message : String(error)}. Nothing was merged and ` +
        'nothing was tagged, because a base branch that cannot be judged is never assumed green.',
    };
  }

  const baseVerified = feature.frontmatter.base_verified_sha;
  if (baseVerified !== null && baseVerified !== undefined && baseVerified === baseTip) {
    return { kind: 'ok' };
  }

  // ==========================================================================
  // THE APPROVAL STANDS. ONLY ITS TIMING CHANGES.
  // ==========================================================================
  // This used to refuse, which cost the operator three `factory approve`
  // invocations for one decision — refused, approve to send it back, approve
  // the fresh checkpoint — and asked them to re-answer a question about the
  // feature that nothing about the feature had changed. The approval summary
  // never shows them the base branch at all: what they judged is
  // `verified_sha`, the tickets and the gate results, and every one of those is
  // still exactly what it was.
  //
  // So the approval is recorded against the commit they judged and the feature
  // goes back to `awaiting_feature_close`, which is the only place that can
  // gate the moved base branch. What lands is still fully gated — the loop
  // re-runs both branches' gates before it acts on the standing approval — and
  // if the **feature** commit changes in the meantime the approval is void and
  // a person is asked again.
  return {
    kind: 'defer',
    verified,
    detail:
      `${base} has moved since ${id}'s gates ran, and that is not a judgement about ${id}: what ` +
      `you approved — ${verified} on ${featureBranch} — is unchanged. ${base} is now at ` +
      `${baseTip} and carries commits ${featureBranch} does not, so the gates have to run again ` +
      `on ${base} as it now is before anything is merged, and only the orchestrator can run ` +
      `them.\n\nYour approval has been recorded and ${id} has gone back to be verified. It will ` +
      `close on this approval as soon as ${base} passes, with nothing further from you. If ` +
      `${base} is broken, fixing it is what makes that happen; if ${featureBranch} moves, you ` +
      'will be asked again, because then what you approved would no longer be what lands.',
  };
}

/**
 * Record a standing approval and hand the feature back to the loop.
 *
 * Deliberately **not** an error. The operator did approve, their approval was
 * accepted, and the only thing that has not happened yet is the merge — so this
 * returns an `ActionResult` and `factory approve` exits zero, reporting the
 * transition it actually made rather than a failure it did not have.
 *
 * `paused_at` is cleared with the rest of the pause by `clearPause`, and the
 * feature is re-paused with a fresh `paused_at` when the loop offers the next
 * checkpoint — but it will not offer one, because the standing approval closes
 * it first, and `runFeatureClose` reads the clock once for the tag name exactly
 * as it does on any other close. So the delivery is still dated by when it was
 * verified.
 */
async function recordStandingApproval(
  ctx: ActionContext,
  found: FoundItem,
  feature: FeatureNote,
  deferred: { readonly detail: string; readonly verified: string },
  text: string | undefined,
  now: IsoTimestamp,
): Promise<ActionResult> {
  const id = feature.frontmatter.id;
  const trimmed = text?.trim() ?? '';
  const noteBlock =
    '**Approved by a human** — final acceptance, waiting on the base branch.\n\n' +
    `${deferred.detail}` +
    (trimmed.length === 0 ? '' : `\n\n${trimmed}`);

  const historyNote =
    `final acceptance approved for ${deferred.verified.slice(0, 8)}; held until ` +
    `${ctx.config.base_branch} is verified` +
    (trimmed.length === 0 ? '' : ` — ${trimmed}`);

  const staged = composeNote({
    note: feature,
    sections: [[SECTION.notes, noteBlock]],
    frontmatter: {
      ...clearPause(feature.frontmatter),
      approved_sha: deferred.verified,
      approved_note: trimmed.length === 0 ? null : trimmed,
      // The name the summary promised, derived exactly as `approveFeatureClose`
      // derives it. It has to travel with the approval: `clearPause` nulls
      // `paused_at` on the line above, and a later pause would overwrite it, so
      // re-deriving the name at close time would hand out a different date from
      // the one this person was shown (Phase 11 note 6).
      approved_tag: featureTagName(feature.frontmatter.slug, feature.frontmatter.paused_at ?? now),
    },
  });

  const next = applyTransition(staged, 'awaiting_feature_close', 'human', {
    now,
    note: historyNote,
  });

  await writeAnyNote(ctx.storage, found.path, next);
  await ctx.events?.emit({
    type: 'item_transitioned',
    itemId: id,
    from: 'needs_human',
    to: 'awaiting_feature_close',
    actor: 'human',
    note: historyNote,
  });
  await refreshViews(ctx);

  return {
    id,
    kind: 'feature',
    from: 'needs_human',
    to: 'awaiting_feature_close',
    path: found.path,
  };
}

/**
 * Re-park a feature that is already at `needs_human`, changing only *why*.
 *
 * There is no transition to make — `needs_human → needs_human` is not in the
 * table and `pauseItem` would rightly throw — so the pause fields are written
 * directly. The reason has to reach the note rather than only the terminal: an
 * operator whose `factory approve` failed reads `NEEDS_HUMAN.md` next.
 *
 * **`paused_at` is deliberately left alone.** It is the instant the feature was
 * put in front of a human, which is what the tag name is derived from; moving it
 * on a retry would rename the delivery and break the promise the approval
 * summary made. It also stays truthful about when the wait began.
 */
async function reparkFeature(
  ctx: ActionContext,
  found: FoundItem,
  feature: FeatureNote,
  input: {
    readonly reason: PauseReason;
    readonly detail: string;
    readonly resumeTo: WorkItemState;
    readonly now: IsoTimestamp;
  },
): Promise<void> {
  const reparked = composeNote({
    note: feature,
    sections: [[SECTION.notes, `**Final acceptance could not complete**\n\n${input.detail}`]],
    frontmatter: {
      pause_reason: input.reason,
      pause_detail: input.detail,
      resume_to: input.resumeTo,
      reject_to: 'in_development',
    },
  });

  await writeAnyNote(ctx.storage, found.path, reparked);
  await ctx.events?.emit({
    type: 'item_paused',
    itemId: feature.frontmatter.id,
    pauseReason: input.reason,
    detail: input.detail,
    resumeTo: input.resumeTo,
    rejectTo: 'in_development',
  });
  await refreshViews(ctx);
}

/**
 * `factory kill` — drop `<vault>/.kill`; loop step 1 reads it (spec §6, §9).
 *
 * **It also voids every standing approval**, which is why it takes a `Storage`.
 * The kill switch is the operator's "stop" button, and a standing approval is
 * queued work: a feature whose base branch was being re-verified would
 * otherwise merge and tag itself the moment somebody deleted `.kill`, hours
 * later, with no fresh human decision anywhere near it. Stopping the factory
 * and then finding a delivery waiting for you is precisely the surprise the
 * checkpoint exists to prevent.
 *
 * `storage` is **required**, and that is the point. An optional one would let a
 * caller added later omit it and skip the voiding silently, which is the one
 * way this could stop working without anything going red — the same reason
 * `expectedFeatureSha` and `baseVerifiedSha` are required on `CloseFeatureInput`.
 */
export async function kill(
  paths: VaultPaths,
  now: () => IsoTimestamp,
  storage: Storage,
): Promise<string> {
  await voidStandingApprovals(paths, storage);

  const file = paths.killFile();
  await writeFile(
    file,
    `# Written by \`factory kill\` at ${now()}.\n` +
      '# While this file exists the orchestrator starts no new work. Delete it to resume.\n',
    'utf8',
  );
  return file;
}

/**
 * Clear `approved_sha` on every feature that carries one.
 *
 * Written **before** `.kill` exists rather than after, so that the window in
 * which the loop could still act on an approval this call is about to erase is
 * the ordinary claim race rather than one this function opened. A note that
 * cannot be read or written is skipped: failing the kill switch because one
 * note is malformed would be worse than leaving one approval standing, and
 * plan Section E item 9 says a malformed note never stops the pipeline.
 */
async function voidStandingApprovals(paths: VaultPaths, storage: Storage): Promise<void> {
  let scan: VaultScan;
  try {
    scan = await scanVault(storage, paths);
  } catch {
    return;
  }

  for (const entry of scan.features) {
    const front = entry.note.frontmatter;
    if (front.approved_sha === null || front.approved_sha === undefined) continue;
    try {
      await writeAnyNote(
        storage,
        entry.path,
        composeNote({
          note: entry.note,
          sections: [
            [
              SECTION.notes,
              '**Standing approval cleared by `factory kill`.** The approval given earlier is no ' +
                'longer held: approve again once the factory is running to deliver this feature.',
            ],
          ],
          frontmatter: { approved_sha: null, approved_note: null, approved_tag: null },
        }),
      );
    } catch {
      // See the note above: one unreadable note must not stop the kill switch.
    }
  }
}

/** Remove the kill switch. Not a CLI command yet; used by tests and recovery. */
export async function clearKill(paths: VaultPaths): Promise<void> {
  await unlink(paths.killFile()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
}

interface FoundItem {
  readonly kind: 'feature' | 'ticket';
  readonly path: string;
  readonly note: AnyNote;
}

/** Look an item up by id. Features first: a ticket id always carries its feature's. */
export function findItem(scan: VaultScan, id: string): FoundItem | null {
  for (const entry of scan.features) {
    if (entry.note.frontmatter.id === id) {
      return { kind: 'feature', path: entry.path, note: entry.note };
    }
  }
  for (const entry of scan.tickets) {
    if (entry.note.frontmatter.id === id) {
      return { kind: 'ticket', path: entry.path, note: entry.note };
    }
  }
  return null;
}

function parkedIds(scan: VaultScan): string[] {
  const ids = [
    ...scan.features.filter((e) => e.note.frontmatter.status === 'needs_human'),
    ...scan.tickets.filter((e) => e.note.frontmatter.status === 'needs_human'),
  ].map((entry) => entry.note.frontmatter.id);
  return ids.sort();
}

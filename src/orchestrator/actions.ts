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

  const staged = composeNote({
    note: found.note,
    sections: [[SECTION.notes, noteBlock]],
    frontmatter: clearPause(found.note.frontmatter),
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
  if (stale !== null) {
    // Spec §12 wants one line per decision, and refusing to close is one. Its
    // contract fits exactly: nothing was attempted and the base branch was not
    // touched. Without this the attempt exists only in the note, so a log
    // reader sees an approval that simply never happened.
    await ctx.events?.emit({ type: 'feature_close_refused', featureId: id, detail: stale });
    await reparkFeature(ctx, found, feature, {
      reason: 'escalation',
      detail: stale,
      resumeTo: 'awaiting_feature_close',
      now,
    });
    throw new ActionError(id, stale);
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
    ...(ctx.events === undefined ? {} : { events: ctx.events }),
  });

  if (outcome.kind !== 'closed') {
    const parked = describeCloseFailure(outcome, {
      featureId: id,
      featureBranch,
      baseBranch: ctx.config.base_branch,
    });

    // `resume_to` stays `done` on purpose: fixing the conflict and approving
    // again is the documented route, and it comes straight back here.
    await reparkFeature(ctx, found, feature, {
      reason: parked.reason,
      detail: parked.detail,
      resumeTo: 'done',
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
 * Has the feature branch moved since the gates verified it?
 *
 * Returns the message to park and refuse with, or `null` when what a human is
 * approving is still what would land.
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
async function staleVerdict(
  ctx: ActionContext,
  git: Git,
  feature: FeatureNote,
  featureBranch: string,
): Promise<string | null> {
  const id = feature.frontmatter.id;
  const verified = feature.frontmatter.verified_sha;

  // A `feature_branch` that names the base branch is a misconfigured note, not
  // a stale verdict, and `closeFeature.forbiddenClose` owns that message —
  // which tells the operator to fix the field. Answering here first would
  // replace it with "the branch has moved", which is true and useless. Nothing
  // is merged either way: that refusal fires before any git write.
  if (featureBranch === ctx.config.base_branch) return null;

  if (verified === null || verified === undefined || verified.trim() === '') {
    return (
      `refusing to close ${id}: its note records no verified commit, so there is no evidence ` +
      `that anything on ${featureBranch} passed the gates. Nothing was merged and nothing was ` +
      `tagged. Approve again to send the feature back to be verified, which records what is ` +
      'being approved before it asks you again.'
    );
  }

  const tip = await git.revParse(git.repoRoot, featureBranch);
  if (tip === null) {
    return (
      `refusing to close ${id}: ${featureBranch} no longer resolves to a commit, so there is ` +
      `nothing to merge into ${ctx.config.base_branch}. Nothing was merged and nothing was tagged.`
    );
  }
  if (tip === verified) return null;

  return (
    `refusing to close ${id}: ${featureBranch} has moved since its gates ran. The approval you ` +
    `are giving was for ${verified}, and the branch is now at ${tip} — so the commit that would ` +
    'land on ' +
    `${ctx.config.base_branch} is one that has never been gated and was never in the summary you ` +
    'read. Nothing was merged and nothing was tagged.\n\nThis is not a judgement about the new ' +
    'commit; it may well be fine. It has simply never been verified, and a stale green must not ' +
    'do what a red gate is never allowed to do (plan Section E item 3). **Approve again** to send ' +
    `${id} back to be re-verified: the gates will re-run on ${featureBranch} as it now is, and ` +
    'you will be asked again with a fresh summary.'
  );
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

/** `factory kill` — drop `<vault>/.kill`; loop step 1 reads it (spec §6, §9). */
export async function kill(paths: VaultPaths, now: () => IsoTimestamp): Promise<string> {
  const file = paths.killFile();
  await writeFile(
    file,
    `# Written by \`factory kill\` at ${now()}.\n` +
      '# While this file exists the orchestrator starts no new work. Delete it to resume.\n',
    'utf8',
  );
  return file;
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

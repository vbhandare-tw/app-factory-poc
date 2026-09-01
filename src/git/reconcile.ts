/**
 * Loop step 5 — reconciling worktrees on disk against ticket state (spec §9).
 *
 * ============================================================================
 * THE TWO FAILURES THIS BALANCES, AND WHICH ONE IT PREFERS
 * ============================================================================
 * A **leaked** worktree accumulates silently until some later run fails oddly:
 * disk fills, `git worktree list` grows, and a stale tree gets adopted by a
 * ticket that should have had a fresh one.
 *
 * A **wrongly removed** worktree destroys an agent's uncommitted work. Agents
 * never commit (ADR-003), so *everything a Developer produced lives only in the
 * working tree* until the orchestrator stages it. Removing one mid-flight is
 * not an inconvenience; it is the total loss of the run that produced it.
 *
 * The second is worse, so this errs the other way, in three explicit places:
 *
 * 1. **A worktree is removed only when it can be positively accounted for** —
 *    it sits under this vault's own worktree root, its directory name is a
 *    ticket id the scan actually found, and that ticket is in a state that does
 *    not own a worktree. Anything else (an unknown name, a quarantined note, a
 *    directory a human made) is reported as `worktree_unaccounted` and left
 *    alone. Defaulting to delete would mean a single unparseable ticket note
 *    silently wipes that ticket's working tree.
 * 2. **A dirty worktree is never removed**, whatever its ticket says. It is
 *    reported as `worktree_retained_dirty`. The one exception is a ticket that
 *    is `done`, whose work is already merged (spec §10).
 * 3. **`needs_human` owns its worktree.** A paused ticket is precisely the case
 *    where a human is about to go and look at what the agent left.
 *
 * ============================================================================
 * WHICH STATES OWN A WORKTREE
 * ============================================================================
 * The plan says "not `in_progress`/`qa` → orphan". Taken literally that removes
 * the tree of a ticket sitting at `gates`, `code_review` or `merge` between two
 * cycles — and Phase 9 runs the gates *inside* that tree, so the next cycle
 * would find nothing to test. `WORKTREE_OWNING_STATES` below is therefore the
 * whole mid-flight span. It is a superset of the plan's wording, so both of the
 * plan's required cases still hold exactly: `backlog` is removed, `in_progress`
 * is kept.
 *
 * **Owning is not the same as creating** — see `createsWorktree`. `needs_human`
 * protects a worktree it already has and never causes one to be built, because
 * a ticket paused by a failing `setup_command` would otherwise re-run that
 * command on every single cycle, forever.
 *
 * ============================================================================
 * WHEN THIS IS SAFE TO RUN
 * ============================================================================
 * At startup, and at step 5 of a cycle — both **before** any dispatch. Dispatch
 * is sequential and awaited (see `loop.ts`), and a throwaway worktree is
 * disposed in the `finally` of the run that made it, so no scratch worktree is
 * ever live at the moment this runs. That is what makes it safe for this to
 * sweep leftover scratch worktrees rather than having to tell a live one from a
 * crashed one.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { FactoryConfig } from '../config/schema.js';
import type { TicketState } from '../domain/states.js';
import type { TicketNote } from '../domain/types.js';
import type { EventSink } from '../log/events.js';
import { pauseItem } from '../orchestrator/checkpoints.js';
import { writeAnyNote } from '../orchestrator/dispatch.js';
import { scanVault } from '../orchestrator/scan.js';
import type { VaultScan } from '../orchestrator/scan.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import type { ExecFn } from './exec.js';
import type { Git } from './git.js';
import { featureBranchName, scratchRoot, vaultWorktreeName, worktreeRoot } from './paths.js';
import {
  destroyWorktree,
  ForeignWorktreeError,
  provisionWorktree,
  SetupCommandFailedError,
} from './worktree.js';

/**
 * Ticket states whose worktree must exist. Everything else is an orphan.
 *
 * `needs_human` is here on purpose — see the header note. `backlog`, `ready`
 * and `done` are the states that do not own one.
 */
export const WORKTREE_OWNING_STATES: readonly TicketState[] = [
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
  'needs_human',
];

export function ownsWorktree(state: TicketState): boolean {
  return WORKTREE_OWNING_STATES.includes(state);
}

/**
 * Should this state cause a **missing** worktree to be built?
 *
 * Owning and creating are different questions, and conflating them produced a
 * genuinely bad loop. A ticket paused by a failing `setup_command` is
 * `needs_human` with no worktree — the failed one was removed rather than
 * handed over. If `needs_human` also triggered creation, every cycle would
 * re-run `npm ci`, fail again, and re-pause: up to `setup_timeout` (300s by
 * default) of a sequential cycle burned per poll, forever, hammering the
 * package registry, while the ticket sat exactly where it was.
 *
 * So `needs_human` **protects** a worktree that exists (that is precisely when
 * a human goes to look at what the agent left) and **never creates** one. There
 * is nothing to inspect in a tree that was never built, and the retry belongs
 * to `factory approve`, which sends the ticket back to a state that does create
 * one — a retry a human asked for, once, rather than a loop nobody asked for.
 */
export function createsWorktree(state: TicketState): boolean {
  return ownsWorktree(state) && state !== 'needs_human';
}

export interface ReconcileDeps {
  readonly git: Git;
  readonly storage: Storage;
  readonly paths: VaultPaths;
  readonly config: FactoryConfig;
  readonly events?: EventSink;
  readonly now: () => string;
  /** Reuse the cycle's scan rather than reading every note twice. */
  readonly scan?: VaultScan;
  readonly exec?: ExecFn;
}

export interface ReconcileReport {
  readonly kept: readonly string[];
  readonly created: readonly string[];
  readonly removed: readonly string[];
  /** Left alone because nothing could account for them. Never removed. */
  readonly unaccounted: readonly string[];
  /** Left alone because removing them would have destroyed uncommitted work. */
  readonly retainedDirty: readonly string[];
  readonly scratchRemoved: readonly string[];
  readonly failed: readonly { readonly ticketId: string; readonly reason: string }[];
}

export async function reconcileWorktrees(deps: ReconcileDeps): Promise<ReconcileReport> {
  const scan = deps.scan ?? (await scanVault(deps.storage, deps.paths));

  const kept: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const unaccounted: string[] = [];
  const retainedDirty: string[] = [];
  const scratchRemoved: string[] = [];
  const failed: { ticketId: string; reason: string }[] = [];

  const vaultName = vaultWorktreeName(deps.paths.root);
  const root = worktreeRoot(deps.config.target_repo, vaultName);
  const scratch = path.resolve(scratchRoot(deps.config.target_repo, vaultName));

  const ticketsById = new Map(scan.tickets.map((entry) => [entry.note.frontmatter.id, entry]));

  // --- 1. remove what no live ticket owns ----------------------------------
  for (const worktree of await ourWorktrees(deps, root, scratch)) {
    if (path.resolve(worktree) === scratch || isUnder(worktree, scratch)) {
      // Throwaway worktrees never survive a cycle boundary; anything here is
      // from a run that died. See the header note on why this is safe.
      if (await removeOrDisown(deps, worktree, unaccounted)) {
        scratchRemoved.push(worktree);
        await deps.events?.emit({ type: 'worktree_removed', path: worktree, reason: 'scratch' });
      }
      continue;
    }

    const ticketId = path.basename(worktree);
    const entry = ticketsById.get(ticketId);

    if (entry === undefined) {
      unaccounted.push(worktree);
      await deps.events?.emit({
        type: 'worktree_unaccounted',
        path: worktree,
        detail:
          `no ticket named ${ticketId} was found in the vault scan. Left in place rather than ` +
          'removed: a quarantined or hand-edited note must not cost an agent its working tree.',
      });
      continue;
    }

    const status = entry.note.frontmatter.status;
    if (ownsWorktree(status)) {
      // A live ticket's worktree is step 2's business — it may need recreating
      // rather than merely keeping, and only step 2 knows how to tell. The
      // states that never create one are the exception: step 2 skips them
      // entirely, so nothing else would record that this was kept.
      if (!createsWorktree(status)) kept.push(worktree);
      continue;
    }

    if (status !== 'done' && existsSync(worktree) && (await isDirty(deps.git, worktree))) {
      retainedDirty.push(worktree);
      await deps.events?.emit({
        type: 'worktree_retained_dirty',
        path: worktree,
        itemId: ticketId,
        status,
      });
      continue;
    }

    if (await removeOrDisown(deps, worktree, unaccounted)) {
      removed.push(worktree);
      await deps.events?.emit({
        type: 'worktree_removed',
        path: worktree,
        reason: `ticket ${ticketId} is ${status}`,
      });
    }
  }

  // --- 2. recreate what a live ticket is missing ---------------------------
  for (const entry of scan.tickets) {
    const ticket = entry.note;
    if (!createsWorktree(ticket.frontmatter.status)) continue;

    try {
      const result = await ensureTicketWorktree(deps, scan, ticket, vaultName);
      if (result.reused) {
        kept.push(result.path);
      } else {
        created.push(result.path);
        await deps.events?.emit({
          type: 'worktree_created',
          path: result.path,
          itemId: ticket.frontmatter.id,
          branch: result.branch,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ ticketId: ticket.frontmatter.id, reason });
      await markNeedsHuman(deps, entry, error);
    }
  }

  return { kept, created, removed, unaccounted, retainedDirty, scratchRemoved, failed };
}

/**
 * Remove a worktree unless it turns out to belong to another repository.
 *
 * Returns whether it went. A foreign worktree is reported as unaccounted and
 * left alone rather than throwing, because one stray directory under a shared
 * root must not abort the reconcile pass for every legitimate ticket behind it.
 * With the salted worktree root this should be unreachable; it is here so that
 * "should be unreachable" is a log line rather than a deletion.
 */
async function removeOrDisown(
  deps: ReconcileDeps,
  worktree: string,
  unaccounted: string[],
): Promise<boolean> {
  try {
    await destroyWorktree(deps.git, worktree);
    return true;
  } catch (error) {
    if (!(error instanceof ForeignWorktreeError)) throw error;
    unaccounted.push(worktree);
    await deps.events?.emit({
      type: 'worktree_unaccounted',
      path: worktree,
      detail: error.message,
    });
    return false;
  }
}

async function ensureTicketWorktree(
  deps: ReconcileDeps,
  scan: VaultScan,
  ticket: TicketNote,
  vaultName: string,
): Promise<{ readonly path: string; readonly branch: string; readonly reused: boolean }> {
  const slug = ticket.frontmatter.feature;
  const fromRef = await ensureFeatureBranch(deps, scan, slug);

  const provisioned = await provisionWorktree({
    git: deps.git,
    repoRoot: deps.config.target_repo,
    vaultName,
    ticketId: ticket.frontmatter.id,
    featureSlug: slug,
    title: ticket.frontmatter.title,
    fromRef,
    branch: ticket.frontmatter.branch ?? undefined,
    setupCommand: deps.config.setup_command,
    setupTimeoutMs: deps.config.setup_timeout * 1000,
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
  });

  return { path: provisioned.path, branch: provisioned.branch, reused: provisioned.reused };
}

/**
 * The branch ticket branches are cut from (spec §10).
 *
 * The feature note's `feature_branch` wins when it is set. When it is not, the
 * name is *derived* rather than invented — `featureBranchName` is deterministic
 * — and the branch is created from `config.base_branch` if git does not have
 * it. Nothing before this phase creates a feature branch, and a ticket branch
 * cut from base instead is the one thing requirements §10 forbids outright.
 *
 * Deliberately does **not** write `feature_branch` back to the note: feature
 * branch lifecycle belongs to Phases 10–11, and a reconcile pass that rewrote
 * feature frontmatter would be doing that phase's job with none of its tests.
 */
async function ensureFeatureBranch(
  deps: ReconcileDeps,
  scan: VaultScan,
  slug: string,
): Promise<string> {
  const feature = scan.features.find((entry) => entry.note.frontmatter.slug === slug);
  const branch = feature?.note.frontmatter.feature_branch ?? featureBranchName(slug);

  const created = await deps.git.ensureBranch(branch, deps.config.base_branch);
  if (created) {
    await deps.events?.emit({
      type: 'feature_branch_created',
      slug,
      branch,
      fromRef: deps.config.base_branch,
    });
  }
  return branch;
}

/**
 * A ticket whose worktree could not be provisioned goes to `needs_human`.
 *
 * The plan requires this for a failing `setup_command` specifically, and the
 * reason generalises: whatever went wrong, the alternative is handing an agent
 * a tree that is missing or broken, which produces three attempts' worth of
 * failures that look like the agent's fault and a transcript that explains
 * none of it.
 */
async function markNeedsHuman(
  deps: ReconcileDeps,
  entry: { readonly path: string; readonly note: TicketNote },
  error: unknown,
): Promise<void> {
  const ticket = entry.note;
  if (ticket.frontmatter.status === 'needs_human') return;

  const setup = error instanceof SetupCommandFailedError ? error.outcome : null;
  const detail =
    setup !== null
      ? `The worktree setup command \`${setup.command}\` failed (${
          setup.timedOut ? 'timed out' : `exit ${String(setup.exitCode)}`
        }). No agent has been given this ticket, because a half-installed tree produces test ` +
        `failures that look like the agent's fault.\n\n${setup.output}`
      : `The worktree for this ticket could not be provisioned: ${
          error instanceof Error ? error.message : String(error)
        }`;

  const paused = pauseItem(ticket, {
    reason: 'escalation',
    detail,
    // Approving retries provisioning from the same state; there is no upstream
    // role to send it back to, because nothing an agent did caused this.
    resumeTo: ticket.frontmatter.status,
    rejectTo: null,
    now: deps.now(),
    actor: 'orchestrator',
    historyNote: 'worktree provisioning failed',
  });

  await writeAnyNote(deps.storage, entry.path, paused);
  await deps.events?.emit({
    type: 'item_paused',
    itemId: ticket.frontmatter.id,
    pauseReason: 'escalation',
    detail,
    resumeTo: ticket.frontmatter.status,
    rejectTo: null,
  });
}

/**
 * Every directory git currently registers as a worktree under **our** root.
 *
 * Two sources, deliberately unioned. `git worktree list` is authoritative for
 * anything git knows about, including entries whose directory has been deleted.
 * A directory listing catches the reverse: a directory left behind after a
 * `git worktree prune`, which git has forgotten and which would otherwise sit
 * there forever.
 */
async function ourWorktrees(
  deps: ReconcileDeps,
  root: string,
  scratch: string,
): Promise<string[]> {
  const found = new Set<string>();
  const resolvedRoot = path.resolve(root);
  const resolvedScratch = path.resolve(scratch);

  for (const info of await deps.git.listWorktrees()) {
    if (info.isMain) continue;
    if (isUnder(info.path, resolvedRoot)) found.add(info.path);
  }

  for (const entry of await listDirs(resolvedRoot)) {
    const full = path.join(resolvedRoot, entry);
    if (path.resolve(full) === resolvedScratch) {
      for (const inner of await listDirs(full)) found.add(path.join(full, inner));
      continue;
    }
    found.add(full);
  }

  return [...found].sort();
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isUnder(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`);
}

/**
 * Does this worktree hold work that removal would destroy?
 *
 * `git status --porcelain` respects `.gitignore`, so a `node_modules` the setup
 * command installed does not count — only real changes do. A worktree git can
 * no longer read at all is treated as **dirty**, i.e. not removable by this
 * pass, because "I could not tell" must not resolve to "delete it".
 */
async function isDirty(git: Git, worktreePath: string): Promise<boolean> {
  try {
    return (await git.status(worktreePath)).trim() !== '';
  } catch {
    return true;
  }
}

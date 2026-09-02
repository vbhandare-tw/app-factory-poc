/**
 * The `WorkspaceProvider` Phase 7a left a seam for — where an agent's child
 * process actually runs (spec §4.3).
 *
 * ============================================================================
 * WHY THIS FILE IS THE WHOLE POINT OF PHASE 8
 * ============================================================================
 * The OS sandbox confines an agent's writes to its **working directory**
 * (ADR-003, spec §4.2). So the working directory is not a convenience — it *is*
 * the fence. With no provider, `resolveWorkspace` fell back to
 * `config.target_repo`, which drew the kernel's write region around the
 * operator's own checkout with nothing but the tool list in between; ADR-003
 * exists to record that the tool list is not a filesystem boundary. That is why
 * `factory start` refuses to build a real runner without one of these.
 *
 * ============================================================================
 * ONE ROW PER ROLE, FROM SPEC §4.3
 * ============================================================================
 * | role            | workspace                          | survives the run? |
 * |-----------------|------------------------------------|-------------------|
 * | `pm`            | throwaway scratch **directory**    | no                |
 * | `tl_plan`, `dl` | throwaway worktree at base branch  | no                |
 * | `code_reviewer` | throwaway worktree at ticket branch| no                |
 * | `developer`     | the ticket's own worktree          | yes               |
 * | `qa`            | the ticket's own worktree          | yes               |
 *
 * **Throwaway means force-removed, not merely unwritten.** That is resolution
 * A4: rather than trusting a deny-all `Edit(//**)` glob whose syntax is one
 * slip from matching nothing, a read-only role gets a real worktree, the kernel
 * confines it there, and the directory is destroyed when the run ends. Whatever
 * it wrote is gone. Nothing depends on getting a permission string right.
 *
 * The `pm` gets a plain directory rather than a worktree because it has **no
 * tools at all** (spec §4.3) — text in, structured text out. A checkout would
 * be a repo it cannot read with a `.git` it must not write.
 *
 * ============================================================================
 * SETUP RUNS ONLY WHERE SOMETHING CAN RUN
 * ============================================================================
 * `config.setup_command` costs real time on every run. It is skipped for the
 * roles whose tool list cannot execute anything (`pm`, `tl_plan`, `dl` — Read,
 * Grep, Glob) and applied to the ones that can (`developer`, `qa`,
 * `code_reviewer` — all carry Bash), because those are exactly the roles whose
 * first act is `npm test`.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { PROFILES } from '../agents/profiles.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Role } from '../domain/roles.js';
import type { FeatureNote, TicketNote } from '../domain/types.js';
import type { EventSink } from '../log/events.js';
import type {
  FeatureVerifyRequest,
  FeatureWorkspaceProvider,
  Workspace,
  WorkspaceProvider,
  WorkspaceRequest,
} from '../orchestrator/dispatch.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import type { ExecFn } from './exec.js';
import { ShellGit } from './git.js';
import type { Git } from './git.js';
import {
  featureBranchName,
  scratchWorktreePath,
  ticketBranchName,
  vaultWorktreeName,
} from './paths.js';
import { provisionScratchWorktree, provisionWorktree } from './worktree.js';

export interface WorkspaceProviderDeps {
  readonly config: FactoryConfig;
  readonly paths: VaultPaths;
  readonly storage: Storage;
  readonly git?: Git;
  readonly events?: EventSink;
  readonly exec?: ExecFn;
}

/** Does this role's tool list contain anything that can execute? */
export function roleNeedsDependencies(role: Role): boolean {
  return PROFILES[role].tools.includes('Bash');
}

export function createWorkspaceProvider(deps: WorkspaceProviderDeps): WorkspaceProvider {
  const git = deps.git ?? new ShellGit({ repoRoot: deps.config.target_repo });
  const vaultName = vaultWorktreeName(deps.paths.root);

  return async (request: WorkspaceRequest): Promise<Workspace> => {
    const kind = PROFILES[request.role].cwd;
    switch (kind) {
      case 'scratch':
        return await scratchDirectory(deps, vaultName, request);
      case 'repo_scratch_worktree':
        return await throwawayWorktree(deps, git, vaultName, request);
      case 'ticket_worktree':
        return await ticketWorkspace(deps, git, vaultName, request);
      default: {
        // A new `ProfileCwdKind` is a compile error here rather than a role
        // that silently ends up running in the operator's own checkout.
        const unreachable: never = kind;
        throw new Error(`no workspace rule for cwd kind ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

/**
 * Where the **post-merge** gates run (Phase 10).
 *
 * A throwaway worktree detached at the merge commit, with `setup_command` run in
 * it, force-removed afterwards. Not the main checkout, and the difference is the
 * whole point: Phase 9 established that the gates verify the *commit* rather
 * than whatever happens to be sitting in a working tree, and the operator's main
 * checkout is the least controlled tree in the system — a stale `node_modules`,
 * build output from another branch, a half-finished install. A green gate run
 * there would be a statement about the operator's machine, not about the merge.
 *
 * Detached rather than on the branch, for the reason `provisionScratchWorktree`
 * gives: git refuses to check out a branch twice, and the main checkout is on
 * the feature branch at exactly this moment because that is where the merge left
 * it.
 *
 * Setup always runs. This is not a role and has no tool list to consult — the
 * gates are the thing that executes, and they are precisely what needs the
 * dependencies (resolution A3).
 */
export function createFeatureWorkspaceProvider(
  deps: WorkspaceProviderDeps,
): FeatureWorkspaceProvider {
  const git = deps.git ?? new ShellGit({ repoRoot: deps.config.target_repo });
  const vaultName = vaultWorktreeName(deps.paths.root);

  return async (request: FeatureVerifyRequest): Promise<Workspace> => {
    const scratch = await provisionScratchWorktree({
      git,
      repoRoot: deps.config.target_repo,
      vaultName,
      label: `${request.ticketId}-merge-verify`.replace(/[^A-Za-z0-9._-]+/g, '-'),
      ref: request.ref,
      setupCommand: deps.config.setup_command,
      setupTimeoutMs: deps.config.setup_timeout * 1000,
      runSetup: true,
      ...(deps.exec === undefined ? {} : { exec: deps.exec }),
    });

    await deps.events?.emit({
      type: 'worktree_created',
      path: scratch.path,
      itemId: request.ticketId,
      branch: `${request.branch} at ${request.ref} (detached, throwaway)`,
    });

    return {
      cwd: scratch.path,
      dispose: async (): Promise<void> => {
        await scratch.dispose();
        await deps.events?.emit({
          type: 'worktree_removed',
          path: scratch.path,
          reason: `post-merge gate run for ${request.ticketId}`,
        });
      },
    };
  };
}

/** A plain directory, outside the repo and outside any temp path. */
async function scratchDirectory(
  deps: WorkspaceProviderDeps,
  vaultName: string,
  request: WorkspaceRequest,
): Promise<Workspace> {
  const dir = scratchWorktreePath(deps.config.target_repo, vaultName, label(request));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  return {
    cwd: dir,
    dispose: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function throwawayWorktree(
  deps: WorkspaceProviderDeps,
  git: Git,
  vaultName: string,
  request: WorkspaceRequest,
): Promise<Workspace> {
  const ref = await refFor(deps, request);
  const scratch = await provisionScratchWorktree({
    git,
    repoRoot: deps.config.target_repo,
    vaultName,
    label: label(request),
    ref,
    setupCommand: deps.config.setup_command,
    setupTimeoutMs: deps.config.setup_timeout * 1000,
    runSetup: roleNeedsDependencies(request.role),
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
  });

  await deps.events?.emit({
    type: 'worktree_created',
    path: scratch.path,
    itemId: request.itemId,
    branch: `${ref} (detached, throwaway)`,
  });

  return {
    cwd: scratch.path,
    dispose: async (): Promise<void> => {
      await scratch.dispose();
      await deps.events?.emit({
        type: 'worktree_removed',
        path: scratch.path,
        reason: `throwaway worktree for ${request.role} on ${request.itemId}`,
      });
    },
  };
}

/**
 * The ticket's own worktree — the one place an agent's writes are meant to
 * survive.
 *
 * Reconciliation (loop step 5) has normally already created it, and this call
 * then adopts it. Provisioning here as well is not belt and braces for its own
 * sake: the transition into `in_progress` happens *during* a dispatch, after
 * step 5 has run, so the very first Developer run of a ticket reaches this
 * before any reconcile pass has seen the ticket as live.
 *
 * No `dispose`. Removing this at the end of a run would destroy the work — the
 * agent never commits (ADR-003), so the working tree is the only copy until the
 * orchestrator stages it.
 */
async function ticketWorkspace(
  deps: WorkspaceProviderDeps,
  git: Git,
  vaultName: string,
  request: WorkspaceRequest,
): Promise<Workspace> {
  const ticket = await readTicket(deps, request);
  const slug = ticket?.frontmatter.feature ?? request.featureSlug;
  const featureBranch = await featureBranchFor(deps, slug);
  await git.ensureBranch(featureBranch, deps.config.base_branch);

  const provisioned = await provisionWorktree({
    git,
    repoRoot: deps.config.target_repo,
    vaultName,
    ticketId: request.ticketId ?? request.itemId,
    featureSlug: slug,
    title: ticket?.frontmatter.title ?? request.itemId,
    fromRef: featureBranch,
    branch: ticket?.frontmatter.branch ?? undefined,
    setupCommand: deps.config.setup_command,
    setupTimeoutMs: deps.config.setup_timeout * 1000,
    runSetup: roleNeedsDependencies(request.role),
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
  });

  if (!provisioned.reused) {
    await deps.events?.emit({
      type: 'worktree_created',
      path: provisioned.path,
      itemId: request.itemId,
      branch: provisioned.branch,
    });
  }

  return { cwd: provisioned.path };
}

/**
 * What a throwaway worktree is checked out at (spec §4.3).
 *
 * `code_reviewer` reviews a ticket's change, so it gets the ticket branch;
 * `tl_plan` and `dl` are planning against the feature as a whole, so they get
 * the feature branch — falling back to base when it does not exist yet, which
 * is the normal case for a feature that has not reached `ticketing`.
 */
async function refFor(deps: WorkspaceProviderDeps, request: WorkspaceRequest): Promise<string> {
  if (request.role === 'code_reviewer') {
    const ticket = await readTicket(deps, request);
    if (ticket !== undefined) {
      return (
        ticket.frontmatter.branch ??
        ticketBranchName(ticket.frontmatter.feature, ticket.frontmatter.id, ticket.frontmatter.title)
      );
    }
  }

  const feature = await featureBranchFor(deps, request.featureSlug);
  const git = deps.git ?? new ShellGit({ repoRoot: deps.config.target_repo });
  return (await git.branchExists(feature)) ? feature : deps.config.base_branch;
}

/**
 * The feature's branch: what its note says, or the derived name.
 *
 * `reconcile.ts` reads `feature_branch` from the note and this used to derive
 * the name unconditionally. Nothing writes that field yet, so the two agreed by
 * accident — but the vault is the documented human editing surface (ADR-001),
 * and a hand-set value would have had reconciliation cutting ticket branches
 * from one ref while the workspace provider checked out another. Both read the
 * note now.
 *
 * Exported for Phase 9's dispatch, which needs the same answer to compute the
 * reviewer's `git diff <feature-branch>...<ticket-branch>`. Shared rather than
 * re-derived: a dispatcher that resolved the feature branch differently would
 * diff a ticket against a branch it was never cut from, and the reviewer would
 * silently be shown the wrong change.
 */
export async function featureBranchFor(
  deps: Pick<WorkspaceProviderDeps, 'config' | 'paths' | 'storage'>,
  slug: string,
): Promise<string> {
  try {
    const note = await deps.storage.readNote<FeatureNote['frontmatter']>(
      deps.paths.featureNote(slug),
    );
    if (note.frontmatter.type === 'feature' && note.frontmatter.feature_branch !== null) {
      return note.frontmatter.feature_branch;
    }
  } catch {
    // No feature note, or one that will not parse. The derived name is the
    // same answer reconciliation reaches, so the two still agree.
  }
  return featureBranchName(slug);
}

async function readTicket(
  deps: WorkspaceProviderDeps,
  request: WorkspaceRequest,
): Promise<TicketNote | undefined> {
  const id = request.ticketId ?? request.itemId;
  try {
    const note = await deps.storage.readNote<TicketNote['frontmatter']>(
      deps.paths.ticketPath(request.featureSlug, id),
    );
    return note.frontmatter.type === 'ticket' ? note : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory name a throwaway workspace gets.
 *
 * Stable per (item, role) rather than random: a stable name means a run killed
 * mid-flight leaves **one** directory that the next run overwrites and
 * reconciliation sweeps, instead of an unbounded pile of unique ones nobody
 * ever looks at.
 */
function label(request: WorkspaceRequest): string {
  return `${request.itemId}-${request.role}`.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Exported for the tests that assert the layout without provisioning anything. */
export function workspaceLabel(request: WorkspaceRequest): string {
  return label(request);
}

/** Exported so a caller can predict where a throwaway workspace will appear. */
export function throwawayPathFor(
  config: FactoryConfig,
  paths: VaultPaths,
  request: WorkspaceRequest,
): string {
  return path.resolve(
    scratchWorktreePath(config.target_repo, vaultWorktreeName(paths.root), label(request)),
  );
}

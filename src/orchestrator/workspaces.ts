/**
 * Where an agent's child process runs, and what a dispatcher is capable of
 * because of it.
 *
 * Split out of `./dispatch.ts`. The types these functions take and return live
 * in `./dispatchTypes.js` — `DispatchDeps` names a `WorkspaceProvider` and
 * `resolveWorkspace` takes a `DispatchDeps`, so declaring them here and the
 * bundle there would make a cycle between the two files.
 */
import type { Actionable, DispatchDeps, Workspace, WorkspaceRequest } from './dispatchTypes.js';

/** Can this dispatcher run the Phase 9 ticket loop at all? */
export function canRunTicketLoop(deps: Pick<DispatchDeps, 'git' | 'gates'>): boolean {
  return deps.git !== undefined && deps.gates !== undefined;
}

/**
 * Can this dispatcher merge a ticket (Phase 10)?
 *
 * The ticket loop plus somewhere to verify the merge. The extra requirement is
 * not bureaucracy: without a `featureWorkspace` the post-merge gates would have
 * to run in the operator's main checkout, and a gate verdict from there is a
 * statement about the operator's machine rather than about the merge (see
 * `createFeatureWorkspaceProvider`). A merge that cannot be verified must not
 * happen, so a dispatcher without one leaves the ticket at `merge` — visibly
 * waiting — rather than landing an unverified commit on a shared branch.
 *
 * It is also what keeps the Phase 9 suite honest: those tests grant `git` and
 * `gates` in order to exercise the dev loop, and they end at `merge` on purpose.
 * A merge that fired on that capability alone would silently move a shared
 * branch inside tests written to prove the dev loop never touches one.
 */
export function canMergeTickets(
  deps: Pick<DispatchDeps, 'git' | 'gates' | 'featureWorkspace'>,
): boolean {
  return canRunTicketLoop(deps) && deps.featureWorkspace !== undefined;
}

/**
 * Where the child process runs.
 *
 * Phase 8 provides real worktrees. Until then a repo-touching role falls back
 * to the target repo itself — which is safe **only** because `factory start`
 * refuses to construct a non-mock runner while no `WorkspaceProvider` exists
 * (see `src/cli/start.ts`). The fallback exists so a `MockRunner` cycle has a
 * cwd to put in its spec; the mock never spawns anything, so it never uses it.
 *
 * The refusal deliberately lives at the CLI rather than here. A per-dispatch
 * refusal would fail halfway through a feature, after the PM run has already
 * been paid for.
 */
export async function resolveWorkspace(
  deps: DispatchDeps,
  request: WorkspaceRequest,
): Promise<Workspace> {
  if (deps.workspace !== undefined) return await deps.workspace(request);
  return { cwd: deps.config.target_repo };
}

/**
 * The ticket's own worktree, for a step that has no role of its own.
 *
 * Asked for as the `developer` because that is the role whose profile says
 * `ticket_worktree` and whose provisioning installs dependencies — which the
 * gates need. `provisionWorktree` reuses a worktree that already exists, so this
 * is idempotent and does not re-run `setup_command` on the normal path.
 */
export async function ticketWorkspace(deps: DispatchDeps, item: Actionable): Promise<Workspace> {
  return await resolveWorkspace(deps, {
    role: 'developer',
    itemId: item.id,
    featureSlug: item.slug,
    ticketId: item.id,
  });
}

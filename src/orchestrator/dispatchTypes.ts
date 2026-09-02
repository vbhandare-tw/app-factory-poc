/**
 * The interfaces `./dispatch.ts` and the modules split out of it share.
 *
 * Types only, and that is the whole point. `./roleEffects.ts`,
 * `./attemptPolicy.ts` and `./workspaces.ts` all need `DispatchDeps`,
 * `Actionable`, `RoleEffect` and friends, and `./dispatch.ts` needs the
 * functions in those modules — so leaving the declarations next to their
 * consumers makes a cycle. A cycle here would typecheck and pass the suite,
 * because TypeScript resolves it at compile time and Vitest's loader tolerates
 * it, and then fail under the import order the `factory` binary actually uses.
 * One module that imports none of them is the fix that cannot rot.
 */
import type { FactoryConfig } from '../config/schema.js';
import type { Actor, Role } from '../domain/roles.js';
import type { TicketState, WorkItemState } from '../domain/states.js';
import type { AnyNote, IsoTimestamp, TicketNote } from '../domain/types.js';
import type { GateRunner } from '../gates/runner.js';
import type { Git } from '../git/git.js';
import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import type { AgentFailure, Runner } from '../runner/types.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import type { AttemptFailure } from './attempts.js';
import type { CheckpointName } from './checkpoints.js';
import type { WorktreeSnapshot } from './commit.js';

/**
 * Points at which a test may kill the process.
 *
 * A test seam, exactly like `atomicWrite`'s `beforeRename`. Production never
 * passes `hooks`. `test/helpers/crashDuringDispatch.mjs` uses it to SIGKILL
 * itself, because an in-process thrown error runs our own `finally` blocks —
 * including the one that releases the claim — which is precisely the code a
 * real crash does not run.
 */
export type DispatchCrashPoint =
  /** The agent returned; nothing has been written yet. */
  | 'after_run'
  /**
   * The non-note files are written — `tech-plan.md`, the DL's ticket notes —
   * but the item note still says the role has not run. The one genuinely
   * multi-file window in a dispatch, and the reason ticket ids are allocated
   * from the payload rather than from what is already on disk.
   */
  | 'after_side_files'
  /** The note has been written and the views regenerated; the claim is still held. */
  | 'after_persist';

export interface DispatchHooks {
  readonly crash?: (
    point: DispatchCrashPoint,
    info: { readonly itemId: string; readonly role: Role | null },
  ) => void | Promise<void>;
}

/** Where an agent's child process runs. Phase 8 replaces the default. */
export interface Workspace {
  readonly cwd: string;
  readonly dispose?: () => Promise<void>;
}

export interface WorkspaceRequest {
  readonly role: Role;
  readonly itemId: string;
  readonly featureSlug: string;
  readonly ticketId?: string;
}

export type WorkspaceProvider = (request: WorkspaceRequest) => Promise<Workspace>;

/**
 * Where the **post-merge** gates run (Phase 10).
 *
 * Separate from `WorkspaceProvider` because it answers a different question. A
 * `WorkspaceRequest` is "where does this role's agent run for this item"; this
 * is "give me a tree that is exactly this commit of the feature branch, with
 * dependencies, so the gates can be believed". No role is involved and no agent
 * ever sees it.
 *
 * It is also the capability that makes a merge possible at all — see
 * `canMergeTickets`. A dispatcher that can commit and gate a ticket still cannot
 * verify a merge, because it has nowhere to verify it.
 */
export interface FeatureVerifyRequest {
  readonly featureSlug: string;
  /** The feature branch the merge landed on. */
  readonly branch: string;
  /** The merge commit. What the tree must actually be. */
  readonly ref: string;
  /** The ticket that merged, for the log and the directory name. */
  readonly ticketId: string;
  /**
   * Overrides the throwaway worktree's directory name (Phase 11).
   *
   * The feature close asks the same provider the same question — "give me a
   * tree that is exactly this commit, with dependencies" — but it is not a
   * ticket merge, and a directory called `FEAT-X-merge-verify` sitting there
   * before anything has been merged is a name that misleads whoever finds it.
   */
  readonly label?: string;
}

export type FeatureWorkspaceProvider = (request: FeatureVerifyRequest) => Promise<Workspace>;

export interface DispatchDeps {
  readonly paths: VaultPaths;
  readonly config: FactoryConfig;
  readonly storage: Storage;
  readonly runner: Runner;
  readonly events?: EventSink;
  readonly runs?: RunSink;
  readonly now: () => IsoTimestamp;
  readonly ownerId: string;
  readonly hooks?: DispatchHooks;
  readonly workspace?: WorkspaceProvider;
  /**
   * The target repo, unsandboxed (Phase 9). Needed to commit the Developer's
   * work and to compute the reviewer's diff.
   *
   * Optional for the same reason `Orchestrator.reconcile` is: every Phase 7a and
   * 7b test drives paper work through `MockRunner` against a vault whose tickets
   * never leave `backlog`, and a dispatcher that reached for git there would
   * make those tests slower and their failures harder to read. Without it, the
   * ticket states past `ready` are simply not dispatched — see `handleTicket`.
   */
  readonly git?: Git;
  /** The deterministic gates (spec §8.2). Paired with `git`; see above. */
  readonly gates?: GateRunner;
  /**
   * Where the post-merge gates run (Phase 10). Its presence is what makes a
   * ticket at `merge` actionable at all — see `canMergeTickets`.
   */
  readonly featureWorkspace?: FeatureWorkspaceProvider;
  /** Per-process monotonic counter feeding `runId` (spec §3.6). */
  readonly nextCounter: () => number;
  readonly signal?: AbortSignal;
}

export interface Actionable {
  readonly kind: 'feature' | 'ticket';
  readonly id: string;
  readonly path: string;
  /** The owning feature's slug — the same value for a feature and its tickets. */
  readonly slug: string;
  readonly note: AnyNote;
  readonly stage: WorkItemState;
}

export interface DispatchOutcome {
  readonly itemId: string;
  readonly claimed: boolean;
  /** The role that ran, or `null` for an orchestrator-only transition. */
  readonly ran: Role | null;
  readonly from: WorkItemState;
  readonly to: WorkItemState | null;
  readonly paused: boolean;
  readonly failure?: AgentFailure;
  readonly error?: string;
  readonly reason?: string;
}

export interface DispatchContext {
  /** Every ticket in the vault, for the dependency guards. */
  readonly tickets: readonly TicketNote[];
}

/**
 * A bounce: the role succeeded, and what it produced sends the ticket back.
 *
 * A red gate, a `request_changes`, a QA `fail`, a Developer that changed
 * nothing. None of these is an agent *failure* — the run worked, the payload
 * validated — and none of them may advance the ticket either. They cost an
 * attempt (spec §9.1) and they carry their evidence into the note in the same
 * single write as the move back.
 */
export interface BounceSpec {
  readonly failure: AttemptFailure;
  /** Where the ticket goes. Equal to its current state means "retry in place". */
  readonly to: TicketState;
  readonly actor: Actor;
  /** Goes into `pause_detail` if this is the attempt that exhausts the budget. */
  readonly detail: string;
}

export interface RoleEffect {
  readonly sections: ReadonlyArray<readonly [heading: string, markdown: string]>;
  readonly to: WorkItemState;
  readonly actor: Actor;
  readonly historyNote?: string;
  readonly checkpoint?: CheckpointName;
  /** Spread over the frontmatter in the same single write as the transition. */
  readonly frontmatter?: object;
  /** Set instead of advancing. See `BounceSpec`. */
  readonly bounce?: BounceSpec;
  /** Non-note files, written before the note. Full overwrites only. */
  readonly files?: ReadonlyArray<readonly [file: string, contents: string]>;
  readonly tickets?: readonly TicketNote[];
  /**
   * Ticket files to delete before the new ones are written. See
   * `reconcileTickets` — a breakdown replaces the previous breakdown whole,
   * and leaving the previous one's extras on disk would strand schedulable
   * work with dependencies pointing at tickets nobody plans to build.
   */
  readonly removeTicketFiles?: readonly string[];
  /**
   * The effect cannot be applied and the item must go to a human instead.
   * Used when replacing a breakdown would destroy work that has already
   * started, which is a judgement no orchestrator should make on its own.
   */
  readonly refuse?: string;
}

/** What a ticket-level role needs from the run that produced its payload. */
export interface RunContext {
  readonly snapshot?: WorktreeSnapshot;
  readonly workspaceCwd?: string;
  readonly attempt?: number;
}

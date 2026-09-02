/**
 * What every command needs from the outside world, in one injectable bag.
 *
 * `cwd`, `env` and the output sinks are parameters rather than direct reads of
 * `process` so that a test can run a command in-process against a scratch
 * directory and a scratch factory home. That matters most for the registry: its
 * real location is `~/.app-factory/projects.yml`, and a test that reached it would
 * pass while quietly rewriting the operator's own file.
 */
import { ProjectRegistry } from '../config/registry.js';
import type { FactoryConfig } from '../config/schema.js';
import type { ReconcileReport } from '../git/reconcile.js';
import { createFeatureWorkspaceProvider, createWorkspaceProvider } from '../git/workspace.js';
import { reconcileWorktrees } from '../git/reconcile.js';
import { ShellGit } from '../git/git.js';
import type { Git } from '../git/git.js';
import type { EventSink } from '../log/events.js';
import type { FeatureWorkspaceProvider, WorkspaceProvider } from '../orchestrator/dispatchTypes.js';
import type { Runner } from '../runner/types.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';

export interface CliDeps {
  /** The directory the command was invoked from. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProjectRegistry;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** ISO timestamp source, injected so recorded times are deterministic in tests. */
  readonly now: () => string;
  /**
   * Overrides which `Runner` `factory start` uses (Phase 7a).
   *
   * Optional, and absent in production — `config.runner` decides there. It
   * exists so a test can inject a Runner that throws if it is ever constructed
   * or called, which is the only way to assert that a failed startup validation
   * **spawns no agent process** rather than merely exiting non-zero afterwards.
   */
  readonly runner?: Runner | ((config: FactoryConfig) => Runner);
  /**
   * Where an agent's child process runs (Phase 8).
   *
   * `factory start` **refuses to start a real runner without one** — see the
   * header of `start.ts`. It is a dependency rather than a config flag because
   * it is a capability the build either has or does not, and an operator cannot
   * fix its absence by editing a file.
   *
   * A ready-made provider. Overrides `workspaceFactory` below, and is how a
   * test substitutes a directory of its own for a real worktree.
   */
  readonly workspace?: WorkspaceProvider;
  /**
   * Builds the real thing, once the vault and its config are known (Phase 8).
   *
   * Split from `workspace` because a provider needs `config.target_repo` and
   * the vault paths, neither of which exists when `CliDeps` is constructed —
   * `runStart` resolves the vault, loads the config, validates it, and only
   * then can a provider be made at all.
   *
   * Supplied by `processDeps`, i.e. by the real binary. A `CliDeps` built by
   * hand does **not** get one, and that is deliberate: `factory start`'s
   * refusal then still fires for a deps bag with no way to make worktrees,
   * which is the property Phase 7a's tests pin down. Production coverage of the
   * real factory is `test/integration/worktree-workspace.test.ts`, which passes
   * it explicitly and drives a real `factory start` against a real repo.
   */
  readonly workspaceFactory?: WorkspaceFactory;
}

/**
 * Everything a build that can do git worktrees provides.
 *
 * One object rather than two seams because the two halves must share a git
 * handle and a worktree root. A `WorkspaceProvider` that put worktrees
 * somewhere a `reconcileWorktrees` did not look would leak every worktree it
 * ever made, and nothing would go red.
 */
export interface WorktreeCapability {
  readonly workspace: WorkspaceProvider;
  /** Loop step 5. */
  readonly reconcile: () => Promise<ReconcileReport>;
  /**
   * The same git handle, exposed (Phase 9).
   *
   * The dispatcher commits the Developer's work and diffs the ticket branch for
   * the reviewer, and it must do both against the repository the worktrees were
   * cut from. Building a second `ShellGit` here would work today and would be a
   * quiet trap the moment anything about the handle is configured.
   */
  readonly git: Git;
  /**
   * Where the post-merge gates run (Phase 10).
   *
   * Part of the same object for the same reason as `git`: it cuts a worktree
   * from the same repository, under the same salted root, and a second handle
   * would put it somewhere reconciliation does not look.
   */
  readonly featureWorkspace: FeatureWorkspaceProvider;
}

/** What `runStart` calls once it knows which vault it is running. */
export type WorkspaceFactory = (input: {
  readonly config: FactoryConfig;
  readonly paths: VaultPaths;
  readonly storage: Storage;
  readonly now: () => string;
  readonly events?: EventSink;
}) => WorktreeCapability;

/** A failure with a message meant for a human, not a stack trace. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** The real process. The only place the operator's actual home is consulted. */
export function processDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const env = overrides.env ?? process.env;
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env,
    registry: overrides.registry ?? ProjectRegistry.fromEnv(env),
    out: overrides.out ?? ((line: string): void => console.log(line)),
    err: overrides.err ?? ((line: string): void => console.error(line)),
    now: overrides.now ?? ((): string => new Date().toISOString()),
    workspaceFactory: overrides.workspaceFactory ?? realWorktrees,
  };
}

/**
 * The real capability: one `ShellGit` on the target repo, shared by the
 * provider and by reconciliation so both agree on where worktrees live.
 */
export const realWorktrees: WorkspaceFactory = (input) => {
  const git = new ShellGit({ repoRoot: input.config.target_repo });
  return {
    git,
    workspace: createWorkspaceProvider({
      config: input.config,
      paths: input.paths,
      storage: input.storage,
      git,
      ...(input.events === undefined ? {} : { events: input.events }),
    }),
    featureWorkspace: createFeatureWorkspaceProvider({
      config: input.config,
      paths: input.paths,
      storage: input.storage,
      git,
      ...(input.events === undefined ? {} : { events: input.events }),
    }),
    reconcile: () =>
      reconcileWorktrees({
        git,
        config: input.config,
        paths: input.paths,
        storage: input.storage,
        now: input.now,
        ...(input.events === undefined ? {} : { events: input.events }),
      }),
  };
};

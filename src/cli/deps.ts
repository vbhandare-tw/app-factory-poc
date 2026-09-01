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
import type { WorkspaceProvider } from '../orchestrator/dispatch.js';
import type { Runner } from '../runner/types.js';

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
   * Absent until `src/git/worktree.ts` exists. `factory start` **refuses to
   * start a real runner without one** — see the header of `start.ts`. It is a
   * dependency rather than a config flag because it is a capability the build
   * either has or does not, and an operator cannot fix its absence by editing
   * a file.
   */
  readonly workspace?: WorkspaceProvider;
}

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
  };
}

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

export interface CliDeps {
  /** The directory the command was invoked from. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly registry: ProjectRegistry;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** ISO timestamp source, injected so recorded times are deterministic in tests. */
  readonly now: () => string;
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

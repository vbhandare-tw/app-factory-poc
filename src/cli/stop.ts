/**
 * `factory stop [project]` (spec §6) — signal the running instance via its lock
 * file PID, and let it drain.
 *
 * `SIGTERM`, not `SIGKILL`. `factory start` installs a handler that finishes
 * the run in flight and then exits, releasing the instance lock and leaving
 * every claim released. A hard kill would leave a claimed item and a stale lock
 * behind — recoverable, because that is exactly what crash recovery is for, but
 * there is no reason to make a routine stop look like a crash.
 */
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import { readInstanceLock } from '../orchestrator/lock.js';
import { VaultPaths } from '../vault/paths.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';

export interface StopOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  /** Injected so the test does not have to signal a real process. */
  readonly signalProcess?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
}

export interface StopResult {
  readonly vault: string;
  readonly pid: number;
}

export async function runStop(options: StopOptions, deps: CliDeps): Promise<StopResult> {
  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );
  await loadConfig(resolution.vaultPath);

  const paths = new VaultPaths(resolution.vaultPath);
  const lock = await readInstanceLock(paths.instanceLock());

  if (!lock.present) {
    throw new CliError(`nothing is running on ${resolution.vaultPath} — there is no instance lock`);
  }
  if (lock.record === null) {
    throw new CliError(
      `${paths.instanceLock()} is not readable JSON, so there is no pid to signal. The next ` +
        '`factory start` will treat it as stale and reclaim it.',
    );
  }

  const send = options.signalProcess ?? ((pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal);
  });

  try {
    send(lock.record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      throw new CliError(
        `the lock on ${resolution.vaultPath} names pid ${lock.record.pid}, which is not running. ` +
          'It crashed; the next `factory start` will reclaim the lock.',
      );
    }
    throw error;
  }

  deps.out(`Sent SIGTERM to pid ${lock.record.pid}; it will finish the run in flight and exit.`);
  return { vault: resolution.vaultPath, pid: lock.record.pid };
}

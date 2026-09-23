/**
 * `factory start [project] [--vault <p>] [--once]` (spec §6).
 *
 * Startup validation, then the instance lock, then the poll loop in the
 * foreground.
 */
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import { startOrchestrator, StartupRefused } from '../orchestrator/host.js';
import type { OrchestratorHandle } from '../orchestrator/host.js';
import { InstanceLockHeldError } from '../orchestrator/lock.js';
import type { CycleReport } from '../orchestrator/loop.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';

export interface StartOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  /** Run exactly one cycle and exit. Useful for a cron-driven factory and tests. */
  readonly once?: boolean | undefined;
  /** Stop after this many cycles. Tests use it; there is no CLI flag. */
  readonly maxCycles?: number | undefined;
}

export interface StartResult {
  readonly vault: string;
  readonly cycles: readonly CycleReport[];
}

export async function runStart(options: StartOptions, deps: CliDeps): Promise<StartResult> {
  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );

  const config = await loadConfig(resolution.vaultPath);

  let handle: OrchestratorHandle;
  try {
    handle = await startOrchestrator({ vaultPath: resolution.vaultPath, config, deps });
  } catch (error) {
    if (error instanceof StartupRefused || error instanceof InstanceLockHeldError) {
      throw new CliError(error.message);
    }
    throw error;
  }

  const drain = (): void => {
    deps.err('Stopping — finishing the run in flight, then exiting.');
    handle.requestStop();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);

  deps.out(`factory started on ${resolution.vaultPath} (pid ${process.pid})`);

  try {
    const maxCycles = options.once === true ? 1 : options.maxCycles;
    const cycles = await handle.run({
      ...(maxCycles === undefined ? {} : { maxCycles }),
    });
    return { vault: resolution.vaultPath, cycles };
  } finally {
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    await handle.shutdown();
    deps.out('factory stopped');
  }
}

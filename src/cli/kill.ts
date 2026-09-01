/**
 * `factory kill` (spec §6) — create `<vault>/.kill`.
 *
 * It is a *stop starting new work* switch, not a stop-now switch. Loop step 1
 * checks the file before every claim, so whatever agent is already running
 * finishes and its result is written; nothing new is picked up. That ordering
 * is what makes the kill switch safe to press mid-run — no half-applied
 * transition, no orphaned claim.
 */
import { kill } from '../orchestrator/actions.js';
import type { CliDeps } from './deps.js';
import { openVault } from './resolve.js';

export interface KillOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
}

export async function runKill(options: KillOptions, deps: CliDeps): Promise<string> {
  const scope = await openVault(options, deps);
  const file = await kill(scope.paths, deps.now);

  deps.out(`Kill switch set: ${file}`);
  deps.out('The orchestrator will finish the run in flight and then start nothing new.');
  deps.out('Delete that file to resume.');
  return file;
}

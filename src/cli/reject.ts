/**
 * `factory reject <id> "<reason>"` (spec §6).
 *
 * The reason is mandatory, and `actions.ts` refuses a blank one. It is not
 * bookkeeping: the reason is appended to `## Notes`, which is part of the note
 * body the next agent's context injects, so a rejection with no reason sends
 * the work back to an agent that has no idea what to change.
 */
import { reject } from '../orchestrator/actions.js';
import type { ActionResult } from '../orchestrator/actions.js';
import type { CliDeps } from './deps.js';
import { openVault } from './resolve.js';

export interface RejectOptions {
  readonly id: string;
  readonly reason: string;
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
}

export async function runReject(options: RejectOptions, deps: CliDeps): Promise<ActionResult> {
  const scope = await openVault(options, deps);
  const result = await reject(scope.actionContext, options.id, options.reason);

  deps.out(`Rejected ${result.id}: ${result.from} → ${result.to}`);
  return result;
}

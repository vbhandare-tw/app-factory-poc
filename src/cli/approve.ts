/**
 * `factory approve <id> ["note"]` (spec §6).
 *
 * A thin shell over `src/orchestrator/actions.ts`. The dashboard (M7) will call
 * the same function, which is what spec §14 means by a single write path — this
 * file owns argument handling and output, and nothing else.
 */
import { approve } from '../orchestrator/actions.js';
import type { ActionResult } from '../orchestrator/actions.js';
import type { CliDeps } from './deps.js';
import { openVault } from './resolve.js';

export interface ApproveOptions {
  readonly id: string;
  readonly note?: string | undefined;
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
}

export async function runApprove(options: ApproveOptions, deps: CliDeps): Promise<ActionResult> {
  const scope = await openVault(options, deps);
  const result = await approve(scope.actionContext, options.id, options.note);

  deps.out(`Approved ${result.id}: ${result.from} → ${result.to}`);

  // A feature that goes back to `awaiting_feature_close` on an *approval* is
  // the standing-approval path: the person said yes, and the base branch moved
  // before the merge could happen. The transition line alone reads like the
  // approval was ignored, so say what is actually waiting on what — the note
  // carries the full explanation, but nobody reads a note to find out whether
  // the command they just ran worked.
  if (result.kind === 'feature' && result.to === 'awaiting_feature_close') {
    deps.out('The base branch moved, so the gates have to run on it before the merge.');
    deps.out('Your approval is held: this feature will close on it, with nothing further from you.');
  }

  return result;
}

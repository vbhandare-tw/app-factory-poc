/**
 * `approve`, `reject` and `kill` — the single write path (spec §6, §14).
 *
 * The CLI calls these functions and the M7 dashboard will call the identical
 * ones. That is the whole reason they are functions in the orchestrator rather
 * than logic inside `src/cli/approve.ts`: two implementations of "resolve a
 * paused item" would drift, and the one that drifts is the one nobody is
 * looking at.
 *
 * SPREAD, NEVER REBUILD. Both resolvers extend the existing frontmatter object.
 * A human who annotated their note in Obsidian and then approved it must not
 * lose the annotation to the approval, and `Note<T>` has no type slot that
 * would make a rebuild here a compile error.
 */
import { unlink, writeFile } from 'node:fs/promises';

import { SECTION } from '../agents/context.js';
import type { FactoryConfig } from '../config/schema.js';
import type { WorkItemState } from '../domain/states.js';
import { applyTransition } from '../domain/transitions.js';
import type { AnyNote, IsoTimestamp } from '../domain/types.js';
import type { EventSink } from '../log/events.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import { clearPause } from './checkpoints.js';
import { composeNote, refreshViews, writeAnyNote } from './dispatch.js';
import { scanVault } from './scan.js';
import type { VaultScan } from './scan.js';

export class ActionError extends Error {
  readonly itemId: string;

  constructor(itemId: string, message: string) {
    super(message);
    this.name = 'ActionError';
    this.itemId = itemId;
  }
}

export interface ActionContext {
  readonly paths: VaultPaths;
  readonly storage: Storage;
  readonly config: FactoryConfig;
  readonly now: () => IsoTimestamp;
  readonly events?: EventSink;
}

export interface ActionResult {
  readonly id: string;
  readonly kind: 'feature' | 'ticket';
  readonly from: WorkItemState;
  readonly to: WorkItemState;
  readonly path: string;
}

/**
 * `factory approve <id> ["note"]` — resolve a paused item to its `resume_to`.
 *
 * The human's note goes into `## History` and into `## Notes`. History is the
 * audit trail; `## Notes` is the part the next agent's context actually
 * injects, and an approval that said "yes but keep the API shape" is worth
 * nothing if only the audit trail records it.
 */
export async function approve(
  ctx: ActionContext,
  id: string,
  note?: string,
): Promise<ActionResult> {
  return await resolve(ctx, id, 'approve', note);
}

/** `factory reject <id> "<reason>"` — resolve to `reject_to`, reason recorded. */
export async function reject(
  ctx: ActionContext,
  id: string,
  reason: string,
): Promise<ActionResult> {
  if (reason.trim().length === 0) {
    throw new ActionError(id, 'a rejection needs a reason — it is what the next agent acts on');
  }
  return await resolve(ctx, id, 'reject', reason);
}

async function resolve(
  ctx: ActionContext,
  id: string,
  action: 'approve' | 'reject',
  text?: string,
): Promise<ActionResult> {
  const scan = await scanVault(ctx.storage, ctx.paths);
  const found = findItem(scan, id);

  if (found === null) {
    const parked = parkedIds(scan);
    throw new ActionError(
      id,
      `no feature or ticket with id ${JSON.stringify(id)} in this vault. ` +
        (parked.length === 0
          ? 'Nothing is currently waiting for you.'
          : `Waiting for you: ${parked.join(', ')}.`),
    );
  }

  const front = found.note.frontmatter;
  if (front.status !== 'needs_human') {
    throw new ActionError(
      id,
      `${id} is ${front.status}, not needs_human. There is nothing to ${action} — ` +
        'the factory only pauses for a human at a checkpoint or an escalation.',
    );
  }

  const target = action === 'approve' ? front.resume_to : front.reject_to;
  if (target === null || target === undefined) {
    throw new ActionError(
      id,
      `${id} paused with \`pause_reason: ${front.pause_reason ?? 'unspecified'}\` and no ` +
        `${action === 'approve' ? 'resume_to' : 'reject_to'}, so it cannot be ${action}d. ` +
        (action === 'reject'
          ? 'This kind of pause is resolved by fixing what the agent was stuck on and approving.'
          : 'Fix the item by hand and restart the factory.'),
    );
  }

  const now = ctx.now();
  const trimmed = text?.trim() ?? '';
  const heading = action === 'approve' ? 'Approved by a human' : 'Rejected by a human';
  const noteBlock = trimmed.length === 0 ? `**${heading}**` : `**${heading}**\n\n${trimmed}`;

  const staged = composeNote({
    note: found.note,
    sections: [[SECTION.notes, noteBlock]],
    frontmatter: clearPause(found.note.frontmatter),
  });

  const next = applyTransition(staged as never, target as never, 'human', {
    now,
    ...(trimmed.length === 0 ? {} : { note: `${action}: ${trimmed}` }),
  }) as AnyNote;

  await writeAnyNote(ctx.storage, found.path, next);
  await ctx.events?.emit({
    type: 'item_transitioned',
    itemId: id,
    from: 'needs_human',
    to: target,
    actor: 'human',
    ...(trimmed.length === 0 ? {} : { note: `${action}: ${trimmed}` }),
  });
  await refreshViews(ctx);

  return { id, kind: found.kind, from: 'needs_human', to: target, path: found.path };
}

/** `factory kill` — drop `<vault>/.kill`; loop step 1 reads it (spec §6, §9). */
export async function kill(paths: VaultPaths, now: () => IsoTimestamp): Promise<string> {
  const file = paths.killFile();
  await writeFile(
    file,
    `# Written by \`factory kill\` at ${now()}.\n` +
      '# While this file exists the orchestrator starts no new work. Delete it to resume.\n',
    'utf8',
  );
  return file;
}

/** Remove the kill switch. Not a CLI command yet; used by tests and recovery. */
export async function clearKill(paths: VaultPaths): Promise<void> {
  await unlink(paths.killFile()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
}

interface FoundItem {
  readonly kind: 'feature' | 'ticket';
  readonly path: string;
  readonly note: AnyNote;
}

/** Look an item up by id. Features first: a ticket id always carries its feature's. */
export function findItem(scan: VaultScan, id: string): FoundItem | null {
  for (const entry of scan.features) {
    if (entry.note.frontmatter.id === id) {
      return { kind: 'feature', path: entry.path, note: entry.note };
    }
  }
  for (const entry of scan.tickets) {
    if (entry.note.frontmatter.id === id) {
      return { kind: 'ticket', path: entry.path, note: entry.note };
    }
  }
  return null;
}

function parkedIds(scan: VaultScan): string[] {
  const ids = [
    ...scan.features.filter((e) => e.note.frontmatter.status === 'needs_human'),
    ...scan.tickets.filter((e) => e.note.frontmatter.status === 'needs_human'),
  ].map((entry) => entry.note.frontmatter.id);
  return ids.sort();
}

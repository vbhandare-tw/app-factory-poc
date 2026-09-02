/**
 * Composing a note update and writing it — the one-atomic-write layer.
 *
 * Split out of `./dispatch.ts` because `./attemptPolicy.ts` writes notes too: a
 * bounce and an exhausted attempt budget both compose, transition and persist,
 * and leaving these here rather than in `./dispatch.ts` is what keeps the
 * import graph pointing one way. See `./dispatch.ts`'s header for why every
 * update is composed in memory and written once.
 */
import type { Actor, Role } from '../domain/roles.js';
import type { WorkItemState } from '../domain/states.js';
import { applyTransition } from '../domain/transitions.js';
import type { TransitionContext } from '../domain/transitions.js';
import type { AnyNote, IsoTimestamp } from '../domain/types.js';
import type { Storage } from '../vault/storage.js';
import { appendToSection } from '../vault/storage.js';
import type { Actionable, DispatchDeps } from './dispatchTypes.js';
import { scanVault } from './scan.js';
import { regenerateViews } from './views.js';

// ---------------------------------------------------------------------------
// Composing a note update.
// ---------------------------------------------------------------------------

export interface ComposeInput<N extends AnyNote> {
  readonly note: N;
  /** Appended in order, each under its `SECTION_ORDER` heading. */
  readonly sections?: ReadonlyArray<readonly [heading: string, markdown: string]>;
  /** Spread over the existing frontmatter. Never a rebuild. */
  readonly frontmatter?: object;
}

/** Apply body-section appends and frontmatter updates, purely. */
export function composeNote<N extends AnyNote>(input: ComposeInput<N>): N {
  let body = input.note.body;
  for (const [heading, markdown] of input.sections ?? []) {
    if (markdown.trim().length === 0) continue;
    body = appendToSection(body, heading, markdown);
  }

  return {
    ...input.note,
    frontmatter: { ...input.note.frontmatter, ...(input.frontmatter ?? {}) },
    body,
  };
}

// ---------------------------------------------------------------------------
// Persisting.
// ---------------------------------------------------------------------------

/** `applyTransition` without the overload gymnastics at every call site. */
export function transition<N extends AnyNote>(
  note: N,
  to: WorkItemState,
  actor: Actor,
  now: IsoTimestamp,
  ctx: TransitionContext,
  historyNote?: string,
): N {
  return applyTransition(note as never, to as never, actor, {
    now,
    ctx,
    ...(historyNote === undefined ? {} : { note: historyNote }),
  }) as N;
}

export async function persist(
  deps: DispatchDeps,
  item: Actionable,
  next: AnyNote,
  to: WorkItemState,
  actor: Actor,
  _now: IsoTimestamp,
  role: Role | null = null,
  historyNote?: string,
): Promise<void> {
  // The one write. See the header note.
  await writeAnyNote(deps.storage, item.path, next);
  await deps.events?.emit({
    type: 'item_transitioned',
    itemId: item.id,
    from: item.stage,
    to,
    actor,
    ...(historyNote === undefined ? {} : { note: historyNote }),
  });
  await refreshViews(deps);
  await deps.hooks?.crash?.('after_persist', { itemId: item.id, role });
}

/**
 * `Storage.writeNote` for a note whose kind is only known as `AnyNote`.
 *
 * The generic would otherwise resolve against the first member of the union and
 * refuse a ticket. Widening `T` to the union of both frontmatter types is safe
 * because `Note<T>` is read-only in `T`.
 */
export async function writeAnyNote(
  storage: Storage,
  file: string,
  note: AnyNote,
): Promise<void> {
  await storage.writeNote<AnyNote['frontmatter']>(file, note);
}

/** Loop step 10's "regenerate `index.md`", plus `NEEDS_HUMAN.md` (plan Phase 7a). */
export async function refreshViews(deps: Pick<DispatchDeps, 'storage' | 'paths'>): Promise<void> {
  const scan = await scanVault(deps.storage, deps.paths);
  await regenerateViews(deps.paths, scan);
}

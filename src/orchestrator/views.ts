/**
 * The two generated documents at the vault root: `index.md` and
 * `NEEDS_HUMAN.md` (loop step 10, plan Phase 7a).
 *
 * Both are rebuilt from a `VaultScan` rather than from `Storage.listFeatures()`.
 * That is not a style choice: `listFeatures` throws on the first unparseable
 * note, so regenerating the index straight after a cycle that quarantined a
 * malformed ticket would throw — and the pipeline would stop for exactly the
 * reason plan Section E item 9 says it must not. The scan already tolerates bad
 * notes, so the views inherit that tolerance for free.
 *
 * Both writers are atomic and both builders are pure, so regenerating twice
 * from an unchanged vault writes identical bytes and puts no diff in the git
 * history.
 */
import path from 'node:path';

import { atomicWrite } from '../vault/atomic.js';
import { buildIndex } from '../vault/index-md.js';
import type { IndexEntry } from '../vault/index-md.js';
import { buildNeedsHuman } from '../vault/needs-human.js';
import type { NeedsHumanItem } from '../vault/needs-human.js';
import type { VaultPaths } from '../vault/paths.js';
import type { VaultScan } from './scan.js';

export interface RegeneratedViews {
  readonly index: string;
  readonly needsHuman: string;
  /** Ids of everything currently parked, in the order the file lists them. */
  readonly needsHumanIds: readonly string[];
}

/** Rebuild both documents from a scan and write them. */
export async function regenerateViews(
  paths: VaultPaths,
  scan: VaultScan,
): Promise<RegeneratedViews> {
  const entries: IndexEntry[] = scan.features.map((feature) => ({
    feature: feature.note,
    tickets: (scan.ticketsBySlug.get(feature.note.frontmatter.slug) ?? []).map(
      (entry) => entry.note,
    ),
  }));

  const parked = collectNeedsHuman(paths, scan);

  const index = buildIndex(entries);
  const needsHuman = buildNeedsHuman(parked);

  await atomicWrite(paths.indexFile(), index);
  await atomicWrite(paths.needsHumanFile(), needsHuman);

  return {
    index,
    needsHuman,
    needsHumanIds: [...parked].map((item) => item.id).sort(),
  };
}

/** Every feature and ticket currently sitting in `needs_human`. */
export function collectNeedsHuman(paths: VaultPaths, scan: VaultScan): NeedsHumanItem[] {
  const items: NeedsHumanItem[] = [];

  for (const feature of scan.features) {
    const front = feature.note.frontmatter;
    if (front.status !== 'needs_human') continue;
    items.push({
      id: front.id,
      title: front.title,
      kind: 'feature',
      path: relative(paths, feature.path),
      pause_reason: front.pause_reason ?? null,
      pause_detail: front.pause_detail ?? null,
      resume_to: front.resume_to ?? null,
      reject_to: front.reject_to ?? null,
      paused_at: front.paused_at ?? null,
    });
  }

  for (const ticket of scan.tickets) {
    const front = ticket.note.frontmatter;
    if (front.status !== 'needs_human') continue;
    items.push({
      id: front.id,
      title: front.title,
      kind: 'ticket',
      path: relative(paths, ticket.path),
      pause_reason: front.pause_reason ?? null,
      pause_detail: front.pause_detail ?? null,
      resume_to: front.resume_to ?? null,
      reject_to: front.reject_to ?? null,
      paused_at: front.paused_at ?? null,
    });
  }

  return items;
}

/** Vault-relative, POSIX-separated, so the markdown link works in Obsidian. */
function relative(paths: VaultPaths, file: string): string {
  return path.relative(paths.root, file).split(path.sep).join('/');
}

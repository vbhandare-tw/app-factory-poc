/**
 * Loop step 3 (spec §9): read every feature and ticket note.
 *
 * **A malformed note is quarantined, never fatal** — plan Section E item 9 and
 * spec §9 both say so, and it is the one rule in this file worth stating twice.
 * The vault is a human-editable surface (ADR-001); somebody will eventually
 * save a note with a broken YAML value in it, and a factory that stops
 * completely because of one file is a factory nobody trusts to leave running.
 *
 * That is why this module does not use `MarkdownStorage.listFeatures()`. That
 * method parses the whole directory and throws on the first bad note, so one
 * unparseable file would take the entire scan — and therefore the entire cycle
 * — with it. Here each file is read through the same `Storage` seam but
 * individually, and a failure produces an entry in `quarantined` rather than an
 * exception.
 *
 * Beyond "does it parse", the frontmatter is checked for the fields the loop
 * actually reads: a note whose `status` is a word the state machine has never
 * heard of is just as unusable as one that will not parse, and treating it as a
 * work item would mean a transition lookup against a state that does not exist.
 *
 * This module **reports nothing**. It returns what it found and lets the caller
 * decide what to log, because a cycle re-scans several times and a scan that
 * emitted its own events would put one line per re-scan in the log for a single
 * bad file — and then keep doing it every cycle, forever. `Orchestrator`
 * emits `note_malformed` once per file per reason instead.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isFeatureState, isTicketState } from '../domain/states.js';
import type { FeatureNote, TicketNote } from '../domain/types.js';
import { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';

/** A note that parsed and looked like a work item, plus where it lives. */
export interface ScannedNote<N> {
  readonly path: string;
  readonly note: N;
}

export interface QuarantinedNote {
  readonly path: string;
  readonly reason: string;
}

export interface VaultScan {
  readonly features: readonly ScannedNote<FeatureNote>[];
  /** Keyed by feature slug. A feature with no tickets has an empty array. */
  readonly ticketsBySlug: ReadonlyMap<string, readonly ScannedNote<TicketNote>[]>;
  readonly tickets: readonly ScannedNote<TicketNote>[];
  readonly quarantined: readonly QuarantinedNote[];
}

export async function scanVault(storage: Storage, paths: VaultPaths): Promise<VaultScan> {
  const features: ScannedNote<FeatureNote>[] = [];
  const tickets: ScannedNote<TicketNote>[] = [];
  const ticketsBySlug = new Map<string, ScannedNote<TicketNote>[]>();
  const quarantined: QuarantinedNote[] = [];

  const quarantine = (file: string, reason: string): void => {
    quarantined.push({ path: file, reason });
  };

  for (const slug of await featureSlugs(paths)) {
    if (!VaultPaths.isSafeSegment(slug)) {
      quarantine(
        path.join(paths.featuresDir(), slug),
        `feature directory name ${JSON.stringify(slug)} is not a usable slug`,
      );
      continue;
    }

    const featureFile = paths.featureNote(slug);
    const feature = await readWorkItem<FeatureNote>(storage, featureFile);

    if (feature.kind === 'missing') {
      // A directory with no `feature.md` is not an error to report every cycle;
      // `factory feature add` creates both together, so this is somebody's
      // half-made directory or a leftover. Skipping it is enough.
      continue;
    }
    if (feature.kind === 'error') {
      quarantine(featureFile, feature.reason);
      continue;
    }

    const problem = featureProblem(feature.note, slug);
    if (problem !== null) {
      quarantine(featureFile, problem);
      continue;
    }

    features.push({ path: featureFile, note: feature.note });

    const owned: ScannedNote<TicketNote>[] = [];
    for (const ticketFile of await ticketFiles(paths, slug)) {
      const ticket = await readWorkItem<TicketNote>(storage, ticketFile);
      if (ticket.kind === 'missing') continue;
      if (ticket.kind === 'error') {
        quarantine(ticketFile, ticket.reason);
        continue;
      }

      const ticketIssue = ticketProblem(ticket.note, slug);
      if (ticketIssue !== null) {
        quarantine(ticketFile, ticketIssue);
        continue;
      }

      const entry = { path: ticketFile, note: ticket.note };
      owned.push(entry);
      tickets.push(entry);
    }

    owned.sort((a, b) => (a.note.frontmatter.id < b.note.frontmatter.id ? -1 : 1));
    ticketsBySlug.set(slug, owned);
  }

  features.sort((a, b) => (a.note.frontmatter.slug < b.note.frontmatter.slug ? -1 : 1));
  tickets.sort((a, b) => (a.note.frontmatter.id < b.note.frontmatter.id ? -1 : 1));

  return { features, ticketsBySlug, tickets, quarantined };
}

type ReadResult<N> =
  | { readonly kind: 'ok'; readonly note: N }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly reason: string };

async function readWorkItem<N>(storage: Storage, file: string): Promise<ReadResult<N>> {
  try {
    return { kind: 'ok', note: await storage.readNote<N>(file) as N };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What is wrong with this feature note, or `null`.
 *
 * `slug` mismatch is checked because every path the orchestrator builds for
 * this feature comes from `frontmatter.slug`, not from the directory it was
 * found in. If they disagree, a write aimed at this note lands somewhere else.
 */
function featureProblem(note: FeatureNote, slug: string): string | null {
  const front = note.frontmatter as Partial<FeatureNote['frontmatter']>;

  if (front.type !== 'feature') {
    return `expected \`type: feature\`, found ${JSON.stringify(front.type ?? null)}`;
  }
  if (typeof front.id !== 'string' || front.id.length === 0) {
    return 'frontmatter has no `id`';
  }
  if (front.slug !== slug) {
    return `frontmatter slug ${JSON.stringify(front.slug ?? null)} does not match its directory ${JSON.stringify(slug)}`;
  }
  if (!isFeatureState(front.status)) {
    return `\`status: ${JSON.stringify(front.status ?? null)}\` is not a feature state`;
  }
  return null;
}

function ticketProblem(note: TicketNote, slug: string): string | null {
  const front = note.frontmatter as Partial<TicketNote['frontmatter']>;

  if (front.type !== 'ticket') {
    return `expected \`type: ticket\`, found ${JSON.stringify(front.type ?? null)}`;
  }
  if (typeof front.id !== 'string' || front.id.length === 0) {
    return 'frontmatter has no `id`';
  }
  if (front.feature !== slug) {
    return `frontmatter feature ${JSON.stringify(front.feature ?? null)} does not match its directory ${JSON.stringify(slug)}`;
  }
  if (!isTicketState(front.status)) {
    return `\`status: ${JSON.stringify(front.status ?? null)}\` is not a ticket state`;
  }
  if (!Array.isArray(front.depends_on) || front.depends_on.some((id) => typeof id !== 'string')) {
    return '`depends_on` must be a list of ticket ids';
  }
  return null;
}

async function featureSlugs(paths: VaultPaths): Promise<string[]> {
  try {
    const entries = await readdir(paths.featuresDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function ticketFiles(paths: VaultPaths, slug: string): Promise<string[]> {
  const directory = paths.ticketsDir(slug);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

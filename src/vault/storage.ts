/**
 * The `Storage` seam (spec §7.1) and its only M1–M3 implementation.
 *
 * ADR-001 keeps state in markdown so a human can read and fix it; this
 * interface is the promise that SQLite can take over later with markdown as a
 * generated view. ADR-002 makes the orchestrator the only caller: nothing here
 * is ever handed to an agent.
 */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { findHeading, scanMarkdown, sectionEnd } from '../domain/markdown.js';
import { appendHistoryLine } from '../domain/transitions.js';
import type { FeatureNote, HistoryLine, Note, TicketNote } from '../domain/types.js';
import { atomicWrite } from './atomic.js';
import { parseNote, serializeNote } from './note.js';
import type { VaultPaths } from './paths.js';

export interface Storage {
  listFeatures(): Promise<FeatureNote[]>;
  listTickets(featureSlug: string): Promise<TicketNote[]>;
  readNote<T>(path: string): Promise<Note<T>>;
  /** Atomic: a reader sees the old note or the new one, never a splice. */
  writeNote<T>(path: string, note: Note<T>): Promise<void>;
  appendSection(path: string, heading: string, md: string): Promise<void>;
  appendHistory(path: string, line: HistoryLine): Promise<void>;
}

/**
 * The order body sections appear in.
 *
 * `## History` is last so that anything appended later lands above it and the
 * audit trail stays at the bottom where a human looks for it. A heading not
 * named here is inserted just before History rather than being appended after
 * it — a human's own section should not push the history out of place.
 */
export const SECTION_ORDER = [
  '## Raw Requirement',
  '## Refined Requirement',
  '## Acceptance Criteria',
  '## Tech Plan',
  '## Implementation Notes',
  '## Review Notes',
  '## QA Notes',
  '## Gate Results',
  '## History',
] as const;

export class MarkdownStorage implements Storage {
  readonly paths: VaultPaths;

  constructor(paths: VaultPaths) {
    this.paths = paths;
  }

  async listFeatures(): Promise<FeatureNote[]> {
    const slugs = await this.listFeatureSlugs();
    const features: FeatureNote[] = [];

    for (const slug of slugs) {
      const file = this.paths.featureNote(slug);
      const raw = await readOptional(file);
      if (raw === undefined) continue;
      features.push(parseNote(raw, file));
    }
    return features;
  }

  async listTickets(featureSlug: string): Promise<TicketNote[]> {
    const directory = this.paths.ticketsDir(featureSlug);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const tickets: TicketNote[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(directory, entry.name);
      tickets.push(parseNote(await readFile(file, 'utf8'), file));
    }

    tickets.sort((a, b) => (a.frontmatter.id < b.frontmatter.id ? -1 : 1));
    return tickets;
  }

  async readNote<T>(file: string): Promise<Note<T>> {
    return parseNote<T>(await readFile(file, 'utf8'), file);
  }

  async writeNote<T>(file: string, note: Note<T>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, serializeNote(note));
  }

  async appendSection(file: string, heading: string, md: string): Promise<void> {
    const note = await this.readNote<Record<string, unknown>>(file);
    await this.writeNote(file, {
      frontmatter: note.frontmatter,
      body: appendToSection(note.body, heading, md),
    });
  }

  async appendHistory(file: string, line: HistoryLine): Promise<void> {
    const note = await this.readNote<Record<string, unknown>>(file);
    await this.writeNote(file, {
      frontmatter: note.frontmatter,
      body: appendHistoryLine(note.body, line),
    });
  }

  /** Directory names under `work/features/`, sorted. */
  private async listFeatureSlugs(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.paths.featuresDir(), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }
}

/**
 * Append `md` under `heading`, creating the section in canonical order if it is
 * not there yet. Pure, so the body surgery is testable without a disk.
 *
 * Everything outside the target section is left byte-identical — a section
 * append that reflows the rest of the note would defeat plan Section E item 2
 * just as thoroughly as a bad frontmatter emitter.
 */
export function appendToSection(body: string, heading: string, md: string): string {
  const normalised = normaliseHeading(heading);
  const content = md.replace(/\s+$/, '').split('\n');
  const lines = body.split('\n');
  const scan = scanMarkdown(lines);
  const headingIndex = findHeading(lines, scan, normalised);

  if (headingIndex === -1) {
    return insertNewSection(lines, scan.headings, normalised, content);
  }

  // Back over the blank lines that separate this section from the next, so the
  // new content lands directly under the existing content, not after the gap.
  let insertAt = sectionEnd(scan, headingIndex, lines.length);
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1;
  }

  return [
    ...lines.slice(0, insertAt),
    '',
    ...content,
    ...(insertAt === lines.length ? [''] : []),
    ...lines.slice(insertAt),
  ].join('\n');
}

function insertNewSection(
  lines: string[],
  headings: readonly number[],
  heading: string,
  content: readonly string[],
): string {
  const core = [heading, '', ...content];
  const before = firstHeadingAfter(lines, headings, heading);

  if (before === -1) {
    const trimmed = dropTrailingBlanks(lines);
    return (trimmed.length === 0 ? [...core, ''] : [...trimmed, '', ...core, '']).join('\n');
  }

  let insertAt = before;
  while (insertAt > 0 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;

  const head = lines.slice(0, insertAt);
  const tail = dropLeadingBlanks(lines.slice(insertAt));
  const prefix = head.length === 0 ? [] : [...head, ''];

  return [...prefix, ...core, '', ...tail].join('\n');
}

/**
 * The index of the first heading in `lines` that must stay below `heading`.
 * `-1` when the new section belongs at the end of the body.
 */
function firstHeadingAfter(
  lines: readonly string[],
  headings: readonly number[],
  heading: string,
): number {
  const order = SECTION_ORDER.indexOf(heading as (typeof SECTION_ORDER)[number]);

  for (const index of headings) {
    const candidate = (lines[index] ?? '').trim();

    if (order === -1) {
      // A heading the canonical order has never heard of — a human's own
      // section. It goes above History so the audit trail stays at the bottom.
      if (candidate === '## History') return index;
      continue;
    }

    const candidateOrder = SECTION_ORDER.indexOf(candidate as (typeof SECTION_ORDER)[number]);
    if (candidateOrder > order) return index;
  }
  return -1;
}

function dropTrailingBlanks(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(0, end);
}

function dropLeadingBlanks(lines: readonly string[]): string[] {
  let start = 0;
  while (start < lines.length && (lines[start] ?? '').trim() === '') start += 1;
  return lines.slice(start);
}

function normaliseHeading(heading: string): string {
  const text = heading.replace(/^#+\s*/, '').trim();
  if (text.length === 0) throw new TypeError('appendSection: heading must not be empty');
  return `## ${text}`;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

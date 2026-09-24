/** A note body as named sections, and `## History` lines as records. */
import { scanMarkdown } from '../domain/markdown.js';

export interface NoteSection {
  /** Heading text without the `## `; `''` for text before the first heading. */
  readonly heading: string;
  readonly markdown: string;
}

export interface HistoryEntry {
  readonly ts: string;
  readonly from: string;
  readonly to: string;
  readonly actor: string;
  readonly note: string | null;
}

const SECTION_HEADING = /^##\s+(.*)$/;
const HISTORY_LINE = /^- (\S+) \| (\S+) → (\S+) \| ([^|]+?)(?: \| (.*))?$/;

/** Splits on real `## ` headings only: deeper levels and fenced headings stay in their section. */
export function splitSections(body: string): NoteSection[] {
  const lines = body.split('\n');
  const scan = scanMarkdown(lines);
  const starts = scan.headings.filter((index) => SECTION_HEADING.test(lines[index] ?? ''));

  const sections: NoteSection[] = [];
  const preamble = lines.slice(0, starts[0] ?? lines.length).join('\n').trim();
  if (preamble !== '') sections.push({ heading: '', markdown: preamble });

  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? lines.length;
    sections.push({
      heading: (SECTION_HEADING.exec(lines[start] ?? '')?.[1] ?? '').trim(),
      markdown: lines.slice(start + 1, end).join('\n').trim(),
    });
  }
  return sections;
}

/** `- ts | from → to | actor[ | note]`; the note may itself contain `|`. */
export function parseHistory(markdown: string): HistoryEntry[] {
  const lines = markdown.split('\n');
  const scan = scanMarkdown(lines);
  const entries: HistoryEntry[] = [];

  for (const [index, line] of lines.entries()) {
    if (scan.fenced[index] === true) continue;
    const match = HISTORY_LINE.exec(line);
    if (match === null) continue;
    const note = match[5]?.trim() ?? '';
    entries.push({
      ts: match[1] ?? '',
      from: match[2] ?? '',
      to: match[3] ?? '',
      actor: (match[4] ?? '').trim(),
      note: note === '' ? null : note,
    });
  }
  return entries;
}

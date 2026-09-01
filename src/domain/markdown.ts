/**
 * The one markdown heading scan the whole factory uses.
 *
 * This exists because there were two of them and they disagreed. `src/vault`
 * skipped fenced code blocks; `appendHistoryLine` in `transitions.ts` did not.
 * A note body containing a fenced block with a `## History` line inside it —
 * an agent pasting a transcript, a tech plan quoting a template — sent every
 * history line into the code fence and left the real History section empty,
 * silently, on the live transition path.
 *
 * Two implementations of the same scan is the actual defect, so there is now
 * one. It is pure and imports nothing, so it belongs in the domain layer: the
 * dependency runs `src/vault → src/domain`, never the other way.
 */

/**
 * An ATX heading. Deliberately identical to the pattern both callers used
 * before this module existed — no leading indent, whitespace required after the
 * hashes — so this refactor changes fence handling and nothing else.
 */
export const HEADING_PATTERN = /^#{1,6}\s/;

/** Up to three spaces of indent, then three or more backticks or tildes. */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface MarkdownScan {
  /** Line indices of real headings, ascending. Never inside a fence. */
  readonly headings: readonly number[];
  /**
   * `true` where the line belongs to a fenced code block, delimiters included.
   * Indexed in step with the `lines` array the scan was built from.
   */
  readonly fenced: readonly boolean[];
}

/**
 * Locate every heading and every fenced region in one pass.
 *
 * Callers pass the result around rather than rescanning, so a body is never
 * walked twice and two call sites can never drift apart on what counts as a
 * heading.
 */
export function scanMarkdown(lines: readonly string[]): MarkdownScan {
  const headings: number[] = [];
  const fenced: boolean[] = new Array<boolean>(lines.length).fill(false);

  /** The marker that opened the current fence, or undefined outside one. */
  let openMarker: string | undefined;

  for (const [index, line] of lines.entries()) {
    const match = FENCE_PATTERN.exec(line);

    if (openMarker !== undefined) {
      fenced[index] = true;
      if (match !== null && closes(openMarker, match)) openMarker = undefined;
      continue;
    }

    if (match !== null && opens(match)) {
      openMarker = match[1];
      fenced[index] = true;
      continue;
    }

    if (HEADING_PATTERN.test(line)) headings.push(index);
  }

  return { headings, fenced };
}

/**
 * The line index of the heading whose trimmed text is exactly `heading`, or
 * `-1`. Only real headings are considered, so a `## History` inside a code
 * fence is not a match.
 */
export function findHeading(
  lines: readonly string[],
  scan: MarkdownScan,
  heading: string,
): number {
  for (const index of scan.headings) {
    if ((lines[index] ?? '').trim() === heading) return index;
  }
  return -1;
}

/**
 * The first line index *after* the section opened at `headingIndex` — that is,
 * the next real heading, or `lineCount` when the section runs to the end.
 */
export function sectionEnd(
  scan: MarkdownScan,
  headingIndex: number,
  lineCount: number,
): number {
  for (const index of scan.headings) {
    if (index > headingIndex) return index;
  }
  return lineCount;
}

/**
 * The content of one section, without its heading, or `undefined` when the
 * section is not there.
 *
 * The counterpart of `appendToSection` in `src/vault/storage.ts`: that writes a
 * section, this reads one back. Both go through the same scan, so a heading
 * inside a fenced code block is invisible to both — a tech plan quoting
 * `## Review Notes` in an example cannot become the review notes an agent is
 * handed on its retry.
 *
 * Trailing and leading blank lines are trimmed, so an existing-but-empty
 * section returns `''` and a caller can treat "no section" and "nothing in it"
 * the same way.
 */
export function sectionText(body: string, heading: string): string | undefined {
  const lines = body.split('\n');
  const scan = scanMarkdown(lines);
  const headingIndex = findHeading(lines, scan, heading);
  if (headingIndex === -1) return undefined;

  const end = sectionEnd(scan, headingIndex, lines.length);
  return lines
    .slice(headingIndex + 1, end)
    .join('\n')
    .trim();
}

/**
 * The body with the named sections removed, heading and all.
 *
 * Used when a document is injected into an agent prompt and part of it is
 * either injected separately or is orchestrator bookkeeping the agent has no
 * use for. A section that is not present is not an error — this is a filter,
 * not a lookup.
 *
 * Unnamed sections keep their original text and order; only whole sections go.
 */
export function removeSections(body: string, headings: readonly string[]): string {
  const lines = body.split('\n');
  const scan = scanMarkdown(lines);
  const drop = new Set<number>();

  for (const heading of headings) {
    const headingIndex = findHeading(lines, scan, heading);
    if (headingIndex === -1) continue;
    const end = sectionEnd(scan, headingIndex, lines.length);
    for (let index = headingIndex; index < end; index += 1) drop.add(index);
  }

  if (drop.size === 0) return body;
  return lines
    .filter((_line, index) => !drop.has(index))
    .join('\n')
    .trim();
}

/**
 * A backtick fence may not carry a backtick in its info string, because that is
 * how CommonMark disambiguates a fence from inline code. Tilde fences may.
 */
function opens(match: RegExpExecArray): boolean {
  const marker = match[1] ?? '';
  const info = match[2] ?? '';
  return !marker.startsWith('`') || !info.includes('`');
}

/**
 * A closing fence uses the same character, is at least as long as the opener,
 * and carries nothing but whitespace after it. Without the length rule a
 * ```` ``` ```` inside a ```` ```` ```` block would close it early.
 */
function closes(openMarker: string, match: RegExpExecArray): boolean {
  const marker = match[1] ?? '';
  const rest = match[2] ?? '';
  return (
    marker[0] === openMarker[0] && marker.length >= openMarker.length && rest.trim().length === 0
  );
}

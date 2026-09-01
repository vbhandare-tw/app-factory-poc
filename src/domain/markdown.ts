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

/**
 * `splitSections` / `parseHistory` against the real `feature.md` kept from the
 * second acceptance run (paths scrubbed to `<ROOT>`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseHistory, splitSections } from '../../../src/dashboard/sections.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'dashboard',
  'feature.md',
);

function realBody(): string {
  const raw = readFileSync(FIXTURE, 'utf8');
  const end = raw.indexOf('\n---\n', 4);
  return raw.slice(end + '\n---\n'.length);
}

describe('splitSections', () => {
  it('splits the real feature note into its named sections, in order', () => {
    expect(splitSections(realBody()).map((s) => s.heading)).toEqual([
      'Raw Requirement',
      'Refined Requirement',
      'Acceptance Criteria',
      'Tech Plan',
      'Gate Results',
      'Notes',
      'History',
    ]);
  });

  it('keeps a heading inside a code fence as part of its section', () => {
    const notes = splitSections(realBody()).find((s) => s.heading === 'Notes');
    expect(notes?.markdown).toContain('## Interpretation');
    expect(notes?.markdown).toContain('**Approved by a human** — final acceptance.');
  });

  it('trims the blank lines around each section body', () => {
    const history = splitSections(realBody()).find((s) => s.heading === 'History');
    expect(history?.markdown.startsWith('- 2026-09-22T09:00:13.000Z')).toBe(true);
    expect(history?.markdown.endsWith('accepted — merge and tag it')).toBe(true);
  });

  it('keeps deeper headings inside the section they belong to', () => {
    const body = '## Tech Plan\n\n### Modules\n\n- a\n\n## Notes\n\nn\n';
    expect(splitSections(body)).toEqual([
      { heading: 'Tech Plan', markdown: '### Modules\n\n- a' },
      { heading: 'Notes', markdown: 'n' },
    ]);
  });

  it('returns text before the first heading under an empty heading', () => {
    expect(splitSections('stray intro\n\n## Notes\nx')).toEqual([
      { heading: '', markdown: 'stray intro' },
      { heading: 'Notes', markdown: 'x' },
    ]);
  });

  it('returns nothing for an empty body', () => {
    expect(splitSections('')).toEqual([]);
    expect(splitSections('\n\n')).toEqual([]);
  });
});

describe('parseHistory', () => {
  const history = (): string =>
    splitSections(realBody()).find((s) => s.heading === 'History')?.markdown ?? '';

  it('parses all 9 real history lines', () => {
    const entries = parseHistory(history());
    expect(entries).toHaveLength(9);
    expect(entries[0]).toEqual({
      ts: '2026-09-22T09:00:13.000Z',
      from: 'intake',
      to: 'refining',
      actor: 'orchestrator',
      note: null,
    });
    expect(entries[2]).toEqual({
      ts: '2026-09-22T09:00:26.000Z',
      from: 'needs_human',
      to: 'planning',
      actor: 'human',
      note: 'approve: the refined requirement matches what I asked for',
    });
    expect(entries[8]).toEqual({
      ts: '2026-09-22T09:06:16.000Z',
      from: 'needs_human',
      to: 'done',
      actor: 'human',
      note:
        'final acceptance approved: merged b2d4c74f into main, tagged factory/calculator/2026-09-22 — accepted — merge and tag it',
    });
  });

  it('keeps a note that itself contains `|` whole', () => {
    const entries = parseHistory(
      '- 2026-09-22T10:00:00.000Z | needs_human → refining | human | reject: support a | b and c || d',
    );
    expect(entries).toEqual([
      {
        ts: '2026-09-22T10:00:00.000Z',
        from: 'needs_human',
        to: 'refining',
        actor: 'human',
        note: 'reject: support a | b and c || d',
      },
    ]);
  });

  it('skips lines that are not history entries, and bullets inside a fence', () => {
    const md = [
      'free text',
      '- not | a history line',
      '```',
      '- 2026-09-22T10:00:00.000Z | intake → refining | orchestrator',
      '```',
      '- 2026-09-22T11:00:00.000Z | intake → refining | orchestrator',
    ].join('\n');
    expect(parseHistory(md)).toEqual([
      { ts: '2026-09-22T11:00:00.000Z', from: 'intake', to: 'refining', actor: 'orchestrator', note: null },
    ]);
  });
});

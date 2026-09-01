import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_NAME_PATTERN } from '../../../src/vault/atomic.js';
import { NoteParseError, parseNote, serializeNote } from '../../../src/vault/note.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { MarkdownStorage, SECTION_ORDER, appendToSection } from '../../../src/vault/storage.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

let root: string;
let paths: VaultPaths;
let storage: MarkdownStorage;

beforeEach(() => {
  root = scratchDir('vault-');
  paths = new VaultPaths(root);
  storage = new MarkdownStorage(paths);
});

afterEach(() => {
  removeScratchDir(root);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('MarkdownStorage — notes', () => {
  it('writes a note and reads back identical frontmatter and body', async () => {
    const note = makeFeature({ slug: 'user-auth', id: 'FEAT-USER-AUTH' }, '## Raw Requirement\n\nx\n');
    const file = paths.featureNote('user-auth');

    await storage.writeNote(file, note);
    const read = await storage.readNote<typeof note.frontmatter>(file);

    expect(read.frontmatter).toEqual(note.frontmatter);
    expect(read.body).toBe(note.body);
  });

  it('creates missing parent directories on write', async () => {
    const file = paths.ticketPath('deep-slug', 'FEAT-DEEP-T001');
    await storage.writeNote(file, makeTicket({ id: 'FEAT-DEEP-T001', feature: 'deep-slug' }));
    expect(readFileSync(file, 'utf8')).toContain('id: "FEAT-DEEP-T001"');
  });

  it('leaves no temp file behind — the write goes through atomicWrite', async () => {
    const file = paths.featureNote('user-auth');
    await storage.writeNote(file, makeFeature({ slug: 'user-auth' }));
    await storage.writeNote(file, makeFeature({ slug: 'user-auth', status: 'refining' }));

    const dir = paths.featureDir('user-auth');
    expect(readdirSync(dir).filter((name) => TEMP_NAME_PATTERN.test(name))).toEqual([]);
  });

  it('a rewrite with no change produces byte-identical file contents', async () => {
    const file = paths.featureNote('user-auth');
    await storage.writeNote(file, makeFeature({ slug: 'user-auth' }, 'Body.\n'));
    const first = readFileSync(file, 'utf8');

    await storage.writeNote(file, await storage.readNote(file));
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('readNote on a malformed file throws NoteParseError naming that file', async () => {
    const file = paths.featureNote('broken');
    await storage.writeNote(file, makeFeature({ slug: 'broken' }));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '---\nid: [1, 2\n---\nbody\n');

    await expect(storage.readNote(file)).rejects.toThrowError(NoteParseError);
    await expect(storage.readNote(file)).rejects.toThrow(file);
  });

  it('readNote on a missing file rejects with ENOENT, not a parse error', async () => {
    await expect(storage.readNote(paths.featureNote('nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('MarkdownStorage — listing', () => {
  it('returns no features when the vault has none', async () => {
    expect(await storage.listFeatures()).toEqual([]);
  });

  it('lists every feature, ordered by slug and independent of write order', async () => {
    for (const slug of ['zeta', 'alpha', 'mid']) {
      await storage.writeNote(
        paths.featureNote(slug),
        makeFeature({ slug, id: `FEAT-${slug.toUpperCase()}` }),
      );
    }
    const features = await storage.listFeatures();
    expect(features.map((f) => f.frontmatter.slug)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('ignores a feature directory that has no feature.md', async () => {
    await storage.writeNote(paths.featureNote('real'), makeFeature({ slug: 'real' }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(paths.featureDir('empty-dir'), { recursive: true });

    expect((await storage.listFeatures()).map((f) => f.frontmatter.slug)).toEqual(['real']);
  });

  it('returns no tickets for a feature with no tickets directory', async () => {
    await storage.writeNote(paths.featureNote('bare'), makeFeature({ slug: 'bare' }));
    expect(await storage.listTickets('bare')).toEqual([]);
  });

  it('lists tickets ordered by id, not by directory order', async () => {
    for (const ordinal of [3, 1, 10, 2]) {
      const id = `FEAT-X-T${String(ordinal).padStart(3, '0')}`;
      await storage.writeNote(paths.ticketPath('x', id), makeTicket({ id, feature: 'x', ordinal }));
    }
    const tickets = await storage.listTickets('x');
    expect(tickets.map((t) => t.frontmatter.id)).toEqual([
      'FEAT-X-T001',
      'FEAT-X-T002',
      'FEAT-X-T003',
      'FEAT-X-T010',
    ]);
  });

  it('ignores non-markdown files in the tickets directory', async () => {
    await storage.writeNote(
      paths.ticketPath('x', 'FEAT-X-T001'),
      makeTicket({ id: 'FEAT-X-T001', feature: 'x' }),
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${paths.ticketsDir('x')}/notes.txt`, 'not a note');
    writeFileSync(`${paths.ticketsDir('x')}/FEAT-X-T002.md.99.1.tmp`, 'orphan temp');

    expect((await storage.listTickets('x')).map((t) => t.frontmatter.id)).toEqual(['FEAT-X-T001']);
  });
});

describe('appendToSection — the pure body surgery', () => {
  it('appends under an existing heading, leaving the rest untouched', () => {
    const body = [
      '## Raw Requirement',
      '',
      'Original.',
      '',
      '## History',
      '',
      '- line one',
      '',
    ].join('\n');

    const out = appendToSection(body, '## Raw Requirement', 'Added later.');

    expect(out).toBe(
      [
        '## Raw Requirement',
        '',
        'Original.',
        '',
        'Added later.',
        '',
        '## History',
        '',
        '- line one',
        '',
      ].join('\n'),
    );
  });

  it('creates a missing heading in canonical order, before History', () => {
    const body = ['## Raw Requirement', '', 'x', '', '## History', '', '- line', ''].join('\n');
    const out = appendToSection(body, '## Review Notes', 'Reviewer says no.');

    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## Raw Requirement', '## Review Notes', '## History']);
    expect(out).toContain('Reviewer says no.');
  });

  it('inserts a heading between the two canonical neighbours that already exist', () => {
    const body = ['## Raw Requirement', '', 'x', '', '## QA Notes', '', 'q', ''].join('\n');
    const out = appendToSection(body, '## Review Notes', 'r');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## Raw Requirement', '## Review Notes', '## QA Notes']);
  });

  it('puts a heading the canonical order does not know about before History', () => {
    const body = ['## Raw Requirement', '', 'x', '', '## History', '', '- line', ''].join('\n');
    const out = appendToSection(body, '## Human Scribbles', 'note to self');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## Raw Requirement', '## Human Scribbles', '## History']);
  });

  it('appends an unknown heading at the end when there is no History section', () => {
    const out = appendToSection('## Raw Requirement\n\nx\n', '## Human Scribbles', 'note');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## Raw Requirement', '## Human Scribbles']);
  });

  it('creates the section in an empty body without leading blank lines', () => {
    expect(appendToSection('', '## Review Notes', 'r')).toBe('## Review Notes\n\nr\n');
  });

  it('normalises a heading given without the ## prefix', () => {
    expect(appendToSection('', 'Review Notes', 'r')).toBe('## Review Notes\n\nr\n');
  });

  it('does not disturb a fenced code block that contains a ## line', () => {
    const body = ['## Raw Requirement', '', '```md', '## Not a heading', '```', ''].join('\n');
    const out = appendToSection(body, '## Raw Requirement', 'more');
    expect(out).toContain('```md\n## Not a heading\n```');
  });

  it('ends the section with exactly one trailing newline, never a growing gap', () => {
    let body = '';
    for (let index = 0; index < 4; index += 1) {
      body = appendToSection(body, '## Review Notes', `note ${index}`);
    }
    expect(body).toBe(
      ['## Review Notes', '', 'note 0', '', 'note 1', '', 'note 2', '', 'note 3', ''].join('\n'),
    );
  });

  it('refuses an empty heading', () => {
    expect(() => appendToSection('', '##', 'x')).toThrowError(TypeError);
  });

  it('SECTION_ORDER ends with History so appended sections never land after it', () => {
    expect(SECTION_ORDER[SECTION_ORDER.length - 1]).toBe('## History');
  });
});

describe('MarkdownStorage — appendSection and appendHistory', () => {
  it('appendSection rewrites only the body and leaves frontmatter byte-identical', async () => {
    const file = paths.ticketPath('x', 'FEAT-X-T001');
    await storage.writeNote(
      file,
      makeTicket({ id: 'FEAT-X-T001', feature: 'x' }, '## Raw Requirement\n\nx\n'),
    );
    const before = readFileSync(file, 'utf8');

    await storage.appendSection(file, '## Review Notes', 'Reviewer says no.');
    const after = readFileSync(file, 'utf8');

    const frontmatterOf = (text: string): string => text.split('\n---\n')[0] ?? '';
    expect(frontmatterOf(after)).toBe(frontmatterOf(before));
    expect(after).toContain('## Review Notes');
    expect(after).toContain('Reviewer says no.');
  });

  it('appendSection preserves an unknown frontmatter key', async () => {
    const file = paths.ticketPath('x', 'FEAT-X-T001');
    const note = makeTicket({ id: 'FEAT-X-T001', feature: 'x' }, 'Body.\n');
    const withUnknown = {
      frontmatter: { ...note.frontmatter, obsidian_tags: ['wip'] },
      body: note.body,
    };
    await storage.writeNote(file, withUnknown);

    await storage.appendSection(file, '## QA Notes', 'evidence');

    const read = await storage.readNote<Record<string, unknown>>(file);
    expect(read.frontmatter['obsidian_tags']).toEqual(['wip']);
  });

  it('appendHistory adds exactly one line in the documented format', async () => {
    const file = paths.featureNote('x');
    await storage.writeNote(file, makeFeature({ slug: 'x' }, '## Raw Requirement\n\nx\n'));

    await storage.appendHistory(file, {
      timestamp: '2026-08-31T10:05:00Z',
      from: 'intake',
      to: 'refining',
      actor: 'orchestrator',
      note: 'picked up',
    });

    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((line) => line.startsWith('- 2026-'));
    expect(lines).toEqual([
      '- 2026-08-31T10:05:00Z | intake → refining | orchestrator | picked up',
    ]);
  });

  it('appendHistory twice yields two lines in order, and nothing else changes', async () => {
    const file = paths.featureNote('x');
    await storage.writeNote(file, makeFeature({ slug: 'x' }, 'Body.\n'));

    await storage.appendHistory(file, {
      timestamp: '2026-08-31T10:05:00Z',
      from: 'intake',
      to: 'refining',
      actor: 'orchestrator',
    });
    await storage.appendHistory(file, {
      timestamp: '2026-08-31T10:06:00Z',
      from: 'refining',
      to: 'planning',
      actor: 'orchestrator',
    });

    const read = await storage.readNote(file);
    expect(read.body.split('\n').filter((line) => line.startsWith('- 2026-'))).toEqual([
      '- 2026-08-31T10:05:00Z | intake → refining | orchestrator',
      '- 2026-08-31T10:06:00Z | refining → planning | orchestrator',
    ]);
    expect(read.body).toContain('Body.');
  });

  it('the whole file still parses after a section and a history append', async () => {
    const file = paths.ticketPath('x', 'FEAT-X-T001');
    await storage.writeNote(file, makeTicket({ id: 'FEAT-X-T001', feature: 'x' }, ''));
    await storage.appendSection(file, '## Review Notes', 'r');
    await storage.appendHistory(file, {
      timestamp: '2026-08-31T10:05:00Z',
      from: 'in_progress',
      to: 'gates',
      actor: 'orchestrator',
    });

    const text = readFileSync(file, 'utf8');
    const note = parseNote<Record<string, unknown>>(text, file);
    expect(note.frontmatter['id']).toBe('FEAT-X-T001');
    expect(serializeNote(note)).toBe(text);
  });
});

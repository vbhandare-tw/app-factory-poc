import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildIndex, regenerateIndex } from '../../../src/vault/index-md.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { MarkdownStorage } from '../../../src/vault/storage.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

let root: string;
let paths: VaultPaths;
let storage: MarkdownStorage;

beforeEach(() => {
  root = scratchDir('index-');
  paths = new VaultPaths(root);
  storage = new MarkdownStorage(paths);
});

afterEach(() => {
  removeScratchDir(root);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

async function seed(): Promise<void> {
  await storage.writeNote(
    paths.featureNote('user-auth'),
    makeFeature({
      id: 'FEAT-USER-AUTH',
      slug: 'user-auth',
      title: 'User authentication',
      status: 'in_development',
    }),
  );
  const states = ['done', 'in_progress', 'backlog', 'backlog'] as const;
  for (const [index, status] of states.entries()) {
    const id = `FEAT-USER-AUTH-T${String(index + 1).padStart(3, '0')}`;
    await storage.writeNote(
      paths.ticketPath('user-auth', id),
      makeTicket({ id, feature: 'user-auth', ordinal: index + 1, status }),
    );
  }

  await storage.writeNote(
    paths.featureNote('billing'),
    makeFeature({ id: 'FEAT-BILLING', slug: 'billing', title: 'Billing', status: 'intake' }),
  );
}

describe('buildIndex', () => {
  it('lists features with correct per-state ticket counts', () => {
    const md = buildIndex([
      {
        feature: makeFeature({
          id: 'FEAT-USER-AUTH',
          slug: 'user-auth',
          title: 'User authentication',
          status: 'in_development',
        }),
        tickets: [
          makeTicket({ id: 'T1', feature: 'user-auth', status: 'done' }),
          makeTicket({ id: 'T2', feature: 'user-auth', status: 'in_progress' }),
          makeTicket({ id: 'T3', feature: 'user-auth', status: 'backlog' }),
          makeTicket({ id: 'T4', feature: 'user-auth', status: 'backlog' }),
        ],
      },
    ]);

    expect(md).toContain('User authentication');
    expect(md).toContain('in_development');
    expect(md).toMatch(/\|\s*4\s*\|/);
    expect(md).toContain('backlog 2');
    expect(md).toContain('in_progress 1');
    expect(md).toContain('done 1');
  });

  it('omits states with a zero count rather than printing noise', () => {
    const md = buildIndex([
      {
        feature: makeFeature({ slug: 'x', title: 'X' }),
        tickets: [makeTicket({ id: 'T1', feature: 'x', status: 'done' })],
      },
    ]);
    expect(md).toContain('done 1');
    expect(md).not.toContain('backlog 0');
    expect(md).not.toContain('qa 0');
  });

  it('counts states in the canonical ticket-state order, not first-seen order', () => {
    const md = buildIndex([
      {
        feature: makeFeature({ slug: 'x', title: 'X' }),
        tickets: [
          makeTicket({ id: 'T1', feature: 'x', status: 'done' }),
          makeTicket({ id: 'T2', feature: 'x', status: 'backlog' }),
        ],
      },
    ]);
    expect(md).toContain('backlog 1, done 1');
  });

  it('sorts features by slug so the output does not depend on scan order', () => {
    const entries = [
      { feature: makeFeature({ slug: 'zeta', title: 'Zeta' }), tickets: [] },
      { feature: makeFeature({ slug: 'alpha', title: 'Alpha' }), tickets: [] },
    ];
    const forwards = buildIndex(entries);
    const backwards = buildIndex([...entries].reverse());

    expect(forwards).toBe(backwards);
    expect(forwards.indexOf('Alpha')).toBeLessThan(forwards.indexOf('Zeta'));
  });

  it('produces identical bytes for identical input (no clock, no counters)', () => {
    const entries = [{ feature: makeFeature({ slug: 'x', title: 'X' }), tickets: [] }];
    expect(buildIndex(entries)).toBe(buildIndex(entries));
  });

  it('renders an empty vault without an empty table', () => {
    const md = buildIndex([]);
    expect(md).toContain('# Factory Index');
    expect(md).toContain('_No features yet._');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('escapes a pipe in a feature title so the table does not break', () => {
    const md = buildIndex([
      { feature: makeFeature({ slug: 'x', title: 'A | B' }), tickets: [] },
    ]);
    expect(md).toContain('A \\| B');
  });

  it('flattens a newline in a title so the table row is not cut in half', () => {
    const md = buildIndex([
      {
        feature: makeFeature({ slug: 'x', title: 'First line\nSecond line' }),
        tickets: [makeTicket({ id: 'T1', feature: 'x', status: 'done' })],
      },
    ]);

    const rows = md.split('\n').filter((line) => line.startsWith('| ['));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('First line Second line');
    expect(rows[0]).toContain('done 1');
    // No orphan line: the second half of the title must not escape the row.
    expect(md.split('\n').some((line) => line.startsWith('Second line'))).toBe(false);
  });

  it('flattens CRLF, tabs and runs of spaces in a title', () => {
    const md = buildIndex([
      { feature: makeFeature({ slug: 'x', title: '  A\r\n\tB   C  ' }), tickets: [] },
    ]);
    expect(md).toContain('[A B C]');
  });

  it('a title with both a newline and a pipe stays on one well-formed row', () => {
    const md = buildIndex([
      { feature: makeFeature({ slug: 'x', title: 'A | B\nC' }), tickets: [] },
    ]);
    const rows = md.split('\n').filter((line) => line.startsWith('| ['));
    expect(rows).toEqual(['| [A \\| B C](work/features/x/feature.md) | intake | 0 | — |']);
  });

  it('links each feature at its vault-relative path', () => {
    const md = buildIndex([
      { feature: makeFeature({ slug: 'user-auth', title: 'User authentication' }), tickets: [] },
    ]);
    expect(md).toContain('(work/features/user-auth/feature.md)');
  });
});

describe('regenerateIndex', () => {
  it('writes index.md at the vault root and returns what it wrote', async () => {
    await seed();
    const written = await regenerateIndex(storage, paths);
    expect(readFileSync(paths.indexFile(), 'utf8')).toBe(written);
    expect(written).toContain('User authentication');
    expect(written).toContain('Billing');
  });

  it('regenerating twice from unchanged state produces identical bytes', async () => {
    await seed();
    const first = await regenerateIndex(storage, paths);
    const firstOnDisk = readFileSync(paths.indexFile(), 'utf8');

    const second = await regenerateIndex(storage, paths);
    const secondOnDisk = readFileSync(paths.indexFile(), 'utf8');

    expect(second).toBe(first);
    expect(secondOnDisk).toBe(firstOnDisk);
  });

  it('reflects a state change on the next regeneration', async () => {
    await seed();
    await regenerateIndex(storage, paths);

    const ticketPath = paths.ticketPath('user-auth', 'FEAT-USER-AUTH-T003');
    const ticket = await storage.readNote<{ status: string }>(ticketPath);
    await storage.writeNote(ticketPath, {
      frontmatter: { ...ticket.frontmatter, status: 'done' },
      body: ticket.body,
    });

    const after = await regenerateIndex(storage, paths);
    expect(after).toContain('done 2');
    expect(after).toContain('backlog 1');
  });

  it('works on a vault with no features at all', async () => {
    const written = await regenerateIndex(storage, paths);
    expect(written).toContain('_No features yet._');
    expect(readFileSync(paths.indexFile(), 'utf8')).toBe(written);
  });
});

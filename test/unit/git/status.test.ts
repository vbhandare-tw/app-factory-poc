/**
 * `git status --porcelain=v1 -z` parsing (plan Phase 9, `src/git/git.ts`).
 *
 * ============================================================================
 * WHY THIS IS ITS OWN FILE
 * ============================================================================
 * `commit.ts` decides what to stage from these entries, and every way of
 * misreading the NUL framing fails **quietly**:
 *
 * - A rename parsed as one entry stages the new path and leaves the old path's
 *   deletion behind, so the commit carries the file under both names and every
 *   gate still passes.
 * - An ignored entry misread as a normal one puts `node_modules/` in the diff.
 * - An off-by-one on the `XY<space>` prefix produces paths with a leading space,
 *   which `git add` then reports as pathspec misses — and `git add` on a missing
 *   pathspec is an error, so that one at least is loud.
 *
 * The framing is asserted against strings taken from real `git status` output
 * rather than from the parser's own idea of the format.
 */
import { describe, expect, it } from 'vitest';

import { parsePorcelainZ } from '../../../src/git/git.js';

describe('parsePorcelainZ', () => {
  it('reads the ordinary shapes', () => {
    const entries = parsePorcelainZ(
      ' M src/calc.ts\0?? src/describe.test.ts\0 D src/gone.ts\0A  src/added.ts\0',
    );

    expect(entries.map((entry) => entry.path)).toEqual([
      'src/calc.ts',
      'src/describe.test.ts',
      'src/gone.ts',
      'src/added.ts',
    ]);
    expect(entries[0]?.x).toBe(' ');
    expect(entries[0]?.y).toBe('M');
    expect(entries[1]?.x).toBe('?');
    expect(entries.every((entry) => entry.originalPath === null)).toBe(true);
  });

  it('reads a rename as one entry carrying both paths', () => {
    // `R  <new>NUL<old>NUL`. The old path belongs to the same entry, and a
    // parser that treated it as its own entry would produce a bare path with no
    // status prefix — and then stage only half the rename.
    const entries = parsePorcelainZ('R  src/new.ts\0src/old.ts\0 M src/calc.ts\0');

    expect(entries).toHaveLength(2);
    expect(entries[0]?.path).toBe('src/new.ts');
    expect(entries[0]?.originalPath).toBe('src/old.ts');
    expect(entries[0]?.x).toBe('R');
    expect(entries[1]?.path).toBe('src/calc.ts');
    expect(entries[1]?.originalPath).toBeNull();
  });

  it('reads a copy the same way', () => {
    const entries = parsePorcelainZ('C  src/copy.ts\0src/source.ts\0');
    expect(entries[0]?.originalPath).toBe('src/source.ts');
  });

  it('marks ignored entries so they are never staged', () => {
    const entries = parsePorcelainZ('!! node_modules/\0!! dist/\0?? src/real.ts\0');
    expect(entries.filter((entry) => entry.x === '!').map((entry) => entry.path)).toEqual([
      'node_modules/',
      'dist/',
    ]);
    expect(entries.filter((entry) => entry.x !== '!').map((entry) => entry.path)).toEqual([
      'src/real.ts',
    ]);
  });

  it('keeps paths that would need quoting in the human-readable format', () => {
    // `-z` means no quoting and no escaping at all, which is the whole reason it
    // is used: the non-`-z` form would render this as `"a b/\303\251.ts"`.
    const entries = parsePorcelainZ('?? a b/é.ts\0?? has"quote.ts\0');
    expect(entries.map((entry) => entry.path)).toEqual(['a b/é.ts', 'has"quote.ts']);
  });

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ('\0')).toEqual([]);
  });
});

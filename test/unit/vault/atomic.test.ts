import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_NAME_PATTERN, atomicWrite, sweepOrphanTemps } from '../../../src/vault/atomic.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

let dir: string;

beforeEach(() => {
  dir = scratchDir('atomic-');
});

afterEach(() => {
  removeScratchDir(dir);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

function tempFiles(): string[] {
  return readdirSync(dir).filter((name) => TEMP_NAME_PATTERN.test(name));
}

describe('atomicWrite', () => {
  it('creates the file with exactly the bytes given', async () => {
    const target = path.join(dir, 'note.md');
    await atomicWrite(target, 'hello\n');
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('leaves no .tmp file behind on success', async () => {
    const target = path.join(dir, 'note.md');
    await atomicWrite(target, 'first\n');
    await atomicWrite(target, 'second\n');
    expect(tempFiles()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['note.md']);
  });

  it('replaces an existing file rather than appending to it', async () => {
    const target = path.join(dir, 'note.md');
    await atomicWrite(target, 'aaaaaaaaaa\n');
    await atomicWrite(target, 'b\n');
    expect(readFileSync(target, 'utf8')).toBe('b\n');
  });

  it('writes the temp file in the same directory as the target', async () => {
    const target = path.join(dir, 'note.md');
    let seen = '';
    await atomicWrite(target, 'x\n', {
      beforeRename: (temp) => {
        seen = temp;
      },
    });
    expect(path.dirname(seen)).toBe(path.resolve(dir));
    expect(TEMP_NAME_PATTERN.test(path.basename(seen))).toBe(true);
  });

  it('a failure between temp-write and rename leaves the original byte-intact', async () => {
    const target = path.join(dir, 'note.md');
    const original = '---\nid: "FEAT-X"\n---\n\noriginal body\n';
    await atomicWrite(target, original);

    await expect(
      atomicWrite(target, 'replacement that must never land\n', {
        beforeRename: () => {
          throw new Error('simulated crash before rename');
        },
      }),
    ).rejects.toThrow('simulated crash before rename');

    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('cleans up its temp file when the write fails before rename', async () => {
    const target = path.join(dir, 'note.md');
    await atomicWrite(target, 'original\n');

    await expect(
      atomicWrite(target, 'nope\n', {
        beforeRename: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    expect(tempFiles()).toEqual([]);
  });

  it('a failure before rename never creates the target when it did not exist', async () => {
    const target = path.join(dir, 'brand-new.md');
    await expect(
      atomicWrite(target, 'content\n', {
        beforeRename: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(target)).toBe(false);
  });

  it('concurrent writes both complete and the file is one whole version, never a splice', async () => {
    const target = path.join(dir, 'note.md');
    // Large and highly distinguishable, so a spliced result cannot pass by luck.
    const a = `${'A'.repeat(400_000)}\n`;
    const b = `${'B'.repeat(400_000)}\n`;

    await Promise.all([atomicWrite(target, a), atomicWrite(target, b)]);

    const landed = readFileSync(target, 'utf8');
    expect([a, b]).toContain(landed);
    expect(tempFiles()).toEqual([]);
  });

  it('many concurrent writers to the same path all land whole', async () => {
    const target = path.join(dir, 'note.md');
    const versions = Array.from({ length: 12 }, (_, index) => `${String(index).repeat(50_000)}\n`);

    await Promise.all(versions.map((content) => atomicWrite(target, content)));

    expect(versions).toContain(readFileSync(target, 'utf8'));
    expect(tempFiles()).toEqual([]);
  });

  it('concurrent writes to different paths do not collide on a temp name', async () => {
    const targets = Array.from({ length: 20 }, (_, index) => path.join(dir, `n${index}.md`));
    await Promise.all(targets.map((target, index) => atomicWrite(target, `body ${index}\n`)));

    for (const [index, target] of targets.entries()) {
      expect(readFileSync(target, 'utf8')).toBe(`body ${index}\n`);
    }
    expect(tempFiles()).toEqual([]);
  });
});

describe('the constraint the crash test rests on', () => {
  it('atomic.ts imports nothing but node builtins', async () => {
    const source = readFileSync(
      new URL('../../../src/vault/atomic.ts', import.meta.url),
      'utf8',
    );
    const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(
      (match) => match[1] ?? '',
    );

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      // `test/helpers/crashDuringWrite.mjs` loads this module by its real `.ts`
      // path under Node's type stripping, which cannot resolve a `./x.js`
      // specifier pointing at a `.ts` file. A cross-module import here would
      // make the SIGKILL crash test fail to start — or worse, be quietly
      // skipped — so the constraint is asserted rather than commented.
      expect(specifier, `atomic.ts must not import ${specifier}`).toMatch(/^node:/);
    }
  });
});

describe('sweepOrphanTemps', () => {
  const HOUR = 60 * 60 * 1000;

  function plantTemp(name: string, ageMs: number, now: number): string {
    const full = path.join(dir, name);
    writeFileSync(full, 'orphan\n');
    const seconds = (now - ageMs) / 1000;
    utimesSync(full, seconds, seconds);
    return full;
  }

  it('removes temps older than the cutoff and keeps newer ones', async () => {
    const now = Date.now();
    const old = plantTemp('note.md.111.1.tmp', 3 * HOUR, now);
    const fresh = plantTemp('note.md.222.2.tmp', 5 * 1000, now);

    const removed = await sweepOrphanTemps(dir, HOUR, { now });

    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches a file that is not a factory temp', async () => {
    const now = Date.now();
    const note = path.join(dir, 'note.md');
    writeFileSync(note, 'real note\n');
    utimesSync(note, (now - 10 * HOUR) / 1000, (now - 10 * HOUR) / 1000);
    const decoy = path.join(dir, 'something.tmp');
    writeFileSync(decoy, 'not ours\n');
    utimesSync(decoy, (now - 10 * HOUR) / 1000, (now - 10 * HOUR) / 1000);

    const removed = await sweepOrphanTemps(dir, HOUR, { now });

    expect(removed).toEqual([]);
    expect(existsSync(note)).toBe(true);
    expect(existsSync(decoy)).toBe(true);
  });

  it('sweeps nested directories too', async () => {
    const now = Date.now();
    const nested = path.join(dir, 'work', 'features', 'x');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nested, { recursive: true });
    const full = path.join(nested, 'feature.md.99.1.tmp');
    writeFileSync(full, 'orphan\n');
    utimesSync(full, (now - 2 * HOUR) / 1000, (now - 2 * HOUR) / 1000);

    const removed = await sweepOrphanTemps(dir, HOUR, { now });
    expect(removed).toEqual([full]);
  });

  it('returns an empty list for a directory that does not exist', async () => {
    const removed = await sweepOrphanTemps(path.join(dir, 'nope'), HOUR, { now: Date.now() });
    expect(removed).toEqual([]);
  });

  it('leaves a temp belonging to a write that is still in flight', async () => {
    const target = path.join(dir, 'note.md');
    const now = Date.now();
    let sweptDuringWrite: string[] = [];

    await atomicWrite(target, 'content\n', {
      beforeRename: async () => {
        sweptDuringWrite = await sweepOrphanTemps(dir, HOUR, { now });
      },
    });

    expect(sweptDuringWrite).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('content\n');
  });
});

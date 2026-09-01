import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_NAME_PATTERN, sweepOrphanTemps } from '../../src/vault/atomic.js';
import { parseNote, serializeNote } from '../../src/vault/note.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { MarkdownStorage } from '../../src/vault/storage.js';
import { regenerateIndex } from '../../src/vault/index-md.js';
import { makeFeature, makeTicket } from '../helpers/notes.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../helpers/toyRepo.js';
import { HOSTILE_BODY, HOSTILE_VALUES } from '../helpers/vaultFixtures.js';

const HELPERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers');
const CRASH_SCRIPT = path.join(HELPERS_DIR, 'crashDuringWrite.mjs');

let root: string;
let paths: VaultPaths;
let storage: MarkdownStorage;

beforeEach(() => {
  root = scratchDir('vault-int-');
  paths = new VaultPaths(root);
  storage = new MarkdownStorage(paths);
});

afterEach(() => {
  removeScratchDir(root);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('bulk fidelity — 50 notes through a real filesystem', () => {
  it('writes 50 notes, reads them all back, and every value is unchanged', async () => {
    const written = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();

    for (let index = 0; index < 10; index += 1) {
      const slug = `feature-${String(index).padStart(2, '0')}`;
      const feature = makeFeature(
        {
          id: `FEAT-${slug.toUpperCase()}`,
          slug,
          title: `Feature ${index} — unicode 日本語 🎉`,
          status: index % 2 === 0 ? 'in_development' : 'intake',
          created_at: '2026-08-31T10:00:00Z',
          updated_at: `2026-08-31T10:0${index % 10}:00Z`,
          cost_usd: index / 4,
        },
        `## Raw Requirement\n\nRequirement ${index}.\n\n---\n\nA literal rule.\n`,
      );
      // Every fifth feature also carries the full hostile value set, plus a
      // key no type in this codebase has ever heard of.
      const frontmatter: Record<string, unknown> =
        index % 5 === 0
          ? { ...feature.frontmatter, ...HOSTILE_VALUES }
          : { ...feature.frontmatter, obsidian_tags: ['factory'] };

      const note = { frontmatter, body: index % 5 === 0 ? HOSTILE_BODY : feature.body };
      const file = paths.featureNote(slug);
      await storage.writeNote(file, note);
      written.set(file, note);

      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const id = `FEAT-${slug.toUpperCase()}-T${String(ordinal).padStart(3, '0')}`;
        const ticket = makeTicket({
          id,
          feature: slug,
          ordinal,
          title: `Ticket ${ordinal}`,
          depends_on: ordinal === 1 ? [] : [`FEAT-${slug.toUpperCase()}-T001`],
          status: ordinal === 1 ? 'done' : 'backlog',
          max_attempts: ordinal === 4 ? 5 : null,
        });
        const ticketFile = paths.ticketPath(slug, id);
        await storage.writeNote(ticketFile, ticket);
        written.set(ticketFile, {
          frontmatter: ticket.frontmatter as unknown as Record<string, unknown>,
          body: ticket.body,
        });
      }
    }

    expect(written.size).toBe(50);

    for (const [file, expected] of written) {
      const read = await storage.readNote<Record<string, unknown>>(file);
      expect(read.frontmatter, `frontmatter drifted in ${file}`).toEqual(expected.frontmatter);
      expect(read.body, `body drifted in ${file}`).toBe(expected.body);
    }
  });

  it('rewriting all 50 notes unchanged leaves every file byte-identical', async () => {
    for (let index = 0; index < 10; index += 1) {
      const slug = `feature-${String(index).padStart(2, '0')}`;
      await storage.writeNote(
        paths.featureNote(slug),
        makeFeature({ id: `FEAT-${index}`, slug }, `Body ${index}\n`),
      );
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const id = `FEAT-${index}-T${String(ordinal).padStart(3, '0')}`;
        await storage.writeNote(
          paths.ticketPath(slug, id),
          makeTicket({ id, feature: slug, ordinal }),
        );
      }
    }

    const before = snapshot(root);
    for (const file of before.keys()) {
      if (!file.endsWith('.md')) continue;
      await storage.writeNote(file, await storage.readNote(file));
    }
    expect(snapshot(root)).toEqual(before);
  });

  it('a full vault scan after bulk writes finds every feature and ticket', async () => {
    for (let index = 0; index < 10; index += 1) {
      const slug = `feature-${String(index).padStart(2, '0')}`;
      await storage.writeNote(paths.featureNote(slug), makeFeature({ id: `FEAT-${index}`, slug }));
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const id = `FEAT-${index}-T${String(ordinal).padStart(3, '0')}`;
        await storage.writeNote(
          paths.ticketPath(slug, id),
          makeTicket({ id, feature: slug, ordinal }),
        );
      }
    }

    const features = await storage.listFeatures();
    expect(features).toHaveLength(10);

    let tickets = 0;
    for (const feature of features) {
      tickets += (await storage.listTickets(feature.frontmatter.slug)).length;
    }
    expect(tickets).toBe(40);

    const index = await regenerateIndex(storage, paths);
    expect(index.split('\n').filter((line) => line.startsWith('| [')).length).toBe(10);
  });
});

describe('crash safety — the process is killed between temp-write and rename', () => {
  it('leaves the original note byte-intact and the vault parseable', async () => {
    const slug = 'user-auth';
    const file = paths.featureNote(slug);
    const original = makeFeature(
      { id: 'FEAT-USER-AUTH', slug, title: 'User authentication' },
      '## Raw Requirement\n\nThe original body that must survive.\n',
    );
    await storage.writeNote(file, original);
    const originalBytes = readFileSync(file, 'utf8');

    const replacementFile = path.join(root, 'replacement.txt');
    writeFileSync(
      replacementFile,
      serializeNote({
        frontmatter: { ...original.frontmatter, status: 'planning' },
        body: '## Raw Requirement\n\nThis body must never land.\n',
      }),
      'utf8',
    );

    const child = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', CRASH_SCRIPT, file, replacementFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // Proof the crash was a real kill, not our own error handling.
    expect(child.signal, `stdout=${child.stdout}\nstderr=${child.stderr}`).toBe('SIGKILL');
    expect(child.status).toBeNull();

    // The original is untouched, byte for byte.
    expect(readFileSync(file, 'utf8')).toBe(originalBytes);

    // The half-written temp is still on disk — nothing cleaned up after a kill.
    const temps = readdirSync(paths.featureDir(slug)).filter((name) =>
      TEMP_NAME_PATTERN.test(name),
    );
    expect(temps).toHaveLength(1);

    // Restart: the vault parses clean, and the orphan is swept.
    const features = await storage.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0]!.frontmatter.status).toBe('intake');
    expect(features[0]!.body).toContain('The original body that must survive.');

    const removed = await sweepOrphanTemps(root, 0, { now: Date.now() + 1000 });
    expect(removed).toHaveLength(1);
    expect(readdirSync(paths.featureDir(slug))).toEqual(['feature.md']);
    expect(readFileSync(file, 'utf8')).toBe(originalBytes);
  });

  it('a crash while creating a brand-new note leaves no note at all, not a partial one', async () => {
    const slug = 'brand-new';
    const file = paths.featureNote(slug);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(file), { recursive: true });

    const contentFile = path.join(root, 'content.txt');
    writeFileSync(contentFile, serializeNote(makeFeature({ slug })), 'utf8');

    const child = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', CRASH_SCRIPT, file, contentFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(child.signal).toBe('SIGKILL');

    expect(existsSync(file)).toBe(false);
    // A half-written note never appears in a scan, because it is never named
    // `feature.md` until the rename lands.
    expect(await storage.listFeatures()).toEqual([]);
  });

  it('every surviving file in the vault still parses after the crash', async () => {
    for (const slug of ['alpha', 'beta', 'gamma']) {
      await storage.writeNote(paths.featureNote(slug), makeFeature({ id: `FEAT-${slug}`, slug }));
    }
    const contentFile = path.join(root, 'content.txt');
    writeFileSync(contentFile, serializeNote(makeFeature({ slug: 'beta' })), 'utf8');

    const child = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        CRASH_SCRIPT,
        paths.featureNote('beta'),
        contentFile,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(child.signal).toBe('SIGKILL');

    for (const [file, contents] of snapshot(root)) {
      if (!file.endsWith('.md')) continue;
      expect(() => parseNote(contents, file)).not.toThrow();
    }
  });
});

/** Every regular file under `dir`, mapped to its exact bytes. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(full, readFileSync(full, 'utf8'));
  }
  return files;
}

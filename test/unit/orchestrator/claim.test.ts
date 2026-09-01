/**
 * The item claim (spec §7.4, plan Phase 7a).
 *
 * The three cases the plan names, plus the one that is not observable from
 * outcomes at this milestone and therefore has to be proved directly: that the
 * read-back is a **real read from disk**.
 *
 * With `max_parallel_devs` pinned to 1 there is never a second instance in
 * M1–M3, so a read-back that compared against the in-memory object we just
 * wrote would behave identically to a real one in every pipeline test here. It
 * would only misbehave in M4, a long way from the code that caused it. The test
 * `the read-back is a real read from disk` below mutates the file between the
 * write and the read-back — something no in-memory comparison can notice — and
 * asserts the claim is reported lost.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimItem,
  claimVerdict,
  forceReleaseClaim,
  releaseClaim,
} from '../../../src/orchestrator/claim.js';
import { serializeNote } from '../../../src/vault/note.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { MarkdownStorage } from '../../../src/vault/storage.js';
import { makeTicket } from '../../helpers/notes.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

/** Only the fields these assertions read. `Claimable` alone has no `status`. */
type Claimed = {
  readonly id: string;
  readonly status: string;
  readonly locked_by: string | null;
  readonly locked_at: string | null;
};

const OWNER = 'host-a/1001/2026-09-01T10:00:00.000Z';
const OTHER = 'host-b/2002/2026-09-01T10:00:00.000Z';
const NOW = '2026-09-01T10:05:00.000Z';

let root: string;
let paths: VaultPaths;
let storage: MarkdownStorage;
let file: string;

beforeEach(async () => {
  root = scratchDir('claim-');
  paths = new VaultPaths(root);
  storage = new MarkdownStorage(paths);
  file = paths.ticketPath('demo', 'FEAT-DEMO-T001');
  mkdirSync(paths.ticketsDir('demo'), { recursive: true });
  await storage.writeNote(file, makeTicket({ id: 'FEAT-DEMO-T001', feature: 'demo' }, '## History\n'));
});

afterEach(() => {
  removeScratchDir(root);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('claiming', () => {
  it('writes locked_by / locked_at and reads back as won', async () => {
    const outcome = await claimItem(storage, file, OWNER, { now: NOW });

    expect(outcome.won).toBe(true);
    expect(outcome.note.frontmatter.locked_by).toBe(OWNER);
    expect(outcome.note.frontmatter.locked_at).toBe(NOW);

    // And it is on disk, not only in the returned object.
    const onDisk = await storage.readNote<{ locked_by: string | null; locked_at: string | null }>(file);
    expect(onDisk.frontmatter.locked_by).toBe(OWNER);
    expect(onDisk.frontmatter.locked_at).toBe(NOW);
  });

  it('a note already held by somebody else is refused, with nothing written', async () => {
    await claimItem(storage, file, OTHER, { now: '2026-09-01T09:00:00.000Z' });
    const before = readFileSync(file, 'utf8');

    const outcome = await claimItem(storage, file, OWNER, { now: NOW });

    expect(outcome.won).toBe(false);
    expect(outcome.reason).toContain(OTHER);
    // A losing claim must leave no trace at all — a write here would bump
    // `updated_at` on somebody else's in-flight work.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('a claim whose read-back shows a different locked_by reports as lost, with no state change', async () => {
    const outcome = await claimItem<Claimed>(storage, file, OWNER, {
      now: NOW,
      // Somebody else's claim lands between our write and our read.
      afterWrite: async (target) => {
        const note = await storage.readNote<Record<string, unknown>>(target);
        writeFileSync(
          target,
          serializeNote({
            frontmatter: { ...note.frontmatter, locked_by: OTHER, locked_at: NOW },
            body: note.body,
          }),
          'utf8',
        );
      },
    });

    expect(outcome.won).toBe(false);
    expect(outcome.reason).toContain(OTHER);
    expect(outcome.note.frontmatter.locked_by).toBe(OTHER);
    // The status is untouched — a lost claim never advances anything.
    expect(outcome.note.frontmatter.status).toBe('backlog');
  });

  it('the read-back is a real read from disk, not a comparison with what we wrote', async () => {
    // Nothing about the *claim* changes here — only `locked_at` is altered on
    // disk, by one second. An implementation that compared its in-memory
    // `claimed` object against itself would report `won: true`; only a genuine
    // re-read can see the difference.
    const outcome = await claimItem(storage, file, OWNER, {
      now: NOW,
      afterWrite: async (target) => {
        const note = await storage.readNote<Record<string, unknown>>(target);
        writeFileSync(
          target,
          serializeNote({
            frontmatter: { ...note.frontmatter, locked_at: '2026-09-01T10:05:01.000Z' },
            body: note.body,
          }),
          'utf8',
        );
      },
    });

    expect(outcome.won).toBe(false);
    expect(outcome.reason).toContain('10:05:01');
  });

  it('re-claiming our own item is allowed — a retry after a crash is not a conflict', async () => {
    await claimItem(storage, file, OWNER, { now: '2026-09-01T09:00:00.000Z' });
    const again = await claimItem(storage, file, OWNER, { now: NOW });
    expect(again.won).toBe(true);
    expect(again.note.frontmatter.locked_at).toBe(NOW);
  });

  it('claiming preserves a human-authored frontmatter key', async () => {
    const note = await storage.readNote<Record<string, unknown>>(file);
    writeFileSync(
      file,
      serializeNote({ frontmatter: { ...note.frontmatter, owner: 'vishal' }, body: note.body }),
      'utf8',
    );

    await claimItem(storage, file, OWNER, { now: NOW });
    const after = await storage.readNote<Record<string, unknown>>(file);
    expect(after.frontmatter['owner']).toBe('vishal');
  });
});

describe('releasing', () => {
  it('release nulls both fields when the claim is ours', async () => {
    await claimItem(storage, file, OWNER, { now: NOW });
    expect(await releaseClaim(storage, file, OWNER)).toBe(true);

    const after = await storage.readNote<{ locked_by: string | null; locked_at: string | null }>(file);
    expect(after.frontmatter.locked_by).toBeNull();
    expect(after.frontmatter.locked_at).toBeNull();
  });

  it('release leaves somebody else\'s claim alone', async () => {
    await claimItem(storage, file, OTHER, { now: NOW });
    expect(await releaseClaim(storage, file, OWNER)).toBe(false);

    const after = await storage.readNote<{ locked_by: string | null }>(file);
    expect(after.frontmatter.locked_by).toBe(OTHER);
  });

  it('forceRelease clears a dead instance\'s claim', async () => {
    await claimItem(storage, file, OTHER, { now: NOW });
    expect(await forceReleaseClaim(storage, file)).toBe(true);
    const after = await storage.readNote<{ locked_by: string | null }>(file);
    expect(after.frontmatter.locked_by).toBeNull();
  });
});

describe('expiry at the top of a cycle', () => {
  const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
  const front = (overrides: Partial<{ locked_by: string | null; locked_at: string | null }> = {}) => ({
    id: 'FEAT-DEMO-T001',
    locked_by: OTHER,
    locked_at: '2026-09-01T11:59:00.000Z',
    ...overrides,
  });

  it('an unclaimed item is never expired', () => {
    expect(
      claimVerdict(front({ locked_by: null, locked_at: null }), {
        nowMs,
        lockTtlSec: 5400,
        isAlive: () => true,
      }).expired,
    ).toBe(false);
  });

  it('our own claim is never expired out from under us', () => {
    expect(
      claimVerdict(front({ locked_by: OWNER }), {
        nowMs,
        lockTtlSec: 1,
        isAlive: () => false,
        ownerId: OWNER,
      }).expired,
    ).toBe(false);
  });

  it('a fresh claim by a live owner survives', () => {
    expect(
      claimVerdict(front(), { nowMs, lockTtlSec: 5400, isAlive: () => true }).expired,
    ).toBe(false);
  });

  it('an expired claim is released at the top of the cycle', () => {
    const verdict = claimVerdict(front({ locked_at: '2026-09-01T10:00:00.000Z' }), {
      nowMs,
      lockTtlSec: 60,
      isAlive: () => true,
    });
    expect(verdict.expired).toBe(true);
    expect(verdict.expired && verdict.reason).toMatch(/lock_ttl/);
  });

  it('a claim by a dead owner is released regardless of its age', () => {
    // This is what makes crash recovery work without waiting out `lock_ttl`:
    // the claim below is one minute old against a 90-minute TTL.
    const verdict = claimVerdict(front(), { nowMs, lockTtlSec: 5400, isAlive: () => false });
    expect(verdict.expired).toBe(true);
    expect(verdict.expired && verdict.reason).toMatch(/no longer running/);
  });

  it('a claim with an unusable locked_at is released rather than held forever', () => {
    const verdict = claimVerdict(front({ locked_at: null }), {
      nowMs,
      lockTtlSec: 5400,
      isAlive: () => true,
    });
    expect(verdict.expired).toBe(true);
  });
});

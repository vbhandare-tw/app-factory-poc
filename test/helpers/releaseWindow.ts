/**
 * The claim-release window (dashboard plan Phase 8b).
 *
 * `dispatchItem` releases its claim in a `finally`, and the old release read the
 * note and wrote the whole of it back with the lock cleared. A human write that
 * landed between that read and that write was erased. `releaseWindow` puts a
 * human action in exactly that gap, and records every note write the dispatcher
 * makes so a test can check that the pause is its last one.
 */
import { expect } from 'vitest';

import type { Note } from '../../src/domain/types.js';
import type { DispatchHooks } from '../../src/orchestrator/dispatchTypes.js';
import type { Storage } from '../../src/vault/storage.js';

export interface RecordedWrite {
  readonly file: string;
  /** Copied at write time, so a later mutation cannot rewrite the record. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface ReleaseWindow {
  /** Give this to the dispatcher in place of the real storage. */
  readonly storage: Storage;
  /** Give these to the dispatcher: `after_persist` is what arms the plant. */
  readonly hooks: DispatchHooks;
  /** Every note write made through `storage`, in order. */
  readonly writes: RecordedWrite[];
  /** Whether the planted action ran. A plant that never fired proves nothing. */
  planted(): boolean;
}

/**
 * `plant` runs once, on the first read of `file` after the dispatcher's
 * `after_persist` point. Every pause path returns straight after that point, so
 * the only such read is the one `releaseClaim` makes before deciding to write:
 * the plant lands after the release's read and before its write.
 *
 * The plant should use the real storage, as the CLI or the dashboard would.
 */
export function releaseWindow(
  real: Storage,
  file: string,
  plant?: () => Promise<unknown>,
): ReleaseWindow {
  const writes: RecordedWrite[] = [];
  let armed = false;
  let fired = false;

  const storage: Storage = {
    listFeatures: () => real.listFeatures(),
    listTickets: (featureSlug) => real.listTickets(featureSlug),
    readNote: async <T>(path: string): Promise<Note<T>> => {
      const note = await real.readNote<T>(path);
      if (armed && path === file && plant !== undefined) {
        armed = false;
        fired = true;
        await plant();
      }
      return note;
    },
    writeNote: async <T>(path: string, note: Note<T>): Promise<void> => {
      writes.push({ file: path, frontmatter: { ...(note.frontmatter as Record<string, unknown>) } });
      await real.writeNote(path, note);
    },
    appendSection: (path, heading, md) => real.appendSection(path, heading, md),
    appendHistory: (path, line) => real.appendHistory(path, line),
  };

  return {
    storage,
    hooks: {
      crash: (point) => {
        if (point === 'after_persist') armed = true;
      },
    },
    writes,
    planted: () => fired,
  };
}

/** The pause dropped the claim itself, and the dispatcher never wrote the note after it. */
export function expectPauseDropsClaim(writes: readonly RecordedWrite[], file: string): void {
  const toNote = writes.filter((write) => write.file === file);
  const at = toNote.findIndex((write) => write.frontmatter['status'] === 'needs_human');
  expect(at, `the dispatcher never paused ${file}`).toBeGreaterThanOrEqual(0);
  expect(toNote[at]?.frontmatter, 'the pause write still carries the claim').toMatchObject({
    locked_by: null,
    locked_at: null,
  });
  expect(
    toNote.slice(at + 1).map((write) => write.frontmatter),
    'the dispatcher wrote the note again after pausing it',
  ).toEqual([]);
}

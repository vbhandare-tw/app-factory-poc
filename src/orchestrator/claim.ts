/**
 * The item claim (spec §7.4).
 *
 * `locked_by` / `locked_at` in a note's frontmatter, written atomically and
 * then **re-read from disk** to confirm the claim was won.
 *
 * ============================================================================
 * WHY THE READ-BACK MUST BE A REAL READ
 * ============================================================================
 * The obvious shortcut is to compare the value we just wrote against the object
 * we built. That comparison is always true, so the confirmation step becomes
 * decoration while still looking like a safety check.
 *
 * With `max_parallel_devs` pinned to 1 there is no second instance in M1–M3, so
 * no test at this scale could tell the two apart by outcome — the fake would
 * pass every pipeline test in this phase and only fail in M4, a long way from
 * the code that caused it. So the honesty of the read is proved directly
 * instead: `claim.test.ts` mutates the file between the write and the read-back
 * and asserts the claim is reported **lost**. A comparison against the
 * in-memory object cannot fail that test, which is the point.
 *
 * `afterWrite` exists solely for that test, exactly like `atomicWrite`'s
 * `beforeRename`. Production never passes it.
 *
 * ============================================================================
 * SPREAD, NEVER REBUILD
 * ============================================================================
 * Every frontmatter update here is `{...frontmatter, locked_by, locked_at}`.
 * `Note<T>` has no type slot for a human's own Obsidian-added keys, so a
 * field-by-field rebuild would delete them with no type error and no test
 * failure anywhere but the one that plants such a key deliberately.
 */
import type { LockFields } from '../domain/types.js';
import type { IsoTimestamp, Note } from '../domain/types.js';
import type { Storage } from '../vault/storage.js';
import { ownerPid } from './lock.js';
import type { LivenessCheck } from './lock.js';
import { defaultLiveness } from './lock.js';

/** The minimum shape a claimable note's frontmatter must have. */
export type Claimable = LockFields & { readonly id: string };

export interface ClaimOptions {
  readonly now: IsoTimestamp;
  /**
   * Test seam, called after the claim is written and before it is read back.
   * Production code never passes this — see the header note.
   */
  readonly afterWrite?: (file: string) => void | Promise<void>;
}

export interface ClaimOutcome<T extends Claimable> {
  readonly won: boolean;
  /** The note as it is on disk after the attempt. Never the in-memory guess. */
  readonly note: Note<T>;
  /** Present when `won` is false. Reaches the event log. */
  readonly reason?: string;
}

/**
 * Try to claim an item for `ownerId`.
 *
 * Refuses without writing when the note is already held by somebody else, so a
 * losing claim leaves no trace at all.
 */
export async function claimItem<T extends Claimable>(
  storage: Storage,
  file: string,
  ownerId: string,
  options: ClaimOptions,
): Promise<ClaimOutcome<T>> {
  const note = await storage.readNote<T>(file);
  const holder = note.frontmatter.locked_by;

  if (holder !== null && holder !== undefined && holder !== ownerId) {
    return {
      won: false,
      note,
      reason: `${note.frontmatter.id} is claimed by ${holder}`,
    };
  }

  const claimed: Note<T> = {
    frontmatter: { ...note.frontmatter, locked_by: ownerId, locked_at: options.now },
    body: note.body,
  };
  await storage.writeNote(file, claimed);

  if (options.afterWrite !== undefined) await options.afterWrite(file);

  // A genuine round trip through the filesystem. Comparing against `claimed`
  // here would make this function unable to ever report a lost claim.
  const readBack = await storage.readNote<T>(file);
  if (readBack.frontmatter.locked_by !== ownerId || readBack.frontmatter.locked_at !== options.now) {
    return {
      won: false,
      note: readBack,
      reason:
        `claim read-back on ${file} shows locked_by=${String(readBack.frontmatter.locked_by)} ` +
        `locked_at=${String(readBack.frontmatter.locked_at)}, not ${ownerId} at ${options.now}`,
    };
  }

  return { won: true, note: readBack };
}

/**
 * Drop our claim on an item.
 *
 * Re-reads first and leaves the note untouched if somebody else now holds it:
 * a release that blindly nulls the fields would let a slow instance stamp on a
 * fresh claim it knows nothing about.
 */
export async function releaseClaim<T extends Claimable>(
  storage: Storage,
  file: string,
  ownerId: string,
): Promise<boolean> {
  const note = await storage.readNote<T>(file);
  if (note.frontmatter.locked_by !== ownerId) return false;

  await storage.writeNote(file, {
    frontmatter: { ...note.frontmatter, locked_by: null, locked_at: null },
    body: note.body,
  });
  return true;
}

/** Unconditionally clear a claim. Used by the startup sweep for dead owners. */
export async function forceReleaseClaim<T extends Claimable>(
  storage: Storage,
  file: string,
): Promise<boolean> {
  const note = await storage.readNote<T>(file);
  if (note.frontmatter.locked_by === null || note.frontmatter.locked_by === undefined) return false;

  await storage.writeNote(file, {
    frontmatter: { ...note.frontmatter, locked_by: null, locked_at: null },
    body: note.body,
  });
  return true;
}

export interface ExpiryInput {
  /** Epoch milliseconds. */
  readonly nowMs: number;
  /** `config.lock_ttl`, in seconds. */
  readonly lockTtlSec: number;
  readonly isAlive?: LivenessCheck;
  /** The current instance's owner id. Its own claims are never expired. */
  readonly ownerId?: string;
}

export type ClaimVerdict =
  | { readonly expired: false }
  | { readonly expired: true; readonly reason: string };

/**
 * Should this claim be released at the top of a cycle?
 *
 * Two independent reasons, and the second is what makes crash recovery work
 * without waiting out `lock_ttl` (spec §9.1):
 *
 *  1. `locked_at` is older than `config.lock_ttl`.
 *  2. The owning **process is gone**. A claim written by an orchestrator that
 *     has since died is not held by anyone, whatever its age says. Without this
 *     a crash mid-dispatch would strand its item for the full TTL — 90 minutes
 *     by default — with a live orchestrator sitting next to it doing nothing.
 */
export function claimVerdict(frontmatter: Claimable, input: ExpiryInput): ClaimVerdict {
  const owner = frontmatter.locked_by;
  if (owner === null || owner === undefined) return { expired: false };
  if (input.ownerId !== undefined && owner === input.ownerId) return { expired: false };

  const pid = ownerPid(owner);
  const isAlive = input.isAlive ?? defaultLiveness;
  if (pid !== null && !isAlive(pid)) {
    return { expired: true, reason: `owner ${owner} is no longer running` };
  }

  const heldSince = frontmatter.locked_at === null ? Number.NaN : Date.parse(frontmatter.locked_at);
  if (Number.isNaN(heldSince)) {
    return { expired: true, reason: `owner ${owner} recorded no usable locked_at` };
  }

  const ageSec = Math.round((input.nowMs - heldSince) / 1000);
  if (ageSec > input.lockTtlSec) {
    return {
      expired: true,
      reason: `claim by ${owner} is ${ageSec}s old, past the ${input.lockTtlSec}s lock_ttl`,
    };
  }

  return { expired: false };
}

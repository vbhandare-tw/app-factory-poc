/**
 * The instance lock (spec §7.4).
 *
 * One orchestrator per vault. The lock file is created with the `wx` open flag,
 * which is the only genuinely atomic "create if absent" the filesystem offers —
 * a `existsSync` check followed by a write has a window between the two, and
 * that window is exactly when two `factory start` invocations race.
 *
 * A lock is **stale**, and therefore reclaimable, when either:
 *
 *  - its `heartbeatAt` is older than `3 × poll_interval`, or
 *  - `process.kill(pid, 0)` says the process is gone.
 *
 * Spec §7.4 chooses a heartbeat over the requirements document's 90-minute
 * `lock_ttl` deliberately: a crashed orchestrator must not block a restart for
 * an hour and a half. `lock_ttl` still governs *item* claims (`claim.ts`), which
 * is a different question — how long one piece of work may be held — from this
 * one, which is whether an orchestrator is alive at all.
 *
 * A lock file whose contents are not readable JSON is treated as stale rather
 * than fatal. It is evidence of a crash mid-write, and refusing to start
 * because of it would turn a recoverable situation into a permanent one that
 * only a human deleting a dotfile could fix.
 */
import { open, readFile, unlink } from 'node:fs/promises';

import type { EventSink } from '../log/events.js';
import { atomicWrite } from '../vault/atomic.js';
import type { VaultPaths } from '../vault/paths.js';

/** Spec §7.4: stale when the heartbeat is older than this many poll intervals. */
export const STALE_HEARTBEAT_MULTIPLIER = 3;

/** What `<vault>/.factory.lock` contains (spec §7.4). */
export interface InstanceLockRecord {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
}

/** Is this process still alive? Injected so staleness is testable without real PIDs. */
export type LivenessCheck = (pid: number) => boolean;

export const defaultLiveness: LivenessCheck = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user. That still
    // counts as alive — reclaiming its lock would put two orchestrators on one
    // vault, which is the single thing this file exists to prevent.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class InstanceLockHeldError extends Error {
  readonly record: InstanceLockRecord;
  readonly file: string;

  constructor(file: string, record: InstanceLockRecord) {
    super(
      `another factory instance holds ${file} (pid ${record.pid} on ${record.host}, last ` +
        `heartbeat ${record.heartbeatAt}). Stop it with \`factory stop\` before starting another; ` +
        'two orchestrators on one vault would claim the same work twice.',
    );
    this.name = 'InstanceLockHeldError';
    this.record = record;
    this.file = file;
  }
}

/** Why a lock is or is not reclaimable. The reason reaches the event log. */
export interface LockStaleness {
  readonly stale: boolean;
  readonly reason: string;
}

export interface StalenessInput {
  /** Epoch milliseconds. */
  readonly nowMs: number;
  readonly pollIntervalSec: number;
  readonly isAlive?: LivenessCheck;
}

/**
 * Decide whether a lock record may be taken over. Pure apart from the injected
 * liveness check, so every branch is testable.
 *
 * A record that is `null` — absent or unparseable — is stale by definition:
 * there is no evidence anybody holds the lock, and refusing to start on the
 * strength of an unreadable file would be worse than the risk it guards.
 */
export function evaluateLock(
  record: InstanceLockRecord | null,
  input: StalenessInput,
): LockStaleness {
  if (record === null) {
    return { stale: true, reason: 'the lock file is absent or not readable JSON' };
  }

  const isAlive = input.isAlive ?? defaultLiveness;
  if (!isAlive(record.pid)) {
    return { stale: true, reason: `pid ${record.pid} is no longer running` };
  }

  const beat = Date.parse(record.heartbeatAt);
  if (Number.isNaN(beat)) {
    return { stale: true, reason: `heartbeatAt ${JSON.stringify(record.heartbeatAt)} is not a date` };
  }

  const limitMs = STALE_HEARTBEAT_MULTIPLIER * input.pollIntervalSec * 1000;
  const ageMs = input.nowMs - beat;
  if (ageMs > limitMs) {
    return {
      stale: true,
      reason:
        `the last heartbeat was ${Math.round(ageMs / 1000)}s ago, past the ` +
        `${STALE_HEARTBEAT_MULTIPLIER} × ${input.pollIntervalSec}s limit`,
    };
  }

  return { stale: false, reason: `pid ${record.pid} is alive and heartbeating` };
}

/**
 * Read the lock file.
 *
 * Returns `null` for both "not there" and "not readable JSON", because the
 * caller treats them identically (see `evaluateLock`). `parsed` distinguishes
 * them for the event log.
 */
export async function readInstanceLock(
  file: string,
): Promise<{ record: InstanceLockRecord | null; present: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, present: false };
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { record: null, present: true };
    const candidate = parsed as Partial<InstanceLockRecord>;
    if (
      typeof candidate.pid !== 'number' ||
      !Number.isInteger(candidate.pid) ||
      typeof candidate.host !== 'string' ||
      typeof candidate.startedAt !== 'string' ||
      typeof candidate.heartbeatAt !== 'string'
    ) {
      return { record: null, present: true };
    }
    return { record: candidate as InstanceLockRecord, present: true };
  } catch {
    return { record: null, present: true };
  }
}

/**
 * The identity written into an item's `locked_by` (spec §7.4).
 *
 * It carries the pid so a *restarted* orchestrator can tell "this claim belongs
 * to an instance that no longer exists" from "this claim is mine" — which is
 * what makes crash recovery possible without waiting out `lock_ttl`. Slashes
 * rather than colons so the value stays readable in YAML without quoting games.
 */
export function ownerIdFor(record: InstanceLockRecord): string {
  return `${record.host}/${record.pid}/${record.startedAt}`;
}

/** The pid inside an owner id, or `null` when the value is not one of ours. */
export function ownerPid(ownerId: string): number | null {
  const parts = ownerId.split('/');
  if (parts.length !== 3) return null;
  const pid = Number(parts[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export interface AcquireOptions {
  readonly pollIntervalSec: number;
  readonly now?: () => string;
  readonly pid?: number;
  readonly host?: string;
  readonly isAlive?: LivenessCheck;
  readonly events?: EventSink;
}

export class InstanceLock {
  readonly file: string;
  readonly ownerId: string;
  private record: InstanceLockRecord;
  private readonly now: () => string;
  private released = false;
  private readonly writes = new Set<Promise<void>>();

  private constructor(file: string, record: InstanceLockRecord, now: () => string) {
    this.file = file;
    this.record = record;
    this.ownerId = ownerIdFor(record);
    this.now = now;
  }

  /** The record as last written. A copy — callers cannot edit the lock in place. */
  current(): InstanceLockRecord {
    return { ...this.record };
  }

  get isReleased(): boolean {
    return this.released;
  }

  /**
   * Take the lock, reclaiming a stale one.
   *
   * Bounded retries rather than a loop: each retry means somebody else created
   * the file between our unlink and our create, and at M1–M3's single-instance
   * scale more than a couple of those means something is wrong that spinning
   * will not fix.
   */
  static async acquire(paths: VaultPaths, options: AcquireOptions): Promise<InstanceLock> {
    const file = paths.instanceLock();
    const now = options.now ?? ((): string => new Date().toISOString());
    const pid = options.pid ?? process.pid;
    const host = options.host ?? hostName();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = now();
      const record: InstanceLockRecord = { pid, host, startedAt, heartbeatAt: startedAt };

      let handle;
      try {
        handle = await open(file, 'wx', 0o644);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        const existing = await readInstanceLock(file);
        const staleness = evaluateLock(existing.record, {
          nowMs: Date.parse(startedAt),
          pollIntervalSec: options.pollIntervalSec,
          ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
        });

        if (!staleness.stale && existing.record !== null) {
          throw new InstanceLockHeldError(file, existing.record);
        }

        await options.events?.emit({
          type: 'lock_reclaimed',
          file,
          reason: staleness.reason,
          previousPid: existing.record?.pid ?? null,
        });
        await unlink(file).catch(() => undefined);
        continue;
      }

      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await options.events?.emit({ type: 'lock_acquired', file, pid, host });
      return new InstanceLock(file, record, now);
    }

    throw new Error(
      `could not take the instance lock ${file} after three attempts — another process keeps ` +
        'recreating it. Check for a second `factory start` on this vault.',
    );
  }

  /**
   * Rewrite the record with a fresh `heartbeatAt` (spec §7.4, loop step 2, and
   * the orchestrator's heartbeat timer).
   *
   * Atomic, like every other vault write: a reader deciding whether we are
   * alive must never catch a half-written lock file and conclude we crashed.
   */
  async heartbeat(): Promise<void> {
    if (this.released) throw new Error(`instance lock ${this.file} has already been released`);
    this.record = { ...this.record, heartbeatAt: this.now() };
    const write = atomicWrite(this.file, `${JSON.stringify(this.record, null, 2)}\n`);
    this.writes.add(write);
    try {
      await write;
    } finally {
      this.writes.delete(write);
    }
  }

  /**
   * Remove the lock file, but only if it is still ours. Idempotent.
   *
   * Waits for any heartbeat write already in flight: its rename landing after
   * the unlink would recreate the lock for an instance that has gone.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await Promise.allSettled([...this.writes]);

    const existing = await readInstanceLock(this.file);
    if (existing.record !== null && ownerIdFor(existing.record) !== this.ownerId) return;
    await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
  }
}

function hostName(): string {
  // `os.hostname()` would be the obvious call, but the value is only ever read
  // by a human deciding which machine holds a lock, and an env-provided name is
  // both cheaper and injectable. Falls back to something that is never empty.
  return process.env['HOSTNAME'] ?? process.env['HOST'] ?? 'localhost';
}

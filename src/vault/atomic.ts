/**
 * Crash-safe file writes (spec §7.3).
 *
 * The whole no-database design of ADR-001 rests on this file. There are no
 * transactions, so "the vault is never corrupted" (plan Section E item 1) means
 * exactly one thing: a reader must only ever see a whole file, and a crash at
 * any instant must leave the previous whole file in place.
 *
 * IMPORTANT — this module must keep importing nothing but node builtins.
 * `test/helpers/crashDuringWrite.mjs` loads it directly by its `.ts` path under
 * Node's type stripping so it can be SIGKILLed mid-write; a cross-module import
 * would break that resolution and the crash test with it.
 */
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * `<file>.<pid>.<counter>.tmp` — the shape spec §7.3 specifies.
 *
 * The pid separates processes and the counter separates concurrent writes
 * inside one process, so two writers never fight over the same temp file.
 */
export const TEMP_NAME_PATTERN = /\.\d+\.\d+\.tmp$/;

let counter = 0;

/** The next temp path for `filePath`. Always in the same directory. */
export function nextTempPath(filePath: string): string {
  counter += 1;
  return `${filePath}.${process.pid}.${counter}.tmp`;
}

export interface AtomicWriteOptions {
  /**
   * Test seam, called after the temp file is written and fsynced but before the
   * rename. Production code never passes this. It exists because the failure
   * window this module defends is otherwise unreachable from a test.
   */
  readonly beforeRename?: (tempPath: string) => void | Promise<void>;
}

/**
 * Write `contents` to `filePath` so that a reader sees either the old file or
 * the new one, never a splice and never a truncated file.
 *
 * Temp file in the same directory (rename is only atomic within a filesystem),
 * fsync the file, rename, then fsync the directory so the rename itself is
 * durable rather than merely visible.
 */
export async function atomicWrite(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const temp = nextTempPath(target);

  const handle = await open(temp, 'wx', 0o644);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (options.beforeRename !== undefined) await options.beforeRename(temp);
    await rename(temp, target);
  } catch (error) {
    // Best effort. A caught error runs this; a SIGKILL does not, which is why
    // `sweepOrphanTemps` exists as the second line of defence.
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  await fsyncDirectory(directory);
}

export interface SweepOptions {
  /**
   * The current time, in epoch milliseconds.
   *
   * Required, not defaulted. `applyTransition` takes `now` injected for the
   * same reason: this is the only place in `src/vault` that would otherwise
   * read a clock, and a default would make "the vault layer reads no clock"
   * nearly true instead of true. The orchestrator owns the clock.
   */
  readonly now: number;
  /** Descend into subdirectories. Default true — a vault is a tree. */
  readonly recursive?: boolean;
}

/**
 * Delete orphan temp files left behind by a crashed write (spec §7.3).
 *
 * Only files matching `TEMP_NAME_PATTERN` are ever considered, and only those
 * older than `maxAgeMs`, so a write that is still in flight is never swept out
 * from under itself. Returns the paths removed, sorted, for the event log.
 */
export async function sweepOrphanTemps(
  directory: string,
  maxAgeMs: number,
  options: SweepOptions,
): Promise<string[]> {
  const { now } = options;
  const recursive = options.recursive ?? true;
  const removed: string[] = [];

  await sweep(path.resolve(directory), maxAgeMs, now, recursive, removed);
  removed.sort();
  return removed;
}

async function sweep(
  directory: string,
  maxAgeMs: number,
  now: number,
  recursive: boolean,
  removed: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isIgnorableFsError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await sweep(full, maxAgeMs, now, recursive, removed);
      continue;
    }
    if (!entry.isFile() || !TEMP_NAME_PATTERN.test(entry.name)) continue;

    try {
      const info = await stat(full);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await unlink(full);
      removed.push(full);
    } catch (error) {
      if (isIgnorableFsError(error)) continue;
      throw error;
    }
  }
}

function isIgnorableFsError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * fsync the directory so the rename survives a power cut, not just a crash.
 *
 * Verified to work on macOS 24.6. Platforms that refuse an fsync on a directory
 * handle are tolerated rather than fatal: losing the extra durability is far
 * better than failing every write.
 */
async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // EINVAL / EPERM / ENOTSUP on directory fsync — see the note above.
  } finally {
    await handle.close();
  }
}

/**
 * The running-agent registry (spec §12).
 *
 * `<vault>/.runs/<run-id>.json` is written when a child process is spawned and
 * deleted when it finishes. It is M7's only source for "what is running", and
 * it is also the orchestrator's own crash evidence: entries surviving a restart
 * are runs whose process died with the orchestrator.
 *
 * Written atomically for the same reason every vault write is — a reader
 * (dashboard, `factory status`) must never see half a JSON object. Entries are
 * cheap, so the cost of getting this right is close to zero.
 */
import { readdir, unlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Role } from '../domain/roles.js';
import { atomicWrite } from '../vault/atomic.js';
import type { VaultPaths } from '../vault/paths.js';

/** One in-flight run, exactly the field set spec §12 names. */
export interface RunEntry {
  readonly runId: string;
  readonly role: Role;
  /** Ticket id, or the feature id for feature-level roles. */
  readonly ticket: string;
  readonly feature: string;
  readonly attempt: number;
  /** Null when the child never spawned — the entry still records the attempt. */
  readonly pid: number | null;
  readonly startedAt: string;
  readonly logPath: string;
}

export interface RunSink {
  register(entry: RunEntry): Promise<void>;
  complete(runId: string): Promise<void>;
}

/** Is this process still alive? Injected so the sweep is testable without real PIDs. */
export type LivenessCheck = (pid: number) => boolean;

export const defaultLiveness: LivenessCheck = (pid: number): boolean => {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. EPERM means the process exists but belongs to another user,
    // which still counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class RunRegistry implements RunSink {
  private readonly paths: VaultPaths;
  private readonly isAlive: LivenessCheck;

  constructor(paths: VaultPaths, options: { isAlive?: LivenessCheck } = {}) {
    this.paths = paths;
    this.isAlive = options.isAlive ?? defaultLiveness;
  }

  /** Write `.runs/<run-id>.json`. Called immediately after the child spawns. */
  async register(entry: RunEntry): Promise<void> {
    const file = this.paths.runFile(entry.runId);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, `${JSON.stringify(entry, null, 2)}\n`);
  }

  /** Remove the entry. Idempotent: a double completion must not throw. */
  async complete(runId: string): Promise<void> {
    await unlink(this.paths.runFile(runId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      throw error;
    });
  }

  async list(): Promise<RunEntry[]> {
    const dir = this.paths.runsDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const entries: RunEntry[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(path.join(dir, name), 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        entries.push(JSON.parse(raw) as RunEntry);
      } catch {
        // A malformed entry is stale evidence, not a reason to refuse to start.
        // It is swept below like any other dead run.
        entries.push({
          runId: name.replace(/\.json$/, ''),
          role: 'developer',
          ticket: '',
          feature: '',
          attempt: 0,
          pid: null,
          startedAt: '',
          logPath: '',
        });
      }
    }
    return entries;
  }

  /**
   * Remove entries whose process is gone (spec §12, "swept at startup").
   *
   * An entry with a live PID is left alone. In M1–M3 the instance lock means
   * that can only be another vault's orchestrator, and deleting its entry would
   * make the dashboard lie about what is running.
   */
  async sweep(): Promise<RunEntry[]> {
    const swept: RunEntry[] = [];
    for (const entry of await this.list()) {
      if (entry.pid !== null && this.isAlive(entry.pid)) continue;
      await this.complete(entry.runId);
      swept.push(entry);
    }
    return swept;
  }
}

/** In-memory registry for unit tests and for runners built without a vault. */
export class MemoryRunRegistry implements RunSink {
  readonly live = new Map<string, RunEntry>();
  readonly registered: RunEntry[] = [];
  readonly completed: string[] = [];

  register(entry: RunEntry): Promise<void> {
    this.live.set(entry.runId, entry);
    this.registered.push(entry);
    return Promise.resolve();
  }

  complete(runId: string): Promise<void> {
    this.live.delete(runId);
    this.completed.push(runId);
    return Promise.resolve();
  }
}

/**
 * `factory projects` (spec §6) — what is registered, where its vault is, and
 * whether an orchestrator is running against it.
 *
 * "Running" is read from the instance lock (spec §7.4), which Phase 7a creates.
 * Until then no lock file ever exists and every project reads `stopped`, which
 * is the truth: nothing is running because nothing can start yet.
 */
import { readFileSync } from 'node:fs';

import type { ProjectEntry } from '../config/registry.js';
import { VaultPaths } from '../vault/paths.js';
import type { CliDeps } from './deps.js';

export type InstanceState = 'running' | 'stopped' | 'stale-lock';

export interface ProjectStatus {
  readonly name: string;
  readonly vault: string;
  readonly repo: string | null;
  readonly isDefault: boolean;
  readonly state: InstanceState;
  readonly pid: number | null;
}

export interface ProjectsOptions {
  readonly json?: boolean | undefined;
}

export async function runProjects(
  options: ProjectsOptions,
  deps: CliDeps,
): Promise<readonly ProjectStatus[]> {
  const registry = await deps.registry.read();
  const rows = registry.projects.map((project) => describe(project, project.name === registry.default));

  if (options.json === true) {
    deps.out(JSON.stringify({ default: registry.default, projects: rows }, null, 2));
    return rows;
  }

  if (rows.length === 0) {
    deps.out('No projects registered. Run `factory init --vault <path> --repo <path>` first.');
    return rows;
  }

  for (const row of rows) {
    const marker = row.isDefault ? '*' : ' ';
    deps.out(`${marker} ${row.name}  ${row.state}  ${row.vault}`);
  }
  return rows;
}

function describe(project: ProjectEntry, isDefault: boolean): ProjectStatus {
  const lock = readLock(project.vault);
  return {
    name: project.name,
    vault: project.vault,
    repo: project.repo,
    isDefault,
    state: lock === null ? 'stopped' : isAlive(lock.pid) ? 'running' : 'stale-lock',
    pid: lock?.pid ?? null,
  };
}

interface LockFile {
  readonly pid: number;
}

/** The instance lock, or `null` when there is none or it is unreadable. */
export function readLock(vaultPath: string): LockFile | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(new VaultPaths(vaultPath).instanceLock(), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const pid = (raw as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    return { pid };
  } catch {
    // A missing lock is the normal case; a malformed one is Phase 7a's problem
    // to report, and it must never stop `factory projects` from listing.
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

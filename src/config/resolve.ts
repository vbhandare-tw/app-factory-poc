/**
 * Which vault does this command operate on? (spec §6.1, requirements §3.1)
 *
 * Getting this wrong is the worst silent failure in the system: every command
 * downstream writes notes, moves branches and spawns agents against whatever
 * this function returns, and a wrong answer looks exactly like a right one until
 * real work lands in the wrong project.
 *
 * Two design rules follow from that:
 *
 * 1. **Step 1 is terminal.** If `--vault` is given it either resolves or errors.
 *    It never falls through to a later step. A typo'd `--vault` that quietly
 *    became "the registry default" would silently redirect an entire session
 *    onto a real project — the operator asked for a specific vault and got a
 *    different one with no warning. The same rule applies to an explicit project
 *    name: naming something and getting something else is never acceptable.
 * 2. **The filesystem arrives as an injected view.** Every one of the five
 *    branches, including "cwd is inside a vault" and "registry default", is then
 *    reachable from a unit test without a real home directory or a real cwd.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { VaultPaths } from '../vault/paths.js';
import type { ProjectEntry, RegistryData } from './registry.js';
import { EMPTY_REGISTRY } from './registry.js';

/**
 * A directory that marks its parent as belonging to a vault (spec §6.1 step 3).
 * Typically a symlink to the vault, dropped inside a target repo so that running
 * `factory status` from the repo just works.
 */
export const VAULT_MARKER_DIRNAME = '.factory-vault';

/** Which rule produced the answer. Recorded so `factory status` can explain itself. */
export type VaultSource = 'flag' | 'project' | 'cwd' | 'cwd-marker' | 'registry-default';

export interface VaultResolution {
  /** Absolute path to the vault root. */
  readonly vaultPath: string;
  readonly source: VaultSource;
  /** The registry name, when the vault was reached through one. */
  readonly projectName: string | null;
}

export interface ResolveInput {
  /** `--vault <path>`. */
  readonly vaultFlag?: string | undefined;
  /** The positional `[project]` argument. */
  readonly projectName?: string | undefined;
}

/**
 * The injected filesystem. Synchronous on purpose: resolution happens once at
 * startup, and a sync view is far easier to fake exhaustively in a test than a
 * promise-returning one.
 */
export interface ResolveView {
  /** The directory the command was invoked from. */
  cwd(): string;
  /** True when `dir` exists and is a directory. */
  isDirectory(dir: string): boolean;
  /** True when `dir` is a vault root — i.e. it holds a readable `config.yml`. */
  isVaultRoot(dir: string): boolean;
  /** The registry contents, already read. */
  readonly registry: RegistryData;
}

export type VaultResolutionCode =
  | 'flag_not_a_directory'
  | 'flag_not_a_vault'
  | 'project_unknown'
  | 'project_vault_missing'
  | 'default_unknown'
  | 'default_vault_missing'
  | 'no_vault';

export class VaultResolutionError extends Error {
  readonly code: VaultResolutionCode;
  /** Registry project names, so the message can list what *is* available. */
  readonly knownProjects: readonly string[];

  constructor(code: VaultResolutionCode, message: string, knownProjects: readonly string[] = []) {
    super(message);
    this.name = 'VaultResolutionError';
    this.code = code;
    this.knownProjects = knownProjects;
  }
}

export function resolveVault(input: ResolveInput, view: ResolveView): VaultResolution {
  const registry = view.registry ?? EMPTY_REGISTRY;
  const names = registry.projects.map((project) => project.name);

  // --- 1. `--vault <path>` — terminal, never falls through ------------------
  const flag = input.vaultFlag;
  if (flag !== undefined && flag.trim() !== '') {
    const vaultPath = path.resolve(flag);
    if (!view.isDirectory(vaultPath)) {
      throw new VaultResolutionError(
        'flag_not_a_directory',
        `--vault ${vaultPath} is not a directory. Check the path, or run \`factory init --vault ${vaultPath} --repo <repo>\` to create it.`,
        names,
      );
    }
    if (!view.isVaultRoot(vaultPath)) {
      throw new VaultResolutionError(
        'flag_not_a_vault',
        `--vault ${vaultPath} has no config.yml, so it is not a factory vault. Refusing to fall back to a registered project: you named a vault, and running against a different one silently would be worse than stopping.`,
        names,
      );
    }
    return { vaultPath, source: 'flag', projectName: nameForVault(registry, vaultPath) };
  }

  // --- 2. `[project]` name in the registry — also terminal -------------------
  const wanted = input.projectName;
  if (wanted !== undefined && wanted.trim() !== '') {
    const entry = registry.projects.find((project) => project.name === wanted);
    if (entry === undefined) {
      throw new VaultResolutionError(
        'project_unknown',
        `no registered project named ${JSON.stringify(wanted)}. ${describeKnown(names)}`,
        names,
      );
    }
    assertRegisteredVaultUsable(view, entry, 'project_vault_missing', names);
    return { vaultPath: entry.vault, source: 'project', projectName: entry.name };
  }

  // --- 3. cwd is inside a vault, or holds a `.factory-vault/` marker --------
  const fromCwd = searchUpwards(view);
  if (fromCwd !== undefined) return fromCwd;

  // --- 4. the registry `default` --------------------------------------------
  if (registry.default !== null) {
    const entry = registry.projects.find((project) => project.name === registry.default);
    if (entry === undefined) {
      throw new VaultResolutionError(
        'default_unknown',
        `the registry names ${JSON.stringify(registry.default)} as the default project, but no such project is registered. ${describeKnown(names)}`,
        names,
      );
    }
    assertRegisteredVaultUsable(view, entry, 'default_vault_missing', names);
    return { vaultPath: entry.vault, source: 'registry-default', projectName: entry.name };
  }

  // --- 5. nothing matched ----------------------------------------------------
  throw new VaultResolutionError(
    'no_vault',
    `could not work out which vault to use. Pass --vault <path>, name a project, or run from inside a vault. ${describeKnown(names)}`,
    names,
  );
}

/**
 * Walk from cwd to the filesystem root. At each level the directory itself wins
 * over its `.factory-vault/` marker, and a nearer ancestor wins over a further
 * one — the vault you are standing in beats the one your parent points at.
 */
function searchUpwards(view: ResolveView): VaultResolution | undefined {
  let dir = path.resolve(view.cwd());

  for (;;) {
    if (view.isVaultRoot(dir)) {
      return { vaultPath: dir, source: 'cwd', projectName: nameForVault(view.registry, dir) };
    }

    const marker = path.join(dir, VAULT_MARKER_DIRNAME);
    if (view.isDirectory(marker) && view.isVaultRoot(marker)) {
      return {
        vaultPath: marker,
        source: 'cwd-marker',
        projectName: nameForVault(view.registry, marker),
      };
    }

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A registry entry pointing at a directory that is gone, or that is no longer a
 * vault, is an error rather than a reason to try the next rule. A stale entry
 * silently skipped is the same failure mode as a typo'd `--vault`.
 */
function assertRegisteredVaultUsable(
  view: ResolveView,
  entry: ProjectEntry,
  code: 'project_vault_missing' | 'default_vault_missing',
  names: readonly string[],
): void {
  if (view.isDirectory(entry.vault) && view.isVaultRoot(entry.vault)) return;
  throw new VaultResolutionError(
    code,
    `project ${JSON.stringify(entry.name)} points at ${entry.vault}, which is not a factory vault (no config.yml). The registry entry is stale — re-run \`factory init\`, or edit the registry.`,
    names,
  );
}

function nameForVault(registry: RegistryData, vaultPath: string): string | null {
  const resolved = path.resolve(vaultPath);
  return registry.projects.find((project) => project.vault === resolved)?.name ?? null;
}

function describeKnown(names: readonly string[]): string {
  if (names.length === 0) return 'No projects are registered yet — run `factory init` first.';
  return `Registered projects: ${names.join(', ')}.`;
}

/**
 * The real filesystem, wired into the view `resolveVault` consumes. The CLI is
 * the only caller; tests build their own view so no test ever depends on the
 * process's actual cwd or the operator's real home.
 */
export function nodeResolveView(cwd: string, registry: RegistryData): ResolveView {
  return {
    cwd: () => cwd,
    isDirectory: (dir) => isDirectorySync(dir),
    isVaultRoot: (dir) => {
      if (!isDirectorySync(dir)) return false;
      return isFileSync(new VaultPaths(dir).configFile());
    },
    registry,
  };
}

function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFileSync(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

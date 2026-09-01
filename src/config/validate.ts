/**
 * Startup validation (spec §11.1).
 *
 * Everything checked here is cheap, and every one of these failures would
 * otherwise surface halfway through a run — after an agent has been paid for,
 * a worktree created, or a branch cut. Fail fast, before any of that.
 *
 * **It returns a list; it never throws on the first problem.** A vault whose
 * repo is missing *and* whose base branch is wrong should say both. Someone
 * fixing a broken setup one error per run is the same avoidable loop that
 * `ConfigError` exists to prevent for `config.yml`.
 *
 * **Two checks from spec §11.1 are deliberately absent**, because the code they
 * need does not exist yet and inventing a stub would be worse than the gap:
 *
 * - *"a sandboxed probe run of `gates.tests` inside a scratch worktree"* needs
 *   the runner (Phase 5) and worktrees (Phase 8). What is checked instead is
 *   that each gate command **resolves** — the executable is findable — which
 *   catches the common `gates.tests: "pnpm test"` on a machine with no pnpm.
 * - *"instance lock acquired"* is Phase 7a's `src/orchestrator/lock.ts`.
 *
 * Both are listed in the plan's Phase 5 and 7a blocks. This file must gain them
 * then; until it does, a green `validateStartup` does not mean the gates run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { VaultPaths } from '../vault/paths.js';
import type { FactoryConfig } from './schema.js';
import { SUPPORTED_VAULT_VERSION } from './schema.js';

/** The git ref that binds a repo to exactly one vault (spec §6, §11.1). */
export const OWNER_REF = 'refs/factory/owner';

const OWNER_BLOB_KEY = 'factory-vault';

export type StartupFailureCode =
  | 'vault_missing'
  | 'config_missing'
  | 'vault_version_unsupported'
  | 'target_repo_missing'
  | 'target_repo_not_git'
  | 'base_branch_missing'
  | 'gate_command_unresolvable'
  | 'owner_ref_mismatch';

export interface StartupFailure {
  readonly code: StartupFailureCode;
  /** The config key or subject the failure is about, e.g. `gates.lint`. */
  readonly key: string;
  readonly message: string;
}

export interface StartupInput {
  readonly vaultPath: string;
  readonly config: FactoryConfig;
}

export interface StartupDeps {
  /** Environment used for `PATH` lookups. */
  readonly env?: NodeJS.ProcessEnv;
}

export function validateStartup(input: StartupInput, deps: StartupDeps = {}): StartupFailure[] {
  const failures: StartupFailure[] = [];
  const env = deps.env ?? process.env;

  const vaultPath = path.resolve(input.vaultPath);
  const config = input.config;

  // --- the vault itself ------------------------------------------------------
  if (!isDirectory(vaultPath)) {
    failures.push({
      code: 'vault_missing',
      key: 'vault',
      message: `vault directory ${vaultPath} does not exist`,
    });
  } else if (!isFile(new VaultPaths(vaultPath).configFile())) {
    failures.push({
      code: 'config_missing',
      key: 'vault',
      message: `${vaultPath} has no config.yml, so it is not a factory vault`,
    });
  }

  if (config.vault_version !== SUPPORTED_VAULT_VERSION) {
    failures.push({
      code: 'vault_version_unsupported',
      key: 'vault_version',
      message: `vault_version ${config.vault_version} is not supported by this build, which understands version ${SUPPORTED_VAULT_VERSION}`,
    });
  }

  // --- the target repo -------------------------------------------------------
  const repo = path.resolve(config.target_repo);
  const repoIsDirectory = isDirectory(repo);
  let repoIsGit = false;

  if (!repoIsDirectory) {
    failures.push({
      code: 'target_repo_missing',
      key: 'target_repo',
      message: `target_repo ${repo} does not exist. The vault is bound to a repo that is not there — it was moved, renamed, or deleted.`,
    });
  } else {
    repoIsGit = isGitRepo(repo);
    if (!repoIsGit) {
      failures.push({
        code: 'target_repo_not_git',
        key: 'target_repo',
        message: `target_repo ${repo} exists but is not a git repository (no git directory found by \`git rev-parse\`). The factory works by cutting branches and worktrees, so an unversioned directory cannot be a target.`,
      });
    }
  }

  // --- the base branch -------------------------------------------------------
  if (repoIsGit && !branchExists(repo, config.base_branch)) {
    const branches = listBranches(repo);
    failures.push({
      code: 'base_branch_missing',
      key: 'base_branch',
      message: `base_branch ${JSON.stringify(config.base_branch)} does not exist in ${repo}. ${
        branches.length === 0
          ? 'That repo has no branches at all — it may have no commits yet.'
          : `Branches that do exist: ${branches.join(', ')}.`
      }`,
    });
  }

  // --- the gate commands -----------------------------------------------------
  for (const [gate, command] of Object.entries(config.gates)) {
    const resolution = resolveCommand(command, repoIsDirectory ? repo : process.cwd(), env);
    if (resolution.ok) continue;
    failures.push({
      code: 'gate_command_unresolvable',
      key: `gates.${gate}`,
      message: `gates.${gate} is ${JSON.stringify(command)} but ${resolution.reason}. A gate that cannot start is a gate that can never go green.`,
    });
  }

  // --- the owner ref ---------------------------------------------------------
  if (repoIsGit) {
    const owner = readOwnerRef(repo);
    // Both sides canonicalised: a symlinked spelling of this very vault must
    // not read as a foreign owner. See `canonicalPath`.
    if (owner !== null && canonicalPath(owner) !== canonicalPath(vaultPath)) {
      failures.push({
        code: 'owner_ref_mismatch',
        key: 'target_repo',
        message: `${repo} is already owned by the vault at ${owner}, not by ${vaultPath}. Two vaults driving one repo would cut branches and merge over each other; delete ${OWNER_REF} in that repo if the other vault is gone.`,
      });
    }
  }

  return failures;
}

/** A one-line summary for the CLI. Empty list in, empty string out. */
export function describeFailures(failures: readonly StartupFailure[]): string {
  if (failures.length === 0) return '';
  const lines = failures.map((failure) => `  - ${failure.key}: ${failure.message}`);
  return `startup validation failed (${failures.length} ${
    failures.length === 1 ? 'problem' : 'problems'
  }):\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The owner ref.
//
// Stored as a blob rather than a commit: the payload is one line of text, and a
// ref pointing at a blob is a normal, `gc`-safe way to keep it. `git cat-file -p
// refs/factory/owner` prints it, so a human can see who owns a repo without any
// factory tooling.
// ---------------------------------------------------------------------------

/** The vault path recorded in `refs/factory/owner`, or `null` when unset. */
export function readOwnerRef(repo: string): string | null {
  const result = git(repo, ['cat-file', '-p', OWNER_REF]);
  if (result.status !== 0) return null;

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith(`${OWNER_BLOB_KEY}:`)) {
      return trimmed.slice(OWNER_BLOB_KEY.length + 1).trim();
    }
  }
  return null;
}

/** Bind `repo` to `vaultPath`. Overwrites any existing marker. */
export function writeOwnerRef(repo: string, vaultPath: string): void {
  const payload =
    `# Written by \`factory init\`. This repo is driven by exactly one vault.\n` +
    `${OWNER_BLOB_KEY}: ${path.resolve(vaultPath)}\n`;

  const hashed = spawnSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
    input: payload,
    encoding: 'utf8',
  });
  if (hashed.status !== 0) {
    throw new Error(`could not write the owner marker blob in ${repo}: ${hashed.stderr.trim()}`);
  }

  const sha = hashed.stdout.trim();
  const updated = git(repo, ['update-ref', OWNER_REF, sha]);
  if (updated.status !== 0) {
    throw new Error(`could not set ${OWNER_REF} in ${repo}: ${updated.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Small probes.
// ---------------------------------------------------------------------------

/**
 * Is `dir` the **root** of a git repository?
 *
 * Not `rev-parse --git-dir`, which succeeds anywhere *inside* a repo. That
 * distinction is not pedantic: a `target_repo` pointing at a subdirectory of
 * some larger repo would pass, and then every branch, worktree and merge the
 * factory made would land on the enclosing repository instead — silently, and
 * with the blast radius of whatever that repo is. Compare the toplevel git
 * reports against the path we were given, through `realpath` so that macOS's
 * `/var` → `/private/var` symlink does not make an identical path look
 * different.
 */
export function isGitRepo(dir: string): boolean {
  const result = git(dir, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return false;

  const toplevel = result.stdout.trim();
  if (toplevel === '') return false;

  return canonicalPath(toplevel) === canonicalPath(dir);
}

/**
 * A path reduced to one spelling, so two names for the same directory compare
 * equal.
 *
 * `path.resolve` is not enough: it makes a path absolute but never follows a
 * symlink, so `/tmp/v` and `/private/tmp/v` stay different strings on macOS,
 * where `/tmp` is a symlink. Every comparison of "is this the same directory"
 * in this module goes through here — the repo-root check *and* both sides of
 * the owner-ref check. Getting that wrong on the owner ref fails closed: a
 * vault is told its own repo belongs to somebody else and refuses to start.
 *
 * Falls back to `path.resolve` when the path does not exist yet, which is the
 * normal case for a vault `factory init` is about to create.
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

export function listBranches(repo: string): string[] {
  const result = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The branch `HEAD` points at, or `null` on a detached or empty repo. */
export function currentBranch(repo: string): string | null {
  const result = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch === '' ? null : branch;
}

interface CommandResolution {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Can the first word of `command` actually be executed?
 *
 * Not "does the command succeed" — that is the sandboxed probe run this phase
 * does not build. This catches the cheap, common case: a gate configured for a
 * tool that is not installed, or a script path that does not exist.
 */
export function resolveCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandResolution {
  const argv = splitCommand(command);
  const exe = argv[0];

  if (exe === undefined) {
    return { ok: false, reason: 'the command is empty' };
  }

  if (exe.includes('/')) {
    const target = path.resolve(cwd, exe);
    if (!existsSync(target)) {
      return { ok: false, reason: `${target} does not exist` };
    }
    return { ok: true, reason: '' };
  }

  const pathValue = env['PATH'] ?? '';
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry === '') continue;
    const candidate = path.join(entry, exe);
    if (existsSync(candidate) && !isDirectory(candidate)) {
      return { ok: true, reason: '' };
    }
  }

  return { ok: false, reason: `${JSON.stringify(exe)} was not found on PATH` };
}

/**
 * Split a command into argv, honouring single and double quotes.
 *
 * Only the first word is used, but quotes still have to be understood or
 * `"./my scripts/test.sh" --fast` would resolve the wrong thing.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }

  if (started) argv.push(current);
  return argv;
}

function git(cwd: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

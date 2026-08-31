import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TOY_APP_FIXTURE = path.join(PROJECT_ROOT, 'fixtures', 'toy-app');

/**
 * Where disposable toy repos live.
 *
 * Deliberately **not** `os.tmpdir()`. The sandbox's default write allowlist
 * covers `$TMPDIR` and `/tmp/claude*` (spec §4.2), so a git worktree created
 * next to a repo that lives under a temp path would be silently unfenced —
 * exactly the failure plan Section E item 7 forbids. Phase 8 puts ticket
 * worktrees at `<repo>/../.factory-worktrees/`, i.e. a sibling of whatever
 * directory this returns, so this must be a normal path.
 *
 * Override with `FACTORY_TEST_ROOT` if a different location is needed.
 */
export function testRepoRoot(): string {
  return process.env['FACTORY_TEST_ROOT'] ?? path.join(PROJECT_ROOT, '.factory-test-repos');
}

export interface ToyRepo {
  /** Absolute path to the git repo. */
  readonly path: string;
  /** The branch the initial commit landed on. */
  readonly branch: string;
  /** Remove the repo from disk. Idempotent. */
  cleanup(): void;
}

const GIT_IDENTITY = [
  '-c',
  'user.name=Factory Test',
  '-c',
  'user.email=factory-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command in a directory and capture its exit code and output. */
export function run(cwd: string, command: string, args: readonly string[]): RunResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Run `git` in a repo with a fixed identity, throwing on failure. */
export function git(cwd: string, args: readonly string[]): string {
  const result = run(cwd, 'git', [...GIT_IDENTITY, ...args]);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd} (exit ${result.status})\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

const liveRepos = new Set<ToyRepo>();

/**
 * Copy `fixtures/toy-app` to a fresh directory, `git init` it, and make one
 * initial commit. Every call returns an independent repo.
 */
export function toyRepo(options: { branch?: string } = {}): ToyRepo {
  const branch = options.branch ?? 'main';
  const root = testRepoRoot();
  mkdirSync(root, { recursive: true });
  const repoPath = mkdtempSync(path.join(root, 'toy-app-'));

  cpSyncFiltered(TOY_APP_FIXTURE, repoPath);

  git(repoPath, ['init', '-b', branch, '--quiet']);
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'chore: initial toy app']);

  const repo: ToyRepo = {
    path: repoPath,
    branch,
    cleanup(): void {
      rmSync(repoPath, { recursive: true, force: true });
      liveRepos.delete(repo);
    },
  };
  liveRepos.add(repo);
  return repo;
}

/** Remove every toy repo this process created. Safe to call more than once. */
export function cleanupAllToyRepos(): void {
  for (const repo of [...liveRepos]) {
    repo.cleanup();
  }
}

/**
 * Copy the fixture without any generated output. `node_modules` and `dist` are
 * excluded so a repo is always a clean checkout, no matter what a previous run
 * left behind in the fixture directory.
 */
function cpSyncFiltered(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (source: string): boolean => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'dist';
    },
  });
  if (!existsSync(path.join(to, 'package.json'))) {
    throw new Error(`toy-app fixture did not copy correctly into ${to}`);
  }
}

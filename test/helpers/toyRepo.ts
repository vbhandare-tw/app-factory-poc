import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
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
  const root = process.env['FACTORY_TEST_ROOT'] ?? path.join(PROJECT_ROOT, '.factory-test-repos');
  assertNotUnderTempRoot(root);
  return root;
}

/**
 * The runtime half of the rule above. `FACTORY_TEST_ROOT` is an escape hatch,
 * and the one escape it must not permit is a temp path — see the comment on
 * `testRepoRoot`. Fail loudly here rather than silently unfencing Phase 8.
 */
function assertNotUnderTempRoot(candidate: string): void {
  const resolved = path.resolve(candidate);
  const tempRoots = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders']
    .map((dir) => path.resolve(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);

  for (const tempRoot of tempRoots) {
    if (resolved === tempRoot || resolved.startsWith(`${tempRoot}${path.sep}`)) {
      throw new Error(
        `test repo root ${resolved} is under the temp path ${tempRoot}. The sandbox write ` +
          'allowlist covers $TMPDIR and /tmp/claude*, so worktrees created there are silently ' +
          'unfenced (spec §4.2, plan Section E item 7). Point FACTORY_TEST_ROOT somewhere else.',
      );
    }
  }
}

const liveScratchDirs = new Set<string>();

/**
 * A disposable directory under the same non-temp root as the toy repos.
 *
 * Vault tests need a writable scratch tree and must obey the same rule as the
 * git fixtures: never `os.tmpdir()`. Sharing `testRepoRoot()` means there is
 * one location to reason about and one `.gitignore` entry covering it.
 */
export function scratchDir(prefix = 'scratch-'): string {
  const root = testRepoRoot();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, prefix));
  liveScratchDirs.add(dir);
  return dir;
}

/** Remove one scratch directory. Idempotent. */
export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  liveScratchDirs.delete(dir);
}

/** Remove every scratch directory this process created. Safe to call twice. */
export function cleanupAllScratchDirs(): void {
  for (const dir of [...liveScratchDirs]) removeScratchDir(dir);
}

/**
 * A disposable factory home — the directory that stands in for `~/.app-factory`.
 *
 * This is the sibling of `assertNotUnderTempRoot`, and it guards a failure that
 * is even quieter. `src/config/registry.ts` reads and writes
 * `~/.app-factory/projects.yml`. A test that reaches the real one **passes**: it
 * passes here, it passes twice in a row, and it keeps passing while it rewrites
 * the operator's own registry and leaves state that makes the next run behave
 * differently. Nothing goes red. So the location is fenced structurally instead.
 *
 * Note what is *not* checked: "is this path under `os.homedir()`". It cannot be
 * — this project itself lives under the home directory, so that rule would
 * reject every legitimate scratch path. The real hazard is narrower and is what
 * is checked here: the path must not be, or be inside, either factory home.
 */
export function realFactoryHome(): string {
  return path.join(os.homedir(), '.app-factory');
}

/**
 * The directory we used to default to, and which on this machine belongs to a
 * **different tool** — Factory.ai's CLI keeps `auth.json`, `settings.json`,
 * `sessions/` and `mcp.json` in it. We renamed away from it, and the fence
 * keeps refusing it so a stray default can never reach either tool's directory.
 */
export function foreignFactoryHome(): string {
  return path.join(os.homedir(), '.factory');
}

export function assertNotRealFactoryHome(candidate: string): void {
  const resolved = path.resolve(candidate);

  for (const [label, home] of [
    ["the factory's own", realFactoryHome()],
    ["another tool's", foreignFactoryHome()],
  ] as const) {
    const real = path.resolve(home);
    if (resolved === real || resolved.startsWith(`${real}${path.sep}`)) {
      throw new Error(
        `refusing to use ${resolved} as a test factory home: it is ${label} real ${real}. ` +
          'A test that writes there passes while clobbering a real directory, so the location ' +
          'is fenced here rather than trusted. Use scratchFactoryHome().',
      );
    }
  }
}

/**
 * A scratch `~/.app-factory` under the same non-temp root as the toy repos,
 * checked against both real ones. Pass the returned path as `FACTORY_HOME`, or
 * straight into `new ProjectRegistry(...)`.
 */
export function scratchFactoryHome(prefix = 'factory-home-'): string {
  const dir = scratchDir(prefix);
  assertNotRealFactoryHome(dir);
  return dir;
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

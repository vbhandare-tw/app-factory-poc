/**
 * Worktree provisioning against real git and a disposable repo (plan Phase 8).
 *
 * ============================================================================
 * WHAT THE `npm test` CASE IS FOR
 * ============================================================================
 * Resolution A3: a fresh `git worktree` has no `node_modules` (it is untracked)
 * and a sandboxed agent has no network to install any, so the Developer's very
 * first `npm test` fails for a reason that has nothing to do with its code.
 * The fix was to have the orchestrator run `config.setup_command` in the new
 * worktree, unsandboxed, before any agent sees it.
 *
 * The stock toy app **cannot prove that fix works** — it has zero dependencies,
 * so `npm ci` installs nothing and `npm test` passes either way. So these tests
 * run against a repo with a vendored local dependency and a test that imports
 * it (`vendorDependency`), and assert both directions: red without the setup
 * step, green with it. Without the red half the green half means nothing.
 *
 * ============================================================================
 * WHERE THE WORKTREES GO
 * ============================================================================
 * `.factory-test-repos/.factory-worktrees/...` — the real layout (spec §10),
 * under the same non-temp root as every other fixture. Never a temp path:
 * `$TMPDIR` and `/tmp/claude*` are on the sandbox's default write allowlist, so
 * a worktree there is silently unfenced (plan Section E item 7).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ExecResult } from '../../src/git/exec.js';
import { ShellGit } from '../../src/git/git.js';
import {
  UnsafeWorktreePathError,
  vaultWorktreeName,
  worktreeRoot,
} from '../../src/git/paths.js';
import {
  destroyWorktree,
  ForeignWorktreeError,
  provisionScratchWorktree,
  provisionWorktree,
  SetupCommandFailedError,
  worktreeOwner,
} from '../../src/git/worktree.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  run,
  testRepoRoot,
  toyRepo,
  vendorDependency,
} from '../helpers/toyRepo.js';
import type { ToyRepo } from '../helpers/toyRepo.js';

/**
 * A distinct vault name per arena.
 *
 * These pass a raw name straight to `worktreeRoot`, bypassing
 * `vaultWorktreeName`'s salt — every toy repo here shares one parent directory,
 * so two arenas naming their vault the same thing would share
 * `<parent>/.factory-worktrees/<name>/` and fight over `FEAT-SAMPLE-T001`.
 *
 * Production cannot do that: `vaultWorktreeName` salts the name with a hash of
 * the vault's absolute path, so two vaults never share a root however they are
 * named. That is asserted below, and the destructive primitive refuses a
 * foreign worktree regardless.
 */
let vaultSeq = 0;
const FEATURE_BRANCH = 'feature/sample';
/** Any non-temp repo location — the salt cases never touch the filesystem. */
const REPO_FOR_SALT = path.join(testRepoRoot(), 'salt-repo');
const SETUP = 'npm ci --no-audit --no-fund --offline';
const SETUP_TIMEOUT_MS = 300_000;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

interface Arena {
  readonly repo: ToyRepo;
  readonly git: ShellGit;
  readonly vault: string;
}

function arena(options: { withDependency?: boolean } = {}): Arena {
  const repo = toyRepo();
  if (options.withDependency === true) vendorDependency(repo.path);
  git(repo.path, ['branch', FEATURE_BRANCH, repo.branch]);
  vaultSeq += 1;
  const vault = `wt-vault-${vaultSeq}`;
  roots.push(worktreeRoot(repo.path, vault));
  return { repo, git: new ShellGit({ repoRoot: repo.path }), vault };
}

function provision(a: Arena, ticketId: string, title = 'Add a thing', extra = {}) {
  return provisionWorktree({
    git: a.git,
    repoRoot: a.repo.path,
    vaultName: a.vault,
    ticketId,
    featureSlug: 'sample',
    title,
    fromRef: FEATURE_BRANCH,
    setupCommand: SETUP,
    setupTimeoutMs: SETUP_TIMEOUT_MS,
    ...extra,
  });
}

describe('provisionWorktree', () => {
  it('creates the worktree on its own branch, cut from the feature branch', async () => {
    const a = arena();
    const result = await provision(a, 'FEAT-SAMPLE-T001', 'Add login form');

    expect(existsSync(result.path)).toBe(true);
    expect(result.branch).toBe('feat/sample/t001-add-login-form');

    // The branch git actually checked out, not the one we asked for.
    expect(git(result.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(result.branch);

    // Cut from the feature branch, not from base: the merge-base of the new
    // branch and the feature branch is the feature branch's own tip.
    const featureTip = git(a.repo.path, ['rev-parse', FEATURE_BRANCH]).trim();
    const mergeBase = git(a.repo.path, ['merge-base', result.branch, FEATURE_BRANCH]).trim();
    expect(mergeBase).toBe(featureTip);
  });

  it('lands outside the repo and outside any temp path', async () => {
    const a = arena();
    const result = await provision(a, 'FEAT-SAMPLE-T001');

    expect(result.path.startsWith(`${path.resolve(a.repo.path)}${path.sep}`)).toBe(false);
    for (const temp of ['/tmp', '/private/tmp', os.tmpdir()]) {
      expect(result.path.startsWith(`${path.resolve(temp)}${path.sep}`)).toBe(false);
    }
  });

  it('installs dependencies, so node_modules exists afterwards (resolution A3)', async () => {
    const a = arena({ withDependency: true });
    const result = await provision(a, 'FEAT-SAMPLE-T001');

    expect(result.setup.ran).toBe(true);
    expect(result.setup.ok).toBe(true);
    expect(existsSync(path.join(result.path, 'node_modules'))).toBe(true);
    expect(existsSync(path.join(result.path, 'node_modules', 'toy-dep'))).toBe(true);
  });

  it('and `npm test` passes inside the fresh worktree — the point of A3', async () => {
    const a = arena({ withDependency: true });
    const result = await provision(a, 'FEAT-SAMPLE-T001');

    const tests = run(result.path, 'npm', ['test']);
    expect(tests.status, `npm test failed:\n${tests.stderr}${tests.stdout}`).toBe(0);
  });

  it('and the same worktree without the setup step fails it — the red half', async () => {
    // Without this case the green one above proves only that `npm test` works,
    // not that provisioning is what makes it work.
    const a = arena({ withDependency: true });
    const result = await provision(a, 'FEAT-SAMPLE-T002', 'No deps', { runSetup: false });

    expect(existsSync(path.join(result.path, 'node_modules'))).toBe(false);
    const tests = run(result.path, 'npm', ['test']);
    expect(tests.status).not.toBe(0);
    expect(`${tests.stdout}${tests.stderr}`).toContain('toy-dep');
  });

  it('two tickets get independent worktrees — a commit in one is invisible in the other', async () => {
    const a = arena();
    const one = await provision(a, 'FEAT-SAMPLE-T001', 'First', { runSetup: false });
    const two = await provision(a, 'FEAT-SAMPLE-T002', 'Second', { runSetup: false });

    expect(one.path).not.toBe(two.path);
    expect(one.branch).not.toBe(two.branch);

    writeFileSync(path.join(one.path, 'only-in-one.txt'), 'hello\n', 'utf8');
    git(one.path, ['add', '-A']);
    git(one.path, ['commit', '--quiet', '-m', 'feat: something in ticket one']);

    expect(existsSync(path.join(two.path, 'only-in-one.txt'))).toBe(false);
    expect(git(two.path, ['status', '--porcelain']).trim()).toBe('');
    expect(git(a.repo.path, ['rev-parse', one.branch]).trim()).not.toBe(
      git(a.repo.path, ['rev-parse', two.branch]).trim(),
    );
  });

  it('adopts an existing worktree rather than rebuilding it', async () => {
    const a = arena();
    const first = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });
    writeFileSync(path.join(first.path, 'agent-work.txt'), 'uncommitted\n', 'utf8');

    const second = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });

    expect(second.reused).toBe(true);
    // Rebuilding would have thrown this away. Agents never commit (ADR-003),
    // so the working tree is the only copy of what they produced.
    expect(readFileSync(path.join(first.path, 'agent-work.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('recreates a worktree whose directory was deleted from disk', async () => {
    const a = arena();
    const first = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });
    rmSync(first.path, { recursive: true, force: true });

    // git still holds the registration, and `worktree add` refuses the path
    // until it is pruned. That is the case this covers.
    const second = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });
    expect(second.reused).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    expect(git(second.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(second.branch);
  });

  it('refuses at runtime to build a worktree under a temp path', async () => {
    // Not a string assertion: the guard is called with a real temp location and
    // must throw before anything is created (plan Section E item 7).
    const a = arena();
    const tempRepo = path.join(os.tmpdir(), 'factory-temp-repo');
    await expect(
      provisionWorktree({
        git: a.git,
        repoRoot: tempRepo,
        vaultName: a.vault,
        ticketId: 'FEAT-SAMPLE-T001',
        featureSlug: 'sample',
        title: 'Add a thing',
        fromRef: FEATURE_BRANCH,
        setupCommand: SETUP,
        setupTimeoutMs: SETUP_TIMEOUT_MS,
      }),
    ).rejects.toThrow(UnsafeWorktreePathError);
  });
});

describe('a failing setup command', () => {
  it('raises, and removes the worktree rather than handing over a broken tree', async () => {
    const a = arena();
    const attempt = provisionWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      ticketId: 'FEAT-SAMPLE-T003',
      featureSlug: 'sample',
      title: 'Broken setup',
      fromRef: FEATURE_BRANCH,
      setupCommand: 'echo "registry unreachable" >&2; exit 7',
      setupTimeoutMs: SETUP_TIMEOUT_MS,
    });

    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as SetupCommandFailedError,
    );

    expect(error).toBeInstanceOf(SetupCommandFailedError);
    if (error === undefined) throw new Error('unreachable');
    expect(error.outcome.exitCode).toBe(7);
    expect(error.outcome.output).toContain('registry unreachable');
    expect(existsSync(error.worktreePath)).toBe(false);

    // And git no longer thinks it is there, so the next attempt is not blocked.
    const worktrees = await a.git.listWorktrees();
    expect(worktrees.some((entry) => entry.path === error.worktreePath)).toBe(false);
  });

  it('is killed at its deadline rather than hanging the factory', async () => {
    const a = arena();
    const attempt = provisionWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      ticketId: 'FEAT-SAMPLE-T004',
      featureSlug: 'sample',
      title: 'Hanging setup',
      fromRef: FEATURE_BRANCH,
      setupCommand: 'sleep 60',
      setupTimeoutMs: 750,
    });

    const error = await attempt.then(
      () => undefined,
      (thrown: unknown) => thrown as SetupCommandFailedError,
    );
    expect(error).toBeInstanceOf(SetupCommandFailedError);
    if (error === undefined) throw new Error('unreachable');
    expect(error.outcome.timedOut).toBe(true);
    expect(existsSync(error.worktreePath)).toBe(false);
  });

  it('reports a setup command that cannot be started at all', async () => {
    const a = arena();
    const error = await provisionWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      ticketId: 'FEAT-SAMPLE-T005',
      featureSlug: 'sample',
      title: 'Missing setup binary',
      fromRef: FEATURE_BRANCH,
      setupCommand: 'definitely-not-a-real-command-xyz',
      setupTimeoutMs: SETUP_TIMEOUT_MS,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as SetupCommandFailedError,
    );

    expect(error).toBeInstanceOf(SetupCommandFailedError);
    if (error === undefined) throw new Error('unreachable');
    expect(error.outcome.ok).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('deletes the directory and prunes git’s metadata', async () => {
    const a = arena();
    const result = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });

    const before = await a.git.listWorktrees();
    expect(before.some((entry) => entry.path === result.path)).toBe(true);

    await destroyWorktree(a.git, result.path);

    expect(existsSync(result.path)).toBe(false);
    const after = await a.git.listWorktrees();
    expect(after.some((entry) => entry.path === result.path)).toBe(false);
    // Prunable metadata left behind would block re-adding the same path, which
    // is what makes "pruned" different from "the directory is gone".
    expect(existsSync(path.join(a.repo.path, '.git', 'worktrees', 'FEAT-SAMPLE-T001'))).toBe(false);
  });

  it('is idempotent — removing twice is not an error', async () => {
    const a = arena();
    const result = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });
    await destroyWorktree(a.git, result.path);
    await expect(destroyWorktree(a.git, result.path)).resolves.toBeUndefined();
  });

  it('removes a worktree with uncommitted changes when explicitly told to', async () => {
    const a = arena();
    const result = await provision(a, 'FEAT-SAMPLE-T001', 'Add a thing', { runSetup: false });
    writeFileSync(path.join(result.path, 'src', 'calc.ts'), '// clobbered\n', 'utf8');

    await destroyWorktree(a.git, result.path);
    expect(existsSync(result.path)).toBe(false);
  });
});

describe('throwaway worktrees (spec §4.3)', () => {
  it('checks out the ref detached, so the base branch can stay checked out in the repo', async () => {
    const a = arena();
    // The main checkout is on `main`; a named-branch worktree at `main` would
    // be refused by git outright, which is why these are detached.
    const scratch = await provisionScratchWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      label: 'FEAT-SAMPLE-tl_plan',
      ref: a.repo.branch,
      setupCommand: SETUP,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      runSetup: false,
    });

    expect(existsSync(scratch.path)).toBe(true);
    expect(git(scratch.path, ['rev-parse', 'HEAD']).trim()).toBe(
      git(a.repo.path, ['rev-parse', a.repo.branch]).trim(),
    );
    expect(git(scratch.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');

    await scratch.dispose();
  });

  it('takes everything written in it with it when disposed — resolution A4', async () => {
    const a = arena();
    const scratch = await provisionScratchWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      label: 'FEAT-SAMPLE-dl',
      ref: a.repo.branch,
      setupCommand: SETUP,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      runSetup: false,
    });

    // Exactly what a read-only role must not be able to leave behind.
    writeFileSync(path.join(scratch.path, 'src', 'calc.ts'), '// rewritten by a read-only role\n');
    writeFileSync(path.join(scratch.path, 'NEW-FILE.txt'), 'should not survive\n');

    await scratch.dispose();

    expect(existsSync(scratch.path)).toBe(false);
    // And nothing of it reached the repo.
    expect(readFileSync(path.join(a.repo.path, 'src', 'calc.ts'), 'utf8')).not.toContain(
      'rewritten by a read-only role',
    );
    expect(existsSync(path.join(a.repo.path, 'NEW-FILE.txt'))).toBe(false);
    expect((await a.git.listWorktrees()).some((entry) => entry.path === scratch.path)).toBe(false);
  });

  it('replaces a leftover from a run that was killed mid-flight', async () => {
    const a = arena();
    const first = await provisionScratchWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      label: 'FEAT-SAMPLE-dl',
      ref: a.repo.branch,
      setupCommand: SETUP,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      runSetup: false,
    });
    writeFileSync(path.join(first.path, 'LEFTOVER.txt'), 'from a dead run\n');

    const second = await provisionScratchWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      label: 'FEAT-SAMPLE-dl',
      ref: a.repo.branch,
      setupCommand: SETUP,
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      runSetup: false,
    });

    expect(second.path).toBe(first.path);
    expect(existsSync(path.join(second.path, 'LEFTOVER.txt'))).toBe(false);
    await second.dispose();
  });
});

describe('one vault can never destroy another’s worktree', () => {
  it('two vaults with the same directory name get separate roots (the salt)', () => {
    // The collision: same vault *name*, two repos sharing a parent. Both used
    // to land on one root, and whichever reconciled second would remove the
    // other's ticket worktrees — work that exists nowhere else, because agents
    // never commit (ADR-003).
    const parent = path.join(testRepoRoot(), `salt-${process.pid}`);
    const vaultA = path.join(parent, 'alpha', 'vault');
    const vaultB = path.join(parent, 'beta', 'vault');
    mkdirSync(vaultA, { recursive: true });
    mkdirSync(vaultB, { recursive: true });

    try {
      expect(path.basename(vaultA)).toBe(path.basename(vaultB));

      const nameA = vaultWorktreeName(vaultA);
      const nameB = vaultWorktreeName(vaultB);
      expect(nameA).not.toBe(nameB);
      expect(worktreeRoot(REPO_FOR_SALT, nameA)).not.toBe(worktreeRoot(REPO_FOR_SALT, nameB));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to remove a worktree belonging to a different repository', async () => {
    // The backstop for the destructive primitive itself: `git worktree remove`
    // declines a foreign path, that decline is treated as "already gone", and
    // the unconditional rm that follows used to delete it anyway.
    const a = arena();
    const b = arena();

    const mine = await provision(a, 'FEAT-SAMPLE-T001', 'Belongs to A', { runSetup: false });
    writeFileSync(path.join(mine.path, 'AGENT-WORK.txt'), 'the only copy\n', 'utf8');

    expect(worktreeOwner(mine.path)).toBe(path.resolve(a.repo.path));

    await expect(destroyWorktree(b.git, mine.path)).rejects.toThrow(ForeignWorktreeError);

    // Still there, still holding the work.
    expect(existsSync(mine.path)).toBe(true);
    expect(readFileSync(path.join(mine.path, 'AGENT-WORK.txt'), 'utf8')).toBe('the only copy\n');
    // And repo A still knows about it — no stale registration left behind.
    expect((await a.git.listWorktrees()).some((entry) => entry.path === mine.path)).toBe(true);
  });

  it('still removes its own worktree', async () => {
    // The refusal must be about ownership, not about refusing everything.
    const a = arena();
    const mine = await provision(a, 'FEAT-SAMPLE-T001', 'Belongs to A', { runSetup: false });

    await destroyWorktree(a.git, mine.path);
    expect(existsSync(mine.path)).toBe(false);
  });

  it('allows a plain directory that is nobody’s worktree', async () => {
    // The PM's scratch directory has no `.git` and cannot be attributed. With
    // the salt in place it cannot belong to another vault either, so refusing
    // it would only leak directories after a crashed run.
    const a = arena();
    const plain = path.join(worktreeRoot(a.repo.path, a.vault), '.scratch', 'FEAT-SAMPLE-pm');
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(plain, 'scratch.txt'), 'nothing of value\n', 'utf8');

    expect(worktreeOwner(plain)).toBeUndefined();
    await destroyWorktree(a.git, plain);
    expect(existsSync(plain)).toBe(false);
  });
});

describe('the Git seam itself', () => {
  it('reports branch existence, tags, diffs and merges against a real repo', async () => {
    const a = arena();
    expect(await a.git.branchExists(FEATURE_BRANCH)).toBe(true);
    expect(await a.git.branchExists('no-such-branch')).toBe(false);

    expect(await a.git.ensureBranch('feature/other', a.repo.branch)).toBe(true);
    expect(await a.git.ensureBranch('feature/other', a.repo.branch)).toBe(false);

    const worktree = await provision(a, 'FEAT-SAMPLE-T001', 'Diffable', { runSetup: false });
    writeFileSync(path.join(worktree.path, 'src', 'calc.ts'), '// changed\n', 'utf8');
    git(worktree.path, ['add', '-A']);
    git(worktree.path, ['commit', '--quiet', '-m', 'feat: change calc']);

    const diff = await a.git.diff(FEATURE_BRANCH, worktree.branch);
    expect(diff).toContain('calc.ts');

    const merged = await a.git.mergeNoFf(FEATURE_BRANCH, worktree.branch);
    expect(merged.ok).toBe(true);

    await a.git.tag('factory/sample/2026-09-01', FEATURE_BRANCH);
    expect(git(a.repo.path, ['tag', '--list']).trim()).toContain('factory/sample/2026-09-01');
  });

  it('reports a merge conflict with the conflicting files, and aborts the merge', async () => {
    const a = arena();
    const one = await provision(a, 'FEAT-SAMPLE-T001', 'One', { runSetup: false });
    const two = await provision(a, 'FEAT-SAMPLE-T002', 'Two', { runSetup: false });

    for (const [worktree, text] of [
      [one, 'from ticket one'],
      [two, 'from ticket two'],
    ] as const) {
      writeFileSync(path.join(worktree.path, 'src', 'calc.ts'), `// ${text}\n`, 'utf8');
      git(worktree.path, ['add', '-A']);
      git(worktree.path, ['commit', '--quiet', '-m', `feat: ${text}`]);
    }

    expect((await a.git.mergeNoFf(FEATURE_BRANCH, one.branch)).ok).toBe(true);
    const second = await a.git.mergeNoFf(FEATURE_BRANCH, two.branch);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.conflicts).toContain('src/calc.ts');

    // Left clean, not mid-merge: every later git call in the cycle depends on it.
    expect(existsSync(path.join(a.repo.path, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('rejects a branch name git rejects, using git’s own check', async () => {
    const a = arena();
    expect(await a.git.isValidBranchName('feat/sample/t001-ok')).toBe(true);
    expect(await a.git.isValidBranchName('feat/sample/t001~1')).toBe(false);
  });

  it('surfaces a git failure rather than swallowing it', async () => {
    const a = arena();
    await expect(a.git.tag('bad tag name', 'HEAD')).rejects.toThrow(/git command failed/);
  });

  it('does not throw when asked to remove a worktree that was never registered', async () => {
    const a = arena();
    const stray = path.join(worktreeRoot(a.repo.path, a.vault), 'never-registered');
    await expect(a.git.removeWorktree(stray, true)).resolves.toBeUndefined();
  });
});

describe('the exec seam', () => {
  // Renamed. This asserts that the setup command goes through the injected
  // `exec`, in the worktree, and nothing about output capping — that lives in
  // `test/unit/git/exec.test.ts`, against `execCapture` itself, where a real
  // oversized stream can be produced.
  it('routes the setup command through the injected exec, in the worktree', async () => {
    const a = arena();
    const seen: ExecResult[] = [];
    await provisionWorktree({
      git: a.git,
      repoRoot: a.repo.path,
      vaultName: a.vault,
      ticketId: 'FEAT-SAMPLE-T009',
      featureSlug: 'sample',
      title: 'Chatty setup',
      fromRef: FEATURE_BRANCH,
      setupCommand: 'true',
      setupTimeoutMs: SETUP_TIMEOUT_MS,
      exec: async (file, _args, options) => {
        const result: ExecResult = {
          command: file,
          cwd: options.cwd,
          status: 0,
          signal: null,
          stdout: 'installed\n',
          stderr: '',
          timedOut: false,
          durationMs: 1,
          spawnError: null,
        };
        seen.push(result);
        return result;
      },
    });

    // The seam is real: the setup command went through the injected exec, in
    // the worktree, with the configured deadline.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toContain('FEAT-SAMPLE-T009');
  });
});

/**
 * Startup validation (spec §11.1).
 *
 * Every check here is cheap and every one of these failures would otherwise
 * surface halfway through a run — after an agent has been paid for and a branch
 * cut. Two properties matter and both get their own tests: each failure is
 * *distinguishable* (a directory that is not a repo must not read the same as a
 * directory that is not there), and a broken setup reports **all** its problems
 * at once rather than one per run.
 *
 * Real git repos, not a mocked `Git`: the whole point of these checks is that
 * they agree with what git actually says.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateConfig } from '../../../src/config/load.js';
import type { FactoryConfig } from '../../../src/config/schema.js';
import {
  OWNER_REF,
  describeFailures,
  readOwnerRef,
  splitCommand,
  validateStartup,
  writeOwnerRef,
} from '../../../src/config/validate.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  removeScratchDir,
  scratchDir,
  toyRepo,
} from '../../helpers/toyRepo.js';
import type { ToyRepo } from '../../helpers/toyRepo.js';

let vault: string;
let repo: ToyRepo;

/** A vault directory that is a real vault as far as §11.1's first check knows. */
function makeVault(): string {
  const dir = scratchDir('validate-vault-');
  writeFileSync(path.join(dir, 'config.yml'), 'target_repo: "/unset"\n', 'utf8');
  return dir;
}

function configFor(overrides: Record<string, unknown> = {}): FactoryConfig {
  return validateConfig({ target_repo: repo.path, base_branch: repo.branch, ...overrides });
}

function codes(failures: readonly { code: string }[]): string[] {
  return failures.map((failure) => failure.code).sort();
}

beforeEach(() => {
  vault = makeVault();
  repo = toyRepo();
});

afterEach(() => {
  removeScratchDir(vault);
  repo.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('a healthy setup', () => {
  it('reports no failures', () => {
    expect(validateStartup({ vaultPath: vault, config: configFor() })).toEqual([]);
  });

  it('accepts a repo whose owner ref already points at this vault', () => {
    writeOwnerRef(repo.path, vault);
    expect(validateStartup({ vaultPath: vault, config: configFor() })).toEqual([]);
  });
});

describe('target_repo', () => {
  it('fails with the path in the message when the repo is gone', () => {
    const gone = path.join(path.dirname(repo.path), 'deleted-repo');
    const failures = validateStartup({ vaultPath: vault, config: configFor({ target_repo: gone }) });

    expect(codes(failures)).toContain('target_repo_missing');
    const failure = failures.find((item) => item.code === 'target_repo_missing');
    expect(failure?.message).toContain(gone);
    expect(failure?.key).toBe('target_repo');
  });

  it('fails distinctly when the path exists but is not a git repo', () => {
    const plain = scratchDir('not-a-repo-');
    try {
      const failures = validateStartup({
        vaultPath: vault,
        config: configFor({ target_repo: plain }),
      });

      // Distinct from `target_repo_missing`: "it is not there" and "it is there
      // but git has never heard of it" need different fixes, so they must not
      // share a code or a message.
      expect(codes(failures)).toContain('target_repo_not_git');
      expect(codes(failures)).not.toContain('target_repo_missing');
      expect(failures.find((item) => item.code === 'target_repo_not_git')?.message).toContain(plain);
    } finally {
      removeScratchDir(plain);
    }
  });

  it('rejects a plain subdirectory of a git repo, rather than adopting the enclosing one', () => {
    // `git rev-parse --git-dir` succeeds anywhere inside a repo. If that were
    // the check, a target_repo one level down would pass and then every branch,
    // worktree and merge would land on the enclosing repository instead.
    const nested = path.join(repo.path, 'packages', 'inner');
    mkdirSync(nested, { recursive: true });
    try {
      const failures = validateStartup({
        vaultPath: vault,
        config: configFor({ target_repo: nested }),
      });
      expect(codes(failures)).toContain('target_repo_not_git');
    } finally {
      rmSync(path.join(repo.path, 'packages'), { recursive: true, force: true });
    }
  });

  it('does not also complain about the base branch when the repo is missing', () => {
    // A cascade of derived failures buries the one that matters.
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({ target_repo: '/no/such/repo' }),
    });
    expect(codes(failures)).not.toContain('base_branch_missing');
  });
});

describe('base_branch', () => {
  it('fails and lists the branches that do exist', () => {
    git(repo.path, ['branch', 'develop']);
    git(repo.path, ['branch', 'release/1.0']);

    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({ base_branch: 'trunk' }),
    });

    const failure = failures.find((item) => item.code === 'base_branch_missing');
    expect(failure).toBeDefined();
    expect(failure?.message).toContain('trunk');
    expect(failure?.message).toContain('develop');
    expect(failure?.message).toContain('release/1.0');
    expect(failure?.message).toContain(repo.branch);
  });

  it('accepts a branch that exists but is not checked out', () => {
    git(repo.path, ['branch', 'develop']);
    expect(
      validateStartup({ vaultPath: vault, config: configFor({ base_branch: 'develop' }) }),
    ).toEqual([]);
  });
});

describe('the owner ref', () => {
  it('rejects a repo owned by a different vault', () => {
    const otherVault = makeVault();
    try {
      writeOwnerRef(repo.path, otherVault);

      const failures = validateStartup({ vaultPath: vault, config: configFor() });
      const failure = failures.find((item) => item.code === 'owner_ref_mismatch');

      expect(failure).toBeDefined();
      expect(failure?.message).toContain(otherVault);
      expect(failure?.message).toContain(vault);
    } finally {
      removeScratchDir(otherVault);
    }
  });

  it('is fine when absent — an unbound repo is a normal first run', () => {
    expect(readOwnerRef(repo.path)).toBeNull();
    expect(codes(validateStartup({ vaultPath: vault, config: configFor() }))).not.toContain(
      'owner_ref_mismatch',
    );
  });

  it('round-trips the vault path and is readable with plain git', () => {
    writeOwnerRef(repo.path, vault);

    expect(readOwnerRef(repo.path)).toBe(path.resolve(vault));
    expect(git(repo.path, ['cat-file', '-p', OWNER_REF])).toContain(path.resolve(vault));
  });

  it('recognises its own vault reached through a symlinked ancestor', () => {
    // The same vault spelled two ways. `path.resolve` does not follow symlinks,
    // so comparing resolved-but-not-canonical paths reports a legitimate vault
    // as owned by a different one and refuses to start. macOS hands this out
    // for free — /tmp is a symlink to /private/tmp — so the symlink is built
    // deliberately here rather than relying on the platform providing one.
    const base = scratchDir('symlink-owner-');
    const realRoot = path.join(base, 'real');
    const linkRoot = path.join(base, 'link');
    mkdirSync(path.join(realRoot, 'vault'), { recursive: true });
    writeFileSync(path.join(realRoot, 'vault', 'config.yml'), 'target_repo: "/unset"\n', 'utf8');
    symlinkSync(realRoot, linkRoot, 'dir');

    const viaReal = path.join(realRoot, 'vault');
    const viaLink = path.join(linkRoot, 'vault');

    try {
      // Bound through one spelling...
      writeOwnerRef(repo.path, viaReal);

      // ...must be recognised through the other, in both directions.
      expect(codes(validateStartup({ vaultPath: viaLink, config: configFor() }))).not.toContain(
        'owner_ref_mismatch',
      );

      writeOwnerRef(repo.path, viaLink);
      expect(codes(validateStartup({ vaultPath: viaReal, config: configFor() }))).not.toContain(
        'owner_ref_mismatch',
      );
    } finally {
      removeScratchDir(base);
    }
  });

  it('still rejects a genuinely different vault that happens to sit beside a symlink', () => {
    // The symlink fix must not turn the owner check into a no-op.
    const base = scratchDir('symlink-owner-neg-');
    const realRoot = path.join(base, 'real');
    const linkRoot = path.join(base, 'link');
    mkdirSync(path.join(realRoot, 'vault-a'), { recursive: true });
    mkdirSync(path.join(realRoot, 'vault-b'), { recursive: true });
    symlinkSync(realRoot, linkRoot, 'dir');

    try {
      writeOwnerRef(repo.path, path.join(realRoot, 'vault-a'));
      expect(
        codes(validateStartup({ vaultPath: path.join(linkRoot, 'vault-b'), config: configFor() })),
      ).toContain('owner_ref_mismatch');
    } finally {
      removeScratchDir(base);
    }
  });
});

describe('the vault itself', () => {
  it('fails when the vault directory does not exist', () => {
    const failures = validateStartup({
      vaultPath: path.join(path.dirname(vault), 'never-created'),
      config: configFor(),
    });
    expect(codes(failures)).toContain('vault_missing');
  });

  it('fails distinctly when the directory exists but holds no config.yml', () => {
    const empty = scratchDir('empty-');
    try {
      const failures = validateStartup({ vaultPath: empty, config: configFor() });
      expect(codes(failures)).toContain('config_missing');
      expect(codes(failures)).not.toContain('vault_missing');
    } finally {
      removeScratchDir(empty);
    }
  });

  it('rejects a vault_version this build does not understand', () => {
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({ vault_version: 99 }),
    });
    expect(codes(failures)).toContain('vault_version_unsupported');
    expect(failures[0]?.message).toContain('99');
  });
});

describe('gate commands resolve', () => {
  it('fails when a gate names a tool that is not installed', () => {
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({ gates: { tests: 'definitely-not-a-real-binary-xyz test' } }),
    });

    const failure = failures.find((item) => item.code === 'gate_command_unresolvable');
    expect(failure?.key).toBe('gates.tests');
    expect(failure?.message).toContain('definitely-not-a-real-binary-xyz');
  });

  it('fails when a gate points at a script path that is not in the repo', () => {
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({ gates: { build: './scripts/absent.sh' } }),
    });
    expect(failures.find((item) => item.code === 'gate_command_unresolvable')?.key).toBe(
      'gates.build',
    );
  });

  it('accepts a script path that exists in the repo', () => {
    mkdirSync(path.join(repo.path, 'scripts'), { recursive: true });
    writeFileSync(path.join(repo.path, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    try {
      expect(
        validateStartup({
          vaultPath: vault,
          config: configFor({ gates: { build: './scripts/check.sh' } }),
        }),
      ).toEqual([]);
    } finally {
      rmSync(path.join(repo.path, 'scripts'), { recursive: true, force: true });
    }
  });

  it('reports each unresolvable gate separately', () => {
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({
        gates: { tests: 'nope-a test', lint: 'nope-b lint', build: 'npm run build' },
      }),
    });

    expect(failures.map((failure) => failure.key)).toEqual(['gates.tests', 'gates.lint']);
  });
});

describe('every failure is reported at once', () => {
  it('a vault with three distinct problems reports three named failures in one result', () => {
    const failures = validateStartup({
      vaultPath: vault,
      config: configFor({
        vault_version: 7,
        target_repo: '/no/such/repo',
        gates: { lint: 'nope-lint --strict' },
      }),
    });

    expect(codes(failures)).toEqual([
      'gate_command_unresolvable',
      'target_repo_missing',
      'vault_version_unsupported',
    ]);
    expect(describeFailures(failures)).toContain('3 problems');
  });

  it('describeFailures is empty for a healthy setup', () => {
    expect(describeFailures([])).toBe('');
  });
});

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('npm run lint')).toEqual(['npm', 'run', 'lint']);
  });

  it('keeps a quoted path with a space in it as one word', () => {
    expect(splitCommand('"./my scripts/test.sh" --fast')).toEqual([
      './my scripts/test.sh',
      '--fast',
    ]);
  });

  it('returns an empty list for an empty command', () => {
    expect(splitCommand('   ')).toEqual([]);
  });
});

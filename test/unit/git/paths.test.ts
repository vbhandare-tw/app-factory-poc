/**
 * Worktree locations and branch names (plan Phase 8).
 *
 * ============================================================================
 * WHY THE BRANCH-NAME CASES SHELL OUT TO GIT
 * ============================================================================
 * A regex here asserting that `ticketBranchName` produces `[a-z0-9/-]` would be
 * a tautology: it would restate the sanitiser's own rule, in a second place, in
 * the same author's words. If the belief about what git accepts is wrong, both
 * copies are wrong together and both stay green.
 *
 * So every produced name is handed to the real `git check-ref-format`, which is
 * the only thing that actually decides. The suite also feeds that command a
 * name git is known to reject, so a `check-ref-format` that had stopped
 * checking anything could not make the rest of these vacuous.
 *
 * ============================================================================
 * AND WHY THE LOCATION CASES CHECK THE RUNTIME REFUSAL, NOT A STRING
 * ============================================================================
 * Plan Section E item 7 — a worktree under a temp path is silently unfenced,
 * because `$TMPDIR` and `/tmp/claude*` are on the sandbox's default *write*
 * allowlist. Asserting "the returned path does not start with /tmp" would pass
 * for a path that never went near the guard. These call the guard.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertNotUnderTempRoot,
  assertOutsideRepo,
  EMPTY_TITLE_PLACEHOLDER,
  featureBranchName,
  MAX_TITLE_SEGMENT_CHARS,
  realPathOf,
  scratchWorktreePath,
  shortTitle,
  ticketBranchName,
  ticketOrdinalSegment,
  ticketWorktreePath,
  UnsafeWorktreePathError,
  vaultWorktreeName,
  WORKTREES_DIR_NAME,
  worktreeRoot,
} from '../../../src/git/paths.js';
import { testRepoRoot } from '../../helpers/toyRepo.js';

/** A repo location that satisfies the same rule the real ones do. */
const REPO = path.join(testRepoRoot(), 'some-repo');
const VAULT = 'my-vault';

/** git's own verdict. Exit 0 means it would accept the ref. */
function gitAcceptsBranch(branch: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', `refs/heads/${branch}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('where worktrees live', () => {
  it('puts the root outside the repo, as a sibling of it (spec §10)', () => {
    const root = worktreeRoot(REPO, VAULT);
    expect(root).toBe(path.join(path.dirname(REPO), WORKTREES_DIR_NAME, VAULT));
    expect(root.startsWith(`${REPO}${path.sep}`)).toBe(false);
  });

  it('puts a ticket worktree under that root, named for the ticket', () => {
    const worktree = ticketWorktreePath(REPO, VAULT, 'FEAT-ALPHA-T001');
    expect(worktree).toBe(path.join(worktreeRoot(REPO, VAULT), 'FEAT-ALPHA-T001'));
  });

  it('separates two vaults pointed at the same repo', () => {
    expect(ticketWorktreePath(REPO, 'vault-a', 'FEAT-A-T001')).not.toBe(
      ticketWorktreePath(REPO, 'vault-b', 'FEAT-A-T001'),
    );
  });

  it('never returns a path under /tmp, /private/tmp, or $TMPDIR', () => {
    const worktree = ticketWorktreePath(REPO, VAULT, 'FEAT-ALPHA-T001');
    for (const root of ['/tmp', '/private/tmp', os.tmpdir()]) {
      expect(worktree.startsWith(`${path.resolve(root)}${path.sep}`)).toBe(false);
    }
  });

  it('refuses a repo under a temp path, so the worktrees beside it are never unfenced', () => {
    for (const temp of ['/tmp/some-repo', '/private/tmp/some-repo', path.join(os.tmpdir(), 'r')]) {
      expect(() => worktreeRoot(temp, VAULT)).toThrow(UnsafeWorktreePathError);
      expect(() => worktreeRoot(temp, VAULT)).toThrow(/Section E item 7/);
    }
  });

  it('refuses a temp path directly, whichever spelling it arrives in', () => {
    for (const candidate of [
      '/tmp',
      '/tmp/claude-503/wt',
      '/private/tmp/claude-1/wt',
      '/var/folders/ab/cd/T/wt',
      '/private/var/folders/ab/cd/T/wt',
      path.join(os.tmpdir(), 'wt'),
    ]) {
      expect(() => assertNotUnderTempRoot(candidate)).toThrow(UnsafeWorktreePathError);
    }
  });

  it('allows an ordinary path', () => {
    expect(() => assertNotUnderTempRoot(path.join(testRepoRoot(), 'wt'))).not.toThrow();
  });

  it('refuses a path that reaches a temp root through a symlink', () => {
    // `path.resolve` is lexical — it never touches the disk — so a link whose
    // *target* is a temp root sails past a prefix comparison while the kernel
    // sandbox, which matches on the real path, treats the destination as
    // writable. An operator sees an entirely ordinary-looking path and gets
    // every agent unfenced.
    mkdirSync(testRepoRoot(), { recursive: true });
    const link = path.join(testRepoRoot(), `link-into-tmp-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(os.tmpdir(), link);

    try {
      const throughLink = path.join(link, 'some-repo');
      // The lexical view really does look innocent — otherwise this test would
      // pass for the wrong reason.
      expect(path.resolve(throughLink).startsWith(path.resolve(os.tmpdir()))).toBe(false);
      // And the filesystem really does land in a temp root.
      expect(realPathOf(throughLink).startsWith(path.resolve('/private/var/folders')) ||
        realPathOf(throughLink).startsWith(path.resolve(os.tmpdir()))).toBe(true);

      expect(() => assertNotUnderTempRoot(throughLink)).toThrow(UnsafeWorktreePathError);
      expect(() => assertNotUnderTempRoot(throughLink)).toThrow(/through a symlink/);
      expect(() => worktreeRoot(throughLink, VAULT)).toThrow(UnsafeWorktreePathError);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('resolves symlinks even for a path that does not exist yet', () => {
    // The path being checked is normally about to be created, so the deepest
    // existing ancestor is what has to be resolved. A component that does not
    // exist cannot itself be a link — but its parent can.
    mkdirSync(testRepoRoot(), { recursive: true });
    const link = path.join(testRepoRoot(), `link-unborn-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(os.tmpdir(), link);

    try {
      const deep = path.join(link, 'not', 'created', 'yet', 'worktree');
      expect(() => assertNotUnderTempRoot(deep)).toThrow(UnsafeWorktreePathError);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('gives up gracefully on a path with nothing resolvable', () => {
    expect(realPathOf('/no/such/place/at/all')).toBe(path.resolve('/no/such/place/at/all'));
  });
});

describe('the worktree root is salted per vault', () => {
  it('two vaults with the same directory name get different roots', () => {
    // The collision that matters: same vault *name*, two repos sharing a
    // parent. Before the salt both landed on one root, and vault B's
    // reconciliation would then delete vault A's worktrees.
    const a = vaultWorktreeName('/somewhere/alpha/vault');
    const b = vaultWorktreeName('/elsewhere/beta/vault');

    expect(a).not.toBe(b);
    expect(a.startsWith('vault-')).toBe(true);
    expect(b.startsWith('vault-')).toBe(true);
    expect(worktreeRoot(REPO, a)).not.toBe(worktreeRoot(REPO, b));
  });

  it('is deterministic, so a restart finds its own worktrees again', () => {
    expect(vaultWorktreeName('/somewhere/alpha/vault')).toBe(
      vaultWorktreeName('/somewhere/alpha/vault'),
    );
  });

  it('keeps the vault name readable — the salt is a suffix, not a replacement', () => {
    expect(vaultWorktreeName('/a/b/My Vault')).toMatch(/^my-vault-[0-9a-f]{8}$/);
  });

  it('refuses a worktree inside the repo', () => {
    expect(() => assertOutsideRepo(path.join(REPO, 'worktrees', 'a'), REPO)).toThrow(
      UnsafeWorktreePathError,
    );
    expect(() => assertOutsideRepo(REPO, REPO)).toThrow(UnsafeWorktreePathError);
  });

  it('refuses a ticket id that would traverse out of the root', () => {
    for (const id of ['../escape', 'a/b', '..', '.hidden', '']) {
      expect(() => ticketWorktreePath(REPO, VAULT, id)).toThrow(UnsafeWorktreePathError);
    }
  });

  it('keeps throwaway worktrees under the same root, in their own subdirectory', () => {
    const scratch = scratchWorktreePath(REPO, VAULT, 'FEAT-ALPHA-tl_plan');
    expect(scratch.startsWith(`${worktreeRoot(REPO, VAULT)}${path.sep}`)).toBe(true);
    expect(scratch).not.toBe(ticketWorktreePath(REPO, VAULT, 'FEAT-ALPHA-T001'));
  });

  it('derives the vault name from its directory, sanitised', () => {
    expect(vaultWorktreeName('/a/b/My Vault').startsWith('my-vault-')).toBe(true);
    expect(() => vaultWorktreeName('/a/b/日本')).toThrow(UnsafeWorktreePathError);
  });
});

describe('branch names, as git judges them', () => {
  it('check-ref-format is actually checking something', () => {
    // The control. Without it, a `check-ref-format` that had become a no-op
    // would make every case below pass while proving nothing.
    expect(gitAcceptsBranch('feat/x/t001-ok')).toBe(true);
    expect(gitAcceptsBranch('feat/x/..bad')).toBe(false);
    expect(gitAcceptsBranch('feat/x/t001 with space')).toBe(false);
    expect(gitAcceptsBranch('feat/x/t001~1')).toBe(false);
    expect(gitAcceptsBranch('feat/x/t001.lock')).toBe(false);
  });

  it('follows spec §10: feat/<slug>/t00N-<short-title>', () => {
    expect(ticketBranchName('user-auth', 'FEAT-USER-AUTH-T003', 'Add login form')).toBe(
      'feat/user-auth/t003-add-login-form',
    );
  });

  it('takes the ordinal from the ticket id, so the two can never disagree', () => {
    expect(ticketOrdinalSegment('FEAT-X-T007')).toBe('t007');
    expect(ticketOrdinalSegment('FEAT-X-T1000')).toBe('t1000');
    expect(() => ticketOrdinalSegment('FEAT-X')).toThrow(/T<ordinal>/);
  });

  it('produces a ref git accepts for every awkward title', () => {
    const titles = [
      'Add login form',
      'Fix the auth/session split',
      'Handle 100% of ~edge~ cases',
      'Refactor: parse [tokens] properly',
      'Support café and naïve inputs',
      '日本語のタイトル',
      '🚀 ship it',
      '...leading dots',
      'trailing.lock',
      'a..b',
      'has@{brace}',
      'back\\slash',
      'question?mark',
      'star*wars',
      'colon:name',
      'controlchar',
      '   ',
      '',
      '/'.repeat(5),
      'x'.repeat(300),
    ];

    for (const title of titles) {
      const branch = ticketBranchName('my-feature', 'FEAT-MY-FEATURE-T001', title);
      expect(gitAcceptsBranch(branch), `git rejected ${JSON.stringify(branch)} from title ${JSON.stringify(title)}`).toBe(
        true,
      );
    }
  });

  it('and a ref git accepts for every awkward feature slug', () => {
    for (const slug of ['user auth', 'a/b', 'Ünïcödé', 'x'.repeat(120), '...dots']) {
      expect(gitAcceptsBranch(featureBranchName(slug))).toBe(true);
    }
  });

  it('caps the title segment, and keeps something readable when it caps', () => {
    const branch = ticketBranchName(
      'f',
      'FEAT-F-T001',
      'implement the entire authentication subsystem including refresh tokens',
    );
    const segment = branch.split('/')[2] ?? '';
    expect(segment.length).toBeLessThanOrEqual(MAX_TITLE_SEGMENT_CHARS + 't001-'.length);
    expect(segment.startsWith('t001-implement-the-entire')).toBe(true);
  });

  it('falls back rather than emitting an empty segment', () => {
    expect(shortTitle('日本語')).toBe(EMPTY_TITLE_PLACEHOLDER);
    expect(shortTitle('')).toBe(EMPTY_TITLE_PLACEHOLDER);
    expect(ticketBranchName('f', 'FEAT-F-T002', '///')).toBe(`feat/f/t002-${EMPTY_TITLE_PLACEHOLDER}`);
  });

  it('is deterministic — the same ticket always gets the same branch', () => {
    const once = ticketBranchName('slug', 'FEAT-SLUG-T001', 'Some Title');
    const twice = ticketBranchName('slug', 'FEAT-SLUG-T001', 'Some Title');
    expect(once).toBe(twice);
  });

  it('refuses a feature slug with nothing usable in it', () => {
    expect(() => ticketBranchName('日本', 'FEAT-X-T001', 'title')).toThrow(/usable in a git ref/);
  });
});

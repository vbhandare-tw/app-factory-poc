import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupAllToyRepos, git, run, toyRepo } from '../helpers/toyRepo.js';

/**
 * Phase 1 — proves the toolchain and the toy-repo fixture actually work, so no
 * later phase has to debug its own harness.
 */
afterAll(() => {
  cleanupAllToyRepos();
});

describe('toyRepo() fixture helper', () => {
  it('produces a directory that is a git repo with exactly one commit', () => {
    const repo = toyRepo();
    try {
      expect(git(repo.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true');
      expect(git(repo.path, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      expect(git(repo.path, ['status', '--porcelain']).trim()).toBe('');
      expect(git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    } finally {
      repo.cleanup();
    }
  });

  it('called twice returns two independent paths that do not share state', () => {
    const a = toyRepo();
    const b = toyRepo();
    try {
      expect(a.path).not.toBe(b.path);

      writeFileSync(path.join(a.path, 'src', 'only-in-a.ts'), 'export const marker = 1;\n');
      git(a.path, ['add', '-A']);
      git(a.path, ['commit', '--quiet', '-m', 'feat: marker']);

      // b must be untouched: no extra file, still one commit.
      expect(git(b.path, ['status', '--porcelain']).trim()).toBe('');
      expect(git(b.path, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
      expect(git(a.path, ['rev-list', '--count', 'HEAD']).trim()).toBe('2');
      expect(git(a.path, ['rev-parse', 'HEAD']).trim()).not.toBe(
        git(b.path, ['rev-parse', 'HEAD']).trim(),
      );
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('does not copy generated output into the clone', () => {
    const repo = toyRepo();
    try {
      expect(run(repo.path, 'test', ['-d', 'node_modules']).status).not.toBe(0);
      expect(run(repo.path, 'test', ['-d', 'dist']).status).not.toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it('lives outside any temp path, so Phase 8 worktrees stay fenced', () => {
    const repo = toyRepo();
    try {
      // Section E item 7: the sandbox write allowlist covers $TMPDIR and
      // /tmp/claude*, so a repo under a temp path silently unfences its
      // sibling worktrees.
      expect(repo.path.startsWith('/tmp/')).toBe(false);
      expect(repo.path.startsWith('/private/tmp/')).toBe(false);
      expect(repo.path.startsWith('/var/folders/')).toBe(false);
      expect(repo.path.startsWith('/private/var/folders/')).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe('toy-app gates on a clean checkout', () => {
  it("the toy repo's npm test exits 0", () => {
    const repo = toyRepo();
    try {
      const result = run(repo.path, 'npm', ['test']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it("the toy repo's npm run lint exits 0", () => {
    const repo = toyRepo();
    try {
      const result = run(repo.path, 'npm', ['run', 'lint']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it("the toy repo's npm run build exits 0 and emits a manifest", () => {
    const repo = toyRepo();
    try {
      const result = run(repo.path, 'npm', ['run', 'build']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const manifest = JSON.parse(
        readFileSync(path.join(repo.path, 'dist', 'build-manifest.json'), 'utf8'),
      ) as { name: string; modules: { module: string; exports: string[] }[] };
      expect(manifest.name).toBe('toy-app');
      expect(manifest.modules.map((m) => m.module)).toContain('src/calc.ts');
    } finally {
      repo.cleanup();
    }
  });

  it('npm ci succeeds against the committed lock file', () => {
    // Phase 8 provisions a fresh worktree by running `setup_command`
    // (default `npm ci`). If the lock file and package.json disagree, npm ci
    // exits non-zero and every ticket would start against a broken tree.
    const repo = toyRepo();
    try {
      const result = run(repo.path, 'npm', ['ci']);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});

describe('toy-app gates can genuinely fail', () => {
  // A gate that cannot go red proves nothing. Phase 9 depends on each of these
  // turning the ticket around.
  it('a broken test turns npm test red', () => {
    const repo = toyRepo();
    try {
      writeFileSync(
        path.join(repo.path, 'src', 'broken.test.ts'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './calc.ts';",
          "test('deliberately wrong', () => { assert.equal(add(1, 1), 3); });",
          '',
        ].join('\n'),
      );
      const result = run(repo.path, 'npm', ['test']);
      expect(result.status).not.toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it('a lint violation turns npm run lint red and names the rule', () => {
    const repo = toyRepo();
    try {
      writeFileSync(path.join(repo.path, 'src', 'dirty.ts'), 'export const dirty = 1;   \n');
      const result = run(repo.path, 'npm', ['run', 'lint']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('no-trailing-whitespace');
    } finally {
      repo.cleanup();
    }
  });

  it('a syntax error turns npm run build red', () => {
    const repo = toyRepo();
    try {
      writeFileSync(path.join(repo.path, 'src', 'broken.ts'), 'export const oops: = ;\n');
      const result = run(repo.path, 'npm', ['run', 'build']);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('build failed');
    } finally {
      repo.cleanup();
    }
  });

  it('non-erasable TypeScript turns npm run build red', () => {
    const repo = toyRepo();
    try {
      // `enum` cannot be type-stripped; CLAUDE.md forbids it and the build
      // gate is what makes that rule enforceable.
      writeFileSync(path.join(repo.path, 'src', 'enums.ts'), 'export enum Colour { Red }\n');
      const result = run(repo.path, 'npm', ['run', 'build']);
      expect(result.status).not.toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});

/**
 * `Git.logRange` and `Git.diffNumstat`, against a real repo (plan Phase 1,
 * resolution A2): the commit list and diffstat a final-acceptance review shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShellGit } from '../../../src/git/git.js';
import { cleanupAllToyRepos, git, toyRepo } from '../../helpers/toyRepo.js';
import type { ToyRepo } from '../../helpers/toyRepo.js';

let repo: ToyRepo;
let shell: ShellGit;

function write(file: string, contents: string | Buffer): void {
  const full = path.join(repo.path, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function commit(subject: string, files: Readonly<Record<string, string | Buffer>>): string {
  for (const [file, contents] of Object.entries(files)) write(file, contents);
  git(repo.path, ['add', '--', ...Object.keys(files)]);
  git(repo.path, ['commit', '--quiet', '-m', subject]);
  return git(repo.path, ['rev-parse', 'HEAD']).trim();
}

beforeEach(() => {
  repo = toyRepo();
  shell = new ShellGit({ repoRoot: repo.path });
});

afterEach(() => {
  repo.cleanup();
});

afterAll(() => {
  cleanupAllToyRepos();
});

describe('logRange', () => {
  it('lists only the feature branch’s commits, newest first, with their subjects', async () => {
    git(repo.path, ['checkout', '--quiet', '-b', 'feature/x']);
    const first = commit('feat: add one', { 'one.txt': 'one\n' });
    const second = commit('feat: add two\twith a tab', { 'two.txt': 'two\n' });
    git(repo.path, ['checkout', '--quiet', repo.branch]);
    commit('chore: the base moved on', { 'base.txt': 'base\n' });

    expect(await shell.logRange(repo.branch, 'feature/x')).toEqual([
      { sha: second, subject: 'feat: add two\twith a tab' },
      { sha: first, subject: 'feat: add one' },
    ]);
  });

  it('is empty when base and head are the same ref', async () => {
    expect(await shell.logRange(repo.branch, repo.branch)).toEqual([]);
  });
});

describe('diffNumstat', () => {
  it('counts lines added and removed per file since the merge base; a binary file is null', async () => {
    commit('chore: a file the branch will edit', { 'mod.txt': 'keep\ndrop\n' });
    git(repo.path, ['checkout', '--quiet', '-b', 'feature/x']);
    commit('feat: the work', {
      'mod.txt': 'keep\nnew one\nnew two\n',
      'notes.txt': 'a\nb\nc\n',
      'logo.bin': Buffer.from([0, 1, 2, 0, 255, 0]),
      'dir/über file.txt': 'unicode and a space\n',
    });
    git(repo.path, ['checkout', '--quiet', repo.branch]);
    commit('chore: the base moved on', { 'base.txt': 'base\n' });

    expect(await shell.diffNumstat(repo.branch, 'feature/x')).toEqual([
      { file: 'dir/über file.txt', added: 1, removed: 0 },
      { file: 'logo.bin', added: null, removed: null },
      { file: 'mod.txt', added: 2, removed: 1 },
      { file: 'notes.txt', added: 3, removed: 0 },
    ]);
  });

  it('is empty when base and head are the same ref', async () => {
    expect(await shell.diffNumstat(repo.branch, repo.branch)).toEqual([]);
  });
});

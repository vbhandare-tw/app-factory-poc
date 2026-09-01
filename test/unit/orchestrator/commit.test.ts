/**
 * `src/orchestrator/commit.ts` — the paths a real repo makes awkward to reach.
 *
 * `dev-loop.test.ts` drives this module against real git, and that is where the
 * behaviour that matters is proved. What is left over are two refusals and one
 * fallback that a real repo will not produce on demand:
 *
 * - **`tree_not_clean`** — a commit that lands while the worktree still differs
 *   from it. It should be unreachable, and it is the one refusal whose absence
 *   would be invisible: the gates would run against a tree that is not the
 *   commit, and every test would be green. Reaching it needs a `Git` that
 *   reports one thing before the commit and another after, which is a mocked
 *   `Git` or nothing.
 * - **the blank-message fallback** — the schema permits `commit_message: ''`,
 *   and `git commit` refuses an empty message outright, so a real agent that
 *   returned one would produce a `GitCommandError` in the middle of a dispatch
 *   rather than a commit.
 * - **staging both halves of a rename**, asserted on the pathspecs handed to
 *   `git add` rather than on what git then did with them.
 */
import { describe, expect, it } from 'vitest';

import type { Git, GitIdentity, StatusEntry } from '../../../src/git/git.js';
import {
  commitAgentWork,
  commitMessage,
  snapshotWorktree,
  wasPresentBefore,
} from '../../../src/orchestrator/commit.js';
import type { WorktreeSnapshot } from '../../../src/orchestrator/commit.js';

const WORKTREE = '/repo-worktrees/vault-abcd1234/FEAT-X-T001';

function entry(x: string, y: string, filePath: string, originalPath: string | null = null): StatusEntry {
  return { x, y, path: filePath, originalPath };
}

interface FakeGitOptions {
  /**
   * Successive answers to `statusEntries` **without** `includeIgnored`. The last
   * one repeats. `commit.ts` asks twice on the success path: once for the change
   * set, once after the commit to prove the tree matches it.
   */
  readonly statuses: ReadonlyArray<readonly StatusEntry[]>;
  /**
   * The **collapsed** ignored view (`includeIgnored`, no `allUntracked`) — what
   * `snapshot.ignoredRoots` is built from. `!! node_modules/`.
   */
  readonly ignoredRoots?: readonly StatusEntry[];
  /**
   * The **per-file** ignored view (`includeIgnored` + `allUntracked`) — what the
   * prune diffs against. `!! node_modules/left-pad/index.js`. Successive answers,
   * last repeating: the snapshot asks once and the prune asks again after the
   * agent has run, and a fixture that could not answer differently could not
   * express "a file appeared inside a directory that was already there".
   */
  readonly ignored?: ReadonlyArray<readonly StatusEntry[]>;
  readonly staged?: readonly string[];
}

interface FakeGit extends Git {
  readonly added: string[][];
  readonly commits: { message: string; identity: GitIdentity }[];
}

/**
 * A `Git` that answers with a script.
 *
 * Only the five methods `commit.ts` uses are real; the rest throw, so a future
 * edit that reaches for `mergeNoFf` here fails loudly instead of silently
 * doing nothing.
 */
function fakeGit(options: FakeGitOptions): FakeGit {
  const added: string[][] = [];
  const commits: { message: string; identity: GitIdentity }[] = [];
  let statusCalls = 0;
  let ignoredCalls = 0;

  const unsupported = (name: string) => (): never => {
    throw new Error(`fakeGit does not implement ${name}`);
  };

  return {
    added,
    commits,
    repoRoot: '/repo',
    statusEntries: (
      _worktree: string,
      statusOptions?: { readonly includeIgnored?: boolean; readonly allUntracked?: boolean },
    ): Promise<StatusEntry[]> => {
      // Three distinct questions with three distinct answers, exactly as git
      // has. Folding them together would make a call index depend on how many
      // times each caller happens to look, and would hide the very difference
      // between the collapsed and per-file views that these tests are about.
      if (statusOptions?.includeIgnored === true) {
        if (statusOptions.allUntracked === true) {
          const index = Math.min(ignoredCalls, (options.ignored ?? [[]]).length - 1);
          ignoredCalls += 1;
          return Promise.resolve([...((options.ignored ?? [[]])[index] ?? [])]);
        }
        return Promise.resolve([...(options.ignoredRoots ?? [])]);
      }
      const index = Math.min(statusCalls, options.statuses.length - 1);
      statusCalls += 1;
      return Promise.resolve([...(options.statuses[index] ?? [])]);
    },
    add: (_worktree: string, pathspecs: readonly string[]): Promise<void> => {
      added.push([...pathspecs]);
      return Promise.resolve();
    },
    stagedPaths: (): Promise<string[]> => Promise.resolve([...(options.staged ?? ['src/calc.ts'])]),
    commit: (_worktree: string, message: string, identity: GitIdentity): Promise<string> => {
      commits.push({ message, identity });
      return Promise.resolve('a'.repeat(40));
    },
    revParse: (): Promise<string | null> => Promise.resolve('a'.repeat(40)),
    createWorktree: unsupported('createWorktree'),
    createDetachedWorktree: unsupported('createDetachedWorktree'),
    removeWorktree: unsupported('removeWorktree'),
    listWorktrees: unsupported('listWorktrees'),
    pruneWorktrees: unsupported('pruneWorktrees'),
    mergeNoFf: unsupported('mergeNoFf'),
    diff: unsupported('diff'),
    tag: unsupported('tag'),
    branchExists: unsupported('branchExists'),
    ensureBranch: unsupported('ensureBranch'),
    status: unsupported('status'),
    isValidBranchName: unsupported('isValidBranchName'),
  };
}

function snapshot(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    worktreePath: WORKTREE,
    dirty: new Set<string>(),
    ignored: new Set<string>(['node_modules/left-pad/index.js']),
    ignoredRoots: new Set<string>(['node_modules/']),
    ...overrides,
  };
}

function request(git: Git, overrides: Record<string, unknown> = {}): Parameters<typeof commitAgentWork>[0] {
  return {
    git,
    snapshot: snapshot(),
    proposedMessage: 'feat(calc): add describeOperation',
    ticketId: 'FEAT-X-T001',
    ticketTitle: 'Add describeOperation',
    attempt: 1,
    ...overrides,
  } as Parameters<typeof commitAgentWork>[0];
}

describe('snapshotWorktree', () => {
  it('separates what is ignored from what is merely dirty', async () => {
    const git = fakeGit({
      statuses: [[entry('?', '?', 'scratch.txt')]],
      ignoredRoots: [entry('!', '!', 'node_modules/')],
      ignored: [[entry('!', '!', 'node_modules/left-pad/index.js')]],
    });

    const taken = await snapshotWorktree(git, WORKTREE);

    expect([...taken.dirty]).toEqual(['scratch.txt']);
    expect(taken.worktreePath).toBe(WORKTREE);
  });

  it('records the ignored view twice — collapsed and per-file — because git has both', () => {
    // Not a redundancy. The collapsed form is the only thing that still matches
    // a `node_modules/` which has flipped to untracked because `.gitignore` went
    // away; the per-file form is the only thing that can tell a fresh file
    // inside a pre-existing `dist/` from the directory itself. Neither is
    // derivable from the other.
    const taken = snapshot();
    expect([...taken.ignoredRoots]).toEqual(['node_modules/']);
    expect([...taken.ignored]).toEqual(['node_modules/left-pad/index.js']);
  });
});

describe('wasPresentBefore', () => {
  it('recognises a path that was merely dirty', () => {
    expect(wasPresentBefore(snapshot({ dirty: new Set(['scratch.txt']) }), 'scratch.txt')).toBe(true);
  });

  it('recognises an ignored file by its own name', () => {
    expect(wasPresentBefore(snapshot(), 'node_modules/left-pad/index.js')).toBe(true);
  });

  it('recognises the collapsed directory an agent unmasked by deleting .gitignore', () => {
    // git reports `?? node_modules/` once the ignore rule is gone. That string
    // is in neither `dirty` nor the per-file `ignored` set, and without the root
    // prefix rule the whole dependency tree is staged.
    expect(wasPresentBefore(snapshot(), 'node_modules/')).toBe(true);
  });

  it('recognises anything underneath such a directory', () => {
    expect(wasPresentBefore(snapshot(), 'node_modules/left-pad/package.json')).toBe(true);
  });

  it('does not recognise the agent’s own work', () => {
    expect(wasPresentBefore(snapshot(), 'src/describe.ts')).toBe(false);
    // And a near-miss on the prefix is not a match: `node_modules_notes.md` is
    // a real file somebody could add, and it is not inside `node_modules/`.
    expect(wasPresentBefore(snapshot(), 'node_modules_notes.md')).toBe(false);
  });
});

describe('commitAgentWork', () => {
  it('stages both halves of a rename', async () => {
    // Staging only the new name leaves the old name's deletion unstaged, so the
    // commit carries the file twice and the worktree stops matching it — which
    // the clean check below would then catch as `tree_not_clean`. Better to
    // stage it correctly in the first place.
    const git = fakeGit({
      statuses: [[entry('R', ' ', 'src/new.ts', 'src/old.ts')], []],
      staged: ['src/new.ts', 'src/old.ts'],
    });

    const outcome = await commitAgentWork(request(git));

    expect(outcome.ok).toBe(true);
    expect(git.added).toEqual([['src/new.ts', 'src/old.ts']]);
  });

  it('prunes a file the agent hid inside a directory that was already ignored', async () => {
    // The collapse bug, at unit level. The snapshot holds `dist/old-build.js`;
    // the agent adds `dist/secret.txt`. A prune that asked for the collapsed
    // view would see `!! dist/` on both sides, find nothing fresh, and leave the
    // secret in the tree for the gates to pass on.
    const git = fakeGit({
      statuses: [[entry(' ', 'M', 'src/calc.ts')], []],
      ignoredRoots: [entry('!', '!', 'dist/')],
      ignored: [[entry('!', '!', 'dist/old-build.js'), entry('!', '!', 'dist/secret.txt')]],
    });

    const outcome = await commitAgentWork(
      request(git, {
        snapshot: snapshot({
          ignored: new Set(['dist/old-build.js']),
          ignoredRoots: new Set(['dist/']),
        }),
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prunedIgnored, 'the fresh file inside dist/ was not detected').toEqual([
      'dist/secret.txt',
    ]);
    // …and the one that was already there is left alone.
    expect(outcome.prunedIgnored).not.toContain('dist/old-build.js');
  });

  it('does not stage a dependency tree unmasked by deleting .gitignore', async () => {
    // `.gitignore` is gone, so git now reports `?? node_modules/` alongside the
    // deletion. Only the deletion and the real source file may be staged.
    const git = fakeGit({
      statuses: [
        [
          entry(' ', 'D', '.gitignore'),
          entry('?', '?', 'node_modules/'),
          entry('?', '?', 'src/describe.ts'),
        ],
        [entry('?', '?', 'node_modules/')],
      ],
      ignoredRoots: [],
      ignored: [[]],
      staged: ['.gitignore', 'src/describe.ts'],
    });

    const outcome = await commitAgentWork(request(git));

    expect(outcome.ok, outcome.ok ? '' : outcome.detail).toBe(true);
    expect(git.added).toEqual([['.gitignore', 'src/describe.ts']]);
  });

  it('never stages what was already dirty before the agent ran', async () => {
    const git = fakeGit({
      statuses: [
        [entry('?', '?', 'node_modules/'), entry(' ', 'M', 'src/calc.ts')],
        [entry('?', '?', 'node_modules/')],
      ],
    });

    const outcome = await commitAgentWork(
      request(git, { snapshot: snapshot({ dirty: new Set(['node_modules/']) }) }),
    );

    expect(outcome.ok).toBe(true);
    expect(git.added).toEqual([['src/calc.ts']]);
  });

  it('refuses when the worktree still differs from the commit it just made', async () => {
    // The `tree_not_clean` refusal. The gates are about to run in this
    // directory, and a leftover here means they would verify something other
    // than the commit — silently, and with every test green.
    const git = fakeGit({
      statuses: [
        [entry(' ', 'M', 'src/calc.ts')],
        // After the commit, something is still there.
        [entry('?', '?', 'src/stray.ts')],
      ],
    });

    const outcome = await commitAgentWork(request(git));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('tree_not_clean');
    expect(outcome.detail).toContain('src/stray.ts');
    expect(outcome.detail).toContain('would therefore');
  });

  it('refuses an empty diff before it reaches git', async () => {
    const git = fakeGit({ statuses: [[]] });

    const outcome = await commitAgentWork(request(git));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_changes');
    expect(git.added, 'git add ran on an empty change set').toEqual([]);
    expect(git.commits).toEqual([]);
  });

  it('refuses when everything the agent touched came back to its committed content', async () => {
    // git reports a modification, but the index ends up empty — the file was
    // edited and then edited back. Same verdict: nothing to verify.
    const git = fakeGit({ statuses: [[entry(' ', 'M', 'src/calc.ts')]], staged: [] });

    const outcome = await commitAgentWork(request(git));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_changes');
    expect(git.commits).toEqual([]);
  });
});

describe('commitMessage', () => {
  const base = {
    git: fakeGit({ statuses: [[]] }),
    snapshot: snapshot(),
    ticketId: 'FEAT-X-T001',
    ticketTitle: 'Add describeOperation',
    attempt: 2,
  };

  it('keeps the agent’s subject line first, untouched', () => {
    const message = commitMessage({ ...base, proposedMessage: 'feat(calc): add describeOperation' });
    expect(message.split('\n')[0]).toBe('feat(calc): add describeOperation');
  });

  it('adds trailers naming the ticket and the real author', () => {
    const message = commitMessage({ ...base, proposedMessage: 'feat: x' });
    expect(message).toContain('Ticket: FEAT-X-T001');
    expect(message).toContain('Attempt: 2');
    expect(message).toContain('Committed-by: app-factory orchestrator');
  });

  it('falls back to a derived subject when the agent proposed nothing', () => {
    // The schema permits `commit_message: ''`, and `git commit` refuses an empty
    // message outright — so without this the run would die on a git error in the
    // middle of a dispatch, having done the work.
    const message = commitMessage({ ...base, proposedMessage: '   \n  ' });
    expect(message.split('\n')[0]).toBe('chore(FEAT-X-T001): Add describeOperation');
  });
});

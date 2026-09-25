/**
 * No `ShellGit` command runs the repository's own hooks (ADR-003, plan Section
 * E item 8a).
 *
 * ============================================================================
 * THIS PINS THE CLASS, NOT THE CALL SITES
 * ============================================================================
 * The escape does not need `.git/hooks`, which is what the sandbox's `denyWrite`
 * fence covers. A husky-style `prepare` script points `core.hooksPath` at a
 * **tracked** directory when Phase 8's unsandboxed `setup_command` runs `npm
 * ci`; `.git/config` is shared by every linked worktree; and the agent may then
 * edit that directory like any other worktree file. From there, any git command
 * the orchestrator runs against a tree carrying those scripts executes them
 * unsandboxed, with the orchestrator's permissions.
 *
 * Phase 9 closed it for `git commit`. Phase 10's review found `merge`,
 * `checkout` and `reset` open; the same grep then found `worktree add`, `tag`,
 * `branch` and `branch -D`. Six near-identical tests would have left the seventh
 * gap open, so this file asserts the **invariant** instead:
 *
 *   every git invocation whose subcommand can run a hook or move a ref
 *   carries `-c core.hooksPath=/dev/null`
 *
 * and separately asserts that **every method on `ShellGit` is classified** as a
 * writer or as a read. A method added later is in neither list, so it fails
 * `every ShellGit method is classified` rather than quietly joining the gap.
 *
 * `worktree add` is the case that makes this worth a whole file: it is the most
 * frequently executed git command in the factory — once per ticket
 * provisioning, again for every post-merge gate run — and the chain to it needs
 * no agent to commit anything. The orchestrator commits the agent's work to the
 * ticket branch, the merge lands it on the feature branch, and the next ticket's
 * worktree is cut from a feature branch that now carries the script.
 *
 * The evidence that the hooks really do fire without this lives next door, in
 * `test/integration/merge.test.ts`, against real git. What is asserted here is
 * the argv, which is what a mocked `exec` can see and real git cannot be made to
 * report.
 */
import { describe, expect, it } from 'vitest';

import type { ExecFn, ExecResult } from '../../../src/git/exec.js';
import { ORCHESTRATOR_IDENTITY, ShellGit } from '../../../src/git/git.js';

const REPO = '/repo';
const SHA = 'a'.repeat(40);

// ---------------------------------------------------------------------------
// Which git subcommands must be fenced.
// ---------------------------------------------------------------------------

/**
 * Subcommands that run a hook, move a ref, or check something out.
 *
 * Wider than what `ShellGit` uses today, on purpose: a future method reaching
 * for `switch`, `stash` or `cherry-pick` is covered without anyone remembering
 * to widen this. Probed against real git 2.39: `checkout` and `worktree add`
 * fire `post-checkout`; `merge` fires `pre-merge-commit`, `prepare-commit-msg`,
 * `commit-msg` and `post-merge`; and every ref move — `branch`, `branch -D`,
 * `tag`, `reset --hard`, `worktree prune` — fires `reference-transaction`.
 */
const HOOK_CAPABLE = new Set([
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'commit',
  'fetch',
  'merge',
  'notes',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'stash',
  'switch',
  'tag',
  'update-ref',
  'worktree',
]);

/**
 * `git worktree` subcommands that read rather than write.
 *
 * `list` inspects registrations and touches nothing. `add`, `remove` and
 * `prune` all change either the working tree or `.git/worktrees`, so they are
 * not here.
 */
const READ_ONLY_WORKTREE = new Set(['list']);

/** The `-c key=value` pairs and `-C <cwd>` stripped off, leaving the subcommand. */
function subcommand(argv: readonly string[]): readonly string[] {
  const tokens: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '-c' || token === '-C') {
      index += 1;
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function mustBeFenced(argv: readonly string[]): boolean {
  const tokens = subcommand(argv);
  const command = tokens[0] ?? '';
  if (!HOOK_CAPABLE.has(command)) return false;
  if (command === 'worktree' && READ_ONLY_WORKTREE.has(tokens[1] ?? '')) return false;
  return true;
}

/** `-c core.hooksPath=/dev/null` present, in the config position (before the subcommand). */
function isFenced(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === '-c' && argv[index + 1] === 'core.hooksPath=/dev/null') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// A recording `exec`.
// ---------------------------------------------------------------------------

type Reply = (tokens: readonly string[]) => { status?: number; stdout?: string };

/**
 * Enough of a plausible git for each method to reach its end.
 *
 * Only what a method *reads back* needs answering: `commit` re-resolves `HEAD`
 * and raises if it gets nothing, which would stop the argv assertion ever
 * running. A per-case `reply` overrides these.
 */
const DEFAULTS: Reply = (tokens) => (tokens[0] === 'rev-parse' ? { stdout: `${SHA}\n` } : {});

function recorder(reply: Reply = () => ({})): { calls: string[][]; exec: ExecFn } {
  const calls: string[][] = [];
  const exec: ExecFn = (file, args, options) => {
    calls.push([...args]);
    const tokens = subcommand(args);
    const { status = 0, stdout = '' } = { ...DEFAULTS(tokens), ...reply(tokens) };
    const result: ExecResult = {
      command: `${file} ${args.join(' ')}`,
      cwd: options.cwd,
      status,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
      durationMs: 1,
      spawnError: null,
    };
    return Promise.resolve(result);
  };
  return { calls, exec };
}

// ---------------------------------------------------------------------------
// Every writing method, and every reading one.
// ---------------------------------------------------------------------------

interface Case {
  /** The `ShellGit` method this exercises. Cross-checked against the prototype. */
  readonly method: string;
  /** A label, when one method has more than one route through it. */
  readonly route?: string;
  readonly reply?: Reply;
  call(git: ShellGit): Promise<unknown>;
}

/**
 * Commands that check something out or move a ref. Each must be fenced.
 *
 * Where a method has two routes — a branch that exists or does not, a reset
 * that falls back to `--hard` — both are here, because the fence is per-argv
 * and one route being fenced says nothing about the other.
 */
const WRITERS: readonly Case[] = [
  {
    method: 'createWorktree',
    route: 'branch does not exist yet',
    // `show-ref` exits 1, so `worktree add -b` is the route taken.
    reply: (tokens) => (tokens[0] === 'show-ref' ? { status: 1 } : {}),
    call: (git) => git.createWorktree('/wt/t001', 'feat/x/t001', 'feature/x'),
  },
  {
    method: 'createWorktree',
    route: 'branch already exists',
    call: (git) => git.createWorktree('/wt/t001', 'feat/x/t001', 'feature/x'),
  },
  {
    method: 'createDetachedWorktree',
    call: (git) => git.createDetachedWorktree('/wt/verify', SHA),
  },
  { method: 'removeWorktree', call: (git) => git.removeWorktree('/wt/t001', true) },
  { method: 'pruneWorktrees', call: (git) => git.pruneWorktrees() },
  {
    method: 'mergeNoFf',
    route: 'clean',
    call: (git) => git.mergeNoFf('feature/x', 'feat/x/t001'),
  },
  {
    method: 'mergeNoFf',
    route: 'conflicted, so it also aborts',
    reply: (tokens) => (tokens[0] === 'merge' && tokens[1] !== '--abort' ? { status: 1 } : {}),
    call: (git) => git.mergeNoFf('feature/x', 'feat/x/t001'),
  },
  { method: 'tag', call: (git) => git.tag('factory/x/2026-09-02', SHA) },
  {
    method: 'ensureBranch',
    reply: (tokens) => (tokens[0] === 'show-ref' ? { status: 1 } : {}),
    call: (git) => git.ensureBranch('feature/x', 'main'),
  },
  { method: 'commit', call: (git) => git.commit('/wt/t001', 'feat: x', ORCHESTRATOR_IDENTITY) },
  { method: 'checkout', route: 'onto a branch', call: (git) => git.checkout('main') },
  {
    method: 'checkout',
    route: 'detached',
    call: (git) => git.checkout(SHA, { detach: true }),
  },
  {
    method: 'resetBranch',
    route: 'branch --force succeeds',
    call: (git) => git.resetBranch('feature/x', SHA),
  },
  {
    method: 'resetBranch',
    route: 'falls back to reset --hard',
    // `branch --force` refuses because the branch is checked out here, the
    // checkout is on it, and it is clean — the `git reset --hard` route.
    reply: (tokens) => {
      if (tokens[0] === 'branch') return { status: 1 };
      if (tokens[0] === 'symbolic-ref') return { stdout: 'feature/x\n' };
      return {};
    },
    call: (git) => git.resetBranch('feature/x', SHA),
  },
  {
    method: 'deleteBranch',
    route: 'force',
    call: (git) => git.deleteBranch('feat/x/t001', { force: true }),
  },
  {
    method: 'deleteBranch',
    route: 'safe',
    call: (git) => git.deleteBranch('feat/x/t001'),
  },
];

/**
 * Methods that read, and the one that writes the index.
 *
 * Listed so the classification is exhaustive rather than "everything we
 * remembered". `add` is here rather than in `WRITERS` because git has no `add`
 * hook and staging moves no ref — it writes the index and nothing else. If that
 * ever stops being true, it moves up.
 */
const READS: readonly string[] = [
  'add',
  'branchExists',
  'currentBranch',
  'diff',
  'diffNumstat',
  'isAncestor',
  'isValidBranchName',
  'listWorktrees',
  'logRange',
  'parentsOf',
  'revParse',
  'stagedPaths',
  'status',
  'statusEntries',
];

// ---------------------------------------------------------------------------
// The invariant.
// ---------------------------------------------------------------------------

describe('every ShellGit command that can run a hook', () => {
  for (const testCase of WRITERS) {
    const label = testCase.route === undefined
      ? testCase.method
      : `${testCase.method} (${testCase.route})`;

    it(`is fenced — ${label}`, async () => {
      const { calls, exec } = recorder(testCase.reply);
      await testCase.call(new ShellGit({ repoRoot: REPO, exec }));

      expect(calls, `${label} ran no git command at all`).not.toHaveLength(0);
      const unfenced = calls.filter((argv) => mustBeFenced(argv) && !isFenced(argv));
      expect(
        unfenced.map((argv) => subcommand(argv).join(' ')),
        `${label} ran git without \`-c core.hooksPath=/dev/null\`, so the repository's own ` +
          'hooks execute unsandboxed as the orchestrator',
      ).toEqual([]);
    });
  }

  it('and at least one command in each case actually needed fencing', () => {
    // A positive control for `mustBeFenced`. If it silently stopped matching
    // anything, every assertion above would pass on an empty filter.
    for (const testCase of WRITERS) {
      expect(HOOK_CAPABLE.size, testCase.method).toBeGreaterThan(0);
    }
    expect(mustBeFenced(['-C', REPO, 'worktree', 'add', '--quiet', '/wt', 'b'])).toBe(true);
    expect(mustBeFenced(['-C', REPO, 'branch', '-D', 'b'])).toBe(true);
    expect(mustBeFenced(['-C', REPO, 'tag', 'v1', SHA])).toBe(true);
    expect(mustBeFenced(['-C', REPO, 'worktree', 'prune'])).toBe(true);
    // …and that reads are not being counted as fenced by accident.
    expect(mustBeFenced(['-C', REPO, 'worktree', 'list', '--porcelain'])).toBe(false);
    expect(mustBeFenced(['-C', REPO, 'status', '--porcelain'])).toBe(false);
    expect(isFenced(['-C', REPO, 'branch', '-D', 'b'])).toBe(false);
  });
});

describe('the classification itself', () => {
  it('covers every ShellGit method, so a new one cannot join the gap unnoticed', () => {
    // The point of the whole file. Six per-command tests would have left the
    // seventh command open; this fails the moment an eighth arrives.
    const covered = new Set<string>([...WRITERS.map((entry) => entry.method), ...READS]);
    // `run` and `must` are the private helpers every method funnels through —
    // they carry whatever argv their caller built, so they are not a route of
    // their own.
    const internal = new Set(['constructor', 'run', 'must']);
    const unclassified = Object.getOwnPropertyNames(ShellGit.prototype).filter(
      (name) => !internal.has(name) && !covered.has(name),
    );

    expect(
      unclassified,
      'these ShellGit methods are in neither WRITERS nor READS. Decide which: if the command ' +
        'checks anything out or moves any ref, it must pass `orchestratorGitConfig()` and go in ' +
        'WRITERS',
    ).toEqual([]);
  });

  it('does not claim a method that no longer exists', () => {
    const actual = new Set(Object.getOwnPropertyNames(ShellGit.prototype));
    for (const name of [...WRITERS.map((entry) => entry.method), ...READS]) {
      expect(actual.has(name), `${name} is classified but is not a ShellGit method`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// What the rest of the config is for, stated as a test.
// ---------------------------------------------------------------------------

describe('the orchestrator identity', () => {
  it('is on the two commands that write an object', async () => {
    // Resolution A6's visible half. Everywhere else the flags are inert — git
    // never reads them for a ref move — and they are passed anyway so that
    // "did this path get the fence?" is answerable by looking at one list.
    for (const call of [
      (git: ShellGit): Promise<unknown> => git.commit('/wt', 'feat: x', ORCHESTRATOR_IDENTITY),
      (git: ShellGit): Promise<unknown> => git.mergeNoFf('feature/x', 'feat/x/t001'),
    ]) {
      const { calls, exec } = recorder();
      await call(new ShellGit({ repoRoot: REPO, exec }));

      const writing = calls.filter((argv) => {
        const command = subcommand(argv)[0] ?? '';
        return command === 'commit' || command === 'merge';
      });
      expect(writing).not.toHaveLength(0);
      for (const argv of writing) {
        expect(argv).toContain(`user.name=${ORCHESTRATOR_IDENTITY.name}`);
        expect(argv).toContain(`user.email=${ORCHESTRATOR_IDENTITY.email}`);
        expect(argv).toContain('commit.gpgsign=false');
      }
    }
  });

  it('is the caller’s on `commit`, which is the only command that takes one', async () => {
    const { calls, exec } = recorder();
    await new ShellGit({ repoRoot: REPO, exec }).commit('/wt', 'feat: x', {
      name: 'Someone Else',
      email: 'else@example.invalid',
    });

    expect(calls[0]).toContain('user.name=Someone Else');
    expect(calls[0]).toContain('user.email=else@example.invalid');
  });

  it('is joined by `--no-verify` on the two commands that accept it', async () => {
    // `commit`'s comment: the flag states the intent at the call site, the
    // config is what enforces it. Both are kept, and `--no-verify` covers only
    // `pre-commit`/`commit-msg`, which is why it is never the whole answer.
    const commit = recorder();
    await new ShellGit({ repoRoot: REPO, exec: commit.exec }).commit(
      '/wt',
      'feat: x',
      ORCHESTRATOR_IDENTITY,
    );
    expect(commit.calls[0]).toContain('--no-verify');

    const merge = recorder();
    await new ShellGit({ repoRoot: REPO, exec: merge.exec }).mergeNoFf('feature/x', 'feat/x/t001');
    const mergeArgv = merge.calls.find((argv) => subcommand(argv)[0] === 'merge');
    expect(mergeArgv, 'no merge command was run').not.toBeUndefined();
    expect(mergeArgv).toContain('--no-verify');
  });

  /**
   * ==========================================================================
   * ADDED IN PHASE 11 — `tag.gpgsign` IS NOT ONLY AN ANNOTATED-TAG SETTING
   * ==========================================================================
   * `ShellGit.tag`'s comment used to reason that a lightweight tag reads no
   * signing setting, so `commit.gpgsign=false` was enough. Probed on git 2.39.5
   * while writing the Phase 11 feature close, that is false:
   * `tag.gpgsign=true` promotes a bare `git tag <name> <ref>` into a signed tag
   * and it then dies with `fatal: no tag message?`.
   *
   * The real-git half is `test/integration/feature-close.test.ts`, which
   * configures a repo to sign and shows plain git failing there. This is the
   * argv half — and it covers the whole class rather than `tag` alone, because
   * the flag went into the shared config for the reason `core.hooksPath` did.
   */
  it('switches tag signing off, on tag and on every other fenced command', async () => {
    const { calls, exec } = recorder();
    const git = new ShellGit({ repoRoot: REPO, exec });

    await git.tag('factory/x/2026-09-02', SHA);
    const tagArgv = calls.find((argv) => subcommand(argv)[0] === 'tag');
    expect(tagArgv, 'no tag command was run').not.toBeUndefined();
    expect(
      tagArgv,
      'a repo with tag.gpgsign=true would fail this tag with "fatal: no tag message?"',
    ).toContain('tag.gpgsign=false');
    // Still lightweight: no `-a`, no `-s`. An annotated tag would need a
    // message, and `featureClose` relies on the tag naming the commit directly.
    expect(tagArgv).not.toContain('-a');
    expect(tagArgv).not.toContain('-s');

    // And it is in the shared set, not bolted onto one method.
    const commit = recorder();
    await new ShellGit({ repoRoot: REPO, exec: commit.exec }).commit(
      '/wt',
      'feat: x',
      ORCHESTRATOR_IDENTITY,
    );
    expect(commit.calls[0]).toContain('tag.gpgsign=false');
  });
});

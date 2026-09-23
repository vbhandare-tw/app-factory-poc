/**
 * The ticket merge's decisions (plan Phase 10, `src/orchestrator/merge.ts`).
 *
 * ============================================================================
 * WHY A MOCKED `Git` RATHER THAN A REAL ONE
 * ============================================================================
 * Every case here is about a **sequence of git commands**, and half of them are
 * about a sequence that only happens when something has already gone wrong. Real
 * git can be made to conflict; it cannot easily be made to fail a `reset` after
 * a successful merge, or to throw from inside a gate run, and those are exactly
 * the paths where a bad merge would be left on a shared branch.
 *
 * The mock also lets a test assert that a command was **asked for**. The
 * integration file next door checks that the feature branch ended up back at the
 * right SHA; that assertion passes for an implementation which never merged at
 * all. Here the calls themselves are the evidence.
 *
 * ============================================================================
 * THE CASE THIS FILE EXISTS FOR
 * ============================================================================
 * `git merge --abort` only works while a merge is **in progress**. The
 * post-merge gates run after the merge has committed, so a red gate has no abort
 * available to it — and a feature branch left carrying a merge that fails its
 * own gates poisons every later ticket, whose merge then looks like the culprit.
 * `a red post-merge gate` below is that case, asserted on the reset call rather
 * than on the outcome object.
 */
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config/load.js';
import type { FactoryConfig } from '../../../src/config/schema.js';
import { GATE_NAMES } from '../../../src/domain/states.js';
import type { GateResults } from '../../../src/gates/results.js';
import type { GateConfig, GateRunner, GateRunOptions } from '../../../src/gates/runner.js';
import type { Git, MergeResult, StatusEntry } from '../../../src/git/git.js';
import { MemoryEventLog } from '../../../src/log/events.js';
import type { FeatureVerifyRequest, Workspace } from '../../../src/orchestrator/dispatchTypes.js';
import { mergeTicket } from '../../../src/orchestrator/merge.js';
import type { MergeTicketInput } from '../../../src/orchestrator/merge.js';
import { VaultPaths } from '../../../src/vault/paths.js';

const REPO = '/repo';
const FEATURE_BRANCH = 'feature/sample';
const TICKET_BRANCH = 'feat/sample/t001-add-a-describe-helper';
const TICKET_ID = 'FEAT-SAMPLE-T001';
const BEFORE = 'b'.repeat(40);
const MERGED = 'c'.repeat(40);

// ---------------------------------------------------------------------------
// A `Git` that records what it was asked to do.
// ---------------------------------------------------------------------------

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface FakeGitOptions {
  readonly merge?: MergeResult;
  /**
   * `mergeNoFf` raises instead of returning. Real `ShellGit.mergeNoFf` does
   * exactly this when `git checkout <feature>` is refused — which real git does
   * when an untracked file in the main checkout is tracked on the feature
   * branch. Nothing was merged, so the repository is untouched.
   */
  readonly mergeThrows?: string;
  /** `git status --porcelain` on the **main checkout**, as entries. */
  readonly mainStatus?: readonly StatusEntry[];
  readonly branches?: readonly string[];
  /** The branch the main checkout is on when the merge starts. */
  readonly startingBranch?: string | null;
  /** Fails the branch reset, i.e. the merge cannot be undone. */
  readonly resetFails?: boolean;
  readonly deleteFails?: boolean;
  readonly removeWorktreeFails?: boolean;
}

interface FakeGit extends Git {
  readonly calls: Call[];
  names(): string[];
}

function fakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: Call[] = [];
  const branches = new Set(options.branches ?? [FEATURE_BRANCH, TICKET_BRANCH]);
  // Starts at BEFORE, becomes MERGED on a successful merge, and goes back to
  // whatever `resetBranch` is given. A fixture that always answered `BEFORE`
  // would make "the branch was put back" true without anything putting it back.
  let featureSha = BEFORE;
  let head: string | null = options.startingBranch === undefined ? 'main' : options.startingBranch;

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const unsupported = (name: string) => (): never => {
    throw new Error(`fakeGit does not implement ${name}`);
  };

  const git: FakeGit = {
    calls,
    names: (): string[] => calls.map((call) => call.name),
    repoRoot: REPO,

    branchExists: (branch: string): Promise<boolean> => {
      record('branchExists', branch);
      return Promise.resolve(branches.has(branch));
    },
    statusEntries: (worktree: string): Promise<StatusEntry[]> => {
      record('statusEntries', worktree);
      return Promise.resolve([...(options.mainStatus ?? [])]);
    },
    revParse: (worktree: string, ref: string): Promise<string | null> => {
      record('revParse', worktree, ref);
      if (ref === FEATURE_BRANCH) return Promise.resolve(featureSha);
      if (ref === 'HEAD') return Promise.resolve(head === null ? 'd'.repeat(40) : featureSha);
      return Promise.resolve(null);
    },
    currentBranch: (worktree?: string): Promise<string | null> => {
      record('currentBranch', worktree);
      return Promise.resolve(head);
    },
    mergeNoFf: (into: string, from: string): Promise<MergeResult> => {
      record('mergeNoFf', into, from);
      if (options.mergeThrows !== undefined) {
        // Thrown before the checkout takes effect: `ShellGit.mergeNoFf` raises
        // on a *refused* checkout, so the repo is still where it started.
        return Promise.reject(new Error(options.mergeThrows));
      }
      // Real `mergeNoFf` checks the target out and leaves the repo on it.
      head = into;
      const result = options.merge ?? { ok: true as const };
      if (result.ok) featureSha = MERGED;
      return Promise.resolve(result);
    },
    resetBranch: (branch: string, sha: string): Promise<void> => {
      record('resetBranch', branch, sha);
      if (options.resetFails === true) {
        return Promise.reject(new Error('git branch --force refused: no such commit'));
      }
      if (branch === FEATURE_BRANCH) featureSha = sha;
      return Promise.resolve();
    },
    checkout: (target: string, checkoutOptions?: { readonly detach?: boolean }): Promise<void> => {
      record('checkout', target, checkoutOptions?.detach === true);
      head = checkoutOptions?.detach === true ? null : target;
      return Promise.resolve();
    },
    deleteBranch: (branch: string): Promise<void> => {
      record('deleteBranch', branch);
      if (options.deleteFails === true) {
        return Promise.reject(new Error('git branch -D refused'));
      }
      branches.delete(branch);
      return Promise.resolve();
    },
    removeWorktree: (worktreePath: string, force: boolean): Promise<void> => {
      record('removeWorktree', worktreePath, force);
      if (options.removeWorktreeFails === true) {
        return Promise.reject(new Error('git worktree remove refused'));
      }
      return Promise.resolve();
    },
    pruneWorktrees: (): Promise<void> => {
      record('pruneWorktrees');
      return Promise.resolve();
    },

    createWorktree: unsupported('createWorktree'),
    createDetachedWorktree: unsupported('createDetachedWorktree'),
    listWorktrees: unsupported('listWorktrees'),
    diff: unsupported('diff'),
    tag: unsupported('tag'),
    ensureBranch: unsupported('ensureBranch'),
    status: unsupported('status'),
    isAncestor: unsupported('isAncestor'),
    parentsOf: unsupported('parentsOf'),
    isValidBranchName: unsupported('isValidBranchName'),
    add: unsupported('add'),
    stagedPaths: unsupported('stagedPaths'),
    commit: unsupported('commit'),
    logRange: unsupported('logRange'),
    diffNumstat: unsupported('diffNumstat'),
  };

  return git;
}

// ---------------------------------------------------------------------------
// Gates and workspaces.
// ---------------------------------------------------------------------------

function results(statuses: Partial<Record<string, 'pass' | 'fail' | 'skipped'>>): GateResults {
  return Object.fromEntries(
    GATE_NAMES.map((gate) => [
      gate,
      {
        status: statuses[gate] ?? 'pass',
        exitCode: (statuses[gate] ?? 'pass') === 'pass' ? 0 : 1,
        durationMs: 1,
        output: `${gate} output`,
        logPath: '',
        command: `npm run ${gate}`,
      },
    ]),
  ) as GateResults;
}

interface FakeGates extends GateRunner {
  readonly cwds: string[];
}

function fakeGates(outcome: GateResults | Error): FakeGates {
  const cwds: string[] = [];
  return {
    cwds,
    run: (cwd: string, _gates: GateConfig, _options: GateRunOptions): Promise<GateResults> => {
      cwds.push(cwd);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
  };
}

interface FakeWorkspace {
  readonly requests: FeatureVerifyRequest[];
  readonly disposed: string[];
  provide(request: FeatureVerifyRequest): Promise<Workspace>;
}

function fakeWorkspace(): FakeWorkspace {
  const requests: FeatureVerifyRequest[] = [];
  const disposed: string[] = [];
  return {
    requests,
    disposed,
    provide: (request: FeatureVerifyRequest): Promise<Workspace> => {
      requests.push(request);
      const cwd = `/scratch/${request.ticketId}`;
      return Promise.resolve({
        cwd,
        dispose: (): Promise<void> => {
          disposed.push(cwd);
          return Promise.resolve();
        },
      });
    },
  };
}

const CONFIG: FactoryConfig = parseConfig(
  ['target_repo: /repo', 'base_branch: main'].join('\n'),
  '/vault/config.yml',
);

interface Harness {
  readonly git: FakeGit;
  readonly gates: FakeGates;
  readonly workspace: FakeWorkspace;
  readonly events: MemoryEventLog;
  readonly input: MergeTicketInput;
}

function harness(
  options: FakeGitOptions & {
    readonly gates?: GateResults | Error;
    readonly worktreePath?: string | null;
  } = {},
): Harness {
  const git = fakeGit(options);
  const gates = fakeGates(options.gates ?? results({}));
  const workspace = fakeWorkspace();
  const events = new MemoryEventLog(() => '2026-09-02T10:00:00.000Z');

  return {
    git,
    gates,
    workspace,
    events,
    input: {
      git,
      gates,
      config: CONFIG,
      paths: new VaultPaths('/vault'),
      featureWorkspace: workspace.provide,
      events,
      ticketId: TICKET_ID,
      featureSlug: 'sample',
      ticketBranch: TICKET_BRANCH,
      featureBranch: FEATURE_BRANCH,
      attempt: 1,
      worktreePath: options.worktreePath === undefined ? '/worktrees/T001' : options.worktreePath,
    },
  };
}

/** What the fake thinks the feature branch points at now. */
async function featureSha(git: FakeGit): Promise<string | null> {
  return await git.revParse(REPO, FEATURE_BRANCH);
}

// ---------------------------------------------------------------------------
// The green path.
// ---------------------------------------------------------------------------

describe('a clean merge', () => {
  it('runs the gates on the feature branch, in a tree cut from the merge commit', async () => {
    const h = harness();

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('merged');
    expect(h.gates.cwds, 'the gates did not run').toHaveLength(1);
    // Asserted on the request, not on the outcome: the whole point of J3 is
    // *where* the gates ran. A run in the main checkout would verify whatever
    // the operator left there rather than the merge.
    expect(h.workspace.requests[0]?.ref, 'the gates ran against something other than the merge').toBe(
      MERGED,
    );
    expect(h.workspace.requests[0]?.branch).toBe(FEATURE_BRANCH);
    expect(h.gates.cwds[0]).not.toBe(REPO);
    expect(h.gates.cwds[0]).toBe(`/scratch/${TICKET_ID}`);
    // And the throwaway tree is destroyed afterwards.
    expect(h.workspace.disposed).toEqual([`/scratch/${TICKET_ID}`]);
  });

  it('removes the worktree, then deletes the ticket branch — in that order', async () => {
    // The order is forced, not chosen: git refuses to delete a branch that is
    // checked out in a worktree. Deleting first fails every time, and the
    // failure reads as an unexplained git error rather than as a missing step.
    const h = harness();

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind === 'merged' && outcome.branchDeleted).toBe(true);
    expect(outcome.kind === 'merged' && outcome.worktreeRemoved).toBe(true);
    const names = h.git.names();
    expect(names).toContain('removeWorktree');
    expect(names).toContain('deleteBranch');
    expect(
      names.indexOf('removeWorktree'),
      'the branch was deleted before its worktree was removed',
    ).toBeLessThan(names.indexOf('deleteBranch'));
  });

  it('does not delete the branch when the worktree could not be removed', async () => {
    // Otherwise the delete fails anyway, and its error is the confusing one.
    const h = harness({ removeWorktreeFails: true });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('merged');
    expect(outcome.kind === 'merged' && outcome.worktreeRemoved).toBe(false);
    expect(outcome.kind === 'merged' && outcome.branchDeleted).toBe(false);
    expect(h.git.names()).not.toContain('deleteBranch');
  });

  it('leaves the merge in place when the branch delete fails', async () => {
    const h = harness({ deleteFails: true });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('merged');
    expect(outcome.kind === 'merged' && outcome.branchDeleted).toBe(false);
    expect(await featureSha(h.git), 'a failed cleanup undid a good merge').toBe(MERGED);
    expect(h.events.ofType('merge_cleanup_failed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE CASE THIS FILE EXISTS FOR — a red post-merge gate.
// ---------------------------------------------------------------------------

describe('a red post-merge gate', () => {
  it('resets the feature branch to its pre-merge SHA', async () => {
    // `git merge --abort` cannot help here: the merge has already committed.
    // Left in place, the branch permanently carries a merge that fails its own
    // gates and every later ticket merges on top of it.
    const h = harness({ gates: results({ tests: 'fail' }) });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('gates_red');
    expect(h.git.calls.filter((call) => call.name === 'resetBranch')).toEqual([
      { name: 'resetBranch', args: [FEATURE_BRANCH, BEFORE] },
    ]);
    expect(await featureSha(h.git), 'the bad merge is still on the feature branch').toBe(BEFORE);
    expect(outcome.kind === 'gates_red' && outcome.reverted).toBe(true);
  });

  it('does not set done, and reports both SHAs', async () => {
    const h = harness({ gates: results({ build: 'fail' }) });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('gates_red');
    expect(outcome.kind === 'gates_red' && outcome.beforeSha).toBe(BEFORE);
    expect(outcome.kind === 'gates_red' && outcome.mergeSha).toBe(MERGED);
    expect(outcome.kind === 'gates_red' && outcome.detail).toContain('build');
  });

  it('does not delete the ticket branch or its worktree', async () => {
    // The ticket branch is the only place the work still exists once the merge
    // is undone. Deleting it here would destroy it outright.
    const h = harness({ gates: results({ lint: 'fail' }) });

    await mergeTicket(h.input);

    expect(h.git.names()).not.toContain('deleteBranch');
    expect(h.git.names()).not.toContain('removeWorktree');
  });

  it('resets even when the gate run itself throws', async () => {
    // A gate runner that throws leaves the same bad merge as a red one. The
    // conflict path's "abort on every path" rule has an equivalent here, and it
    // is a different mechanism: a reset, not an abort.
    const h = harness({ gates: new Error('the gate runner exploded') });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('gates_red');
    expect(await featureSha(h.git)).toBe(BEFORE);
    expect(outcome.kind === 'gates_red' && outcome.detail).toContain('exploded');
    // The throwaway tree is still disposed of.
    expect(h.workspace.disposed).toHaveLength(1);
  });

  it('says so loudly when the reset itself fails', async () => {
    // The only state worse than a bad merge is a bad merge nobody was told
    // about. `reverted: false` is what the dispatcher turns into a pause detail
    // telling a human to reset the branch by hand.
    const h = harness({ gates: results({ tests: 'fail' }), resetFails: true });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind === 'gates_red' && outcome.reverted).toBe(false);
    expect(outcome.kind === 'gates_red' && outcome.revertError).toContain('refused');
    expect(h.events.ofType('merge_revert_failed')).toHaveLength(1);
    expect(h.events.ofType('merge_reverted')).toHaveLength(0);
  });

  it('records the revert in the event log', async () => {
    const h = harness({ gates: results({ tests: 'fail' }) });

    await mergeTicket(h.input);

    const reverted = h.events.ofType('merge_reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.branch).toBe(FEATURE_BRANCH);
    expect(reverted[0]?.toSha).toBe(BEFORE);
    expect(h.events.ofType('merge_completed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflicts.
// ---------------------------------------------------------------------------

describe('a conflict', () => {
  const CONFLICT: MergeResult = {
    ok: false,
    conflicts: ['src/calc.ts', 'src/calc.test.ts'],
    detail: 'git merge exited 1',
  };

  it('reports the conflicted paths and runs no gates', async () => {
    const h = harness({ merge: CONFLICT });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('conflict');
    expect(outcome.kind === 'conflict' && outcome.conflicts).toEqual([
      'src/calc.ts',
      'src/calc.test.ts',
    ]);
    expect(h.gates.cwds, 'the gates ran on a conflicted merge').toHaveLength(0);
    expect(h.workspace.requests, 'a worktree was provisioned for a merge that never landed').toHaveLength(
      0,
    );
  });

  it('leaves the feature branch exactly where it was, and deletes nothing', async () => {
    const h = harness({ merge: CONFLICT });

    await mergeTicket(h.input);

    expect(await featureSha(h.git)).toBe(BEFORE);
    expect(h.git.names()).not.toContain('deleteBranch');
    expect(h.git.names()).not.toContain('removeWorktree');
    // No reset either: `mergeNoFf` aborts, so there is nothing to undo.
    expect(h.git.names()).not.toContain('resetBranch');
  });
});

// ---------------------------------------------------------------------------
// The main checkout.
// ---------------------------------------------------------------------------

describe('the operator’s main checkout', () => {
  /**
   * ==========================================================================
   * `x` IS THE INDEX COLUMN — A HUMAN'S EDIT LIVES IN `y`
   * ==========================================================================
   * `staged()` below is `M ` — a modification that has been `git add`ed. That is
   * *not* the state a human is usually in, and a fixture built only from it made
   * this whole `describe` block pass against a filter that additionally dropped
   * `x === ' '`: every unstaged edit — the common case, and the one `git reset
   * --hard` destroys — would have been read as a clean checkout. Only the
   * integration suite caught it.
   *
   * So the realistic porcelain codes are fixtures of their own: ` M` for an
   * unstaged edit, ` D` for an unstaged delete, `UU` for a file left unresolved
   * by someone's own half-finished merge.
   */
  function staged(file: string): StatusEntry {
    return { x: 'M', y: ' ', path: file, originalPath: null };
  }
  function unstaged(file: string): StatusEntry {
    return { x: ' ', y: 'M', path: file, originalPath: null };
  }
  function unstagedDelete(file: string): StatusEntry {
    return { x: ' ', y: 'D', path: file, originalPath: null };
  }
  function unresolved(file: string): StatusEntry {
    return { x: 'U', y: 'U', path: file, originalPath: null };
  }
  function untracked(file: string): StatusEntry {
    return { x: '?', y: '?', path: file, originalPath: null };
  }

  it('refuses to merge when it carries uncommitted tracked changes', async () => {
    // Phase 9's guarantee, one level up: what is verified must be the commit.
    // And the revert path runs `git reset --hard` on this checkout, which would
    // destroy exactly these edits.
    const h = harness({ mainStatus: [staged('src/calc.ts')] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain('src/calc.ts');
    expect(h.git.names(), 'a dirty checkout was merged into').not.toContain('mergeNoFf');
    expect(await featureSha(h.git)).toBe(BEFORE);
  });

  it('refuses for an *unstaged* edit too — the state a human is actually in', async () => {
    // ` M`, not `M `. See the note above: this is the case a plausible-looking
    // filter drops, and dropping it means `reset --hard` eats a real edit.
    const h = harness({ mainStatus: [unstaged('src/calc.ts')] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind, 'an unstaged edit was read as a clean checkout').toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain('src/calc.ts');
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('refuses for an unstaged delete', async () => {
    const h = harness({ mainStatus: [unstagedDelete('src/gone.ts')] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain('src/gone.ts');
  });

  it('refuses for a file left unresolved by someone else’s merge', async () => {
    // `UU`. Merging on top of a conflicted tree is not a thing to attempt at all.
    const h = harness({ mainStatus: [unresolved('src/calc.ts')] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('merges anyway when the only mess is untracked files', async () => {
    // `git checkout` never silently overwrites an untracked file, `reset --hard`
    // does not delete one, and the gates run in a tree where it is not present.
    // Refusing here would stall every merge for a repo with a notes.txt in it.
    const h = harness({ mainStatus: [untracked('notes.txt')] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('merged');
  });

  it('is returned to the branch it was on', async () => {
    // `mergeNoFf` checks the feature branch out and leaves the repo there. The
    // operator's checkout is theirs; the factory borrowed it for one command.
    const h = harness({ startingBranch: 'main' });

    await mergeTicket(h.input);

    expect(await h.git.currentBranch(REPO), 'the checkout was left on the feature branch').toBe(
      'main',
    );
    expect(h.git.calls.some((call) => call.name === 'checkout' && call.args[0] === 'main')).toBe(true);
  });

  it('is returned even after a conflict', async () => {
    const h = harness({
      startingBranch: 'main',
      merge: { ok: false, conflicts: ['src/calc.ts'], detail: 'conflict' },
    });

    await mergeTicket(h.input);

    expect(await h.git.currentBranch(REPO)).toBe('main');
  });

  it('is returned even after a red gate reset', async () => {
    const h = harness({ startingBranch: 'main', gates: results({ tests: 'fail' }) });

    await mergeTicket(h.input);

    expect(await h.git.currentBranch(REPO)).toBe('main');
  });

  it('is left detached when it started detached, rather than put on a branch', async () => {
    const h = harness({ startingBranch: null });

    await mergeTicket(h.input);

    const restore = h.git.calls.filter((call) => call.name === 'checkout');
    expect(restore, 'nothing put the detached HEAD back').toHaveLength(1);
    expect(restore[0]?.args[1], 'a detached HEAD was restored onto a branch').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE ORDER THE REVERT HAPPENS IN.
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * WHY THE ORDER IS THE SAFETY PROPERTY, NOT A TIDINESS ONE
 * ============================================================================
 * `resetBranch` tries `git branch --force` first and only falls back to `git
 * reset --hard` when the branch is the one *currently checked out*. So putting
 * the operator's checkout back on its own branch **before** reverting makes
 * `branch --force` succeed, and no working tree is touched at all.
 *
 * Restore afterwards — which is what this module did before — and every revert
 * runs `reset --hard` in the operator's checkout. The pre-merge dirty check
 * cannot cover that: the post-merge gates run in between and take as long as
 * the target repo's test suite, and a human editing a file in that window loses
 * it. What this file can prove is the *order*; only real git can prove the file
 * survives, which `test/integration/merge.test.ts` does.
 */
describe('the revert order', () => {
  it('puts the checkout back before it moves the branch', async () => {
    const h = harness({ startingBranch: 'main', gates: results({ tests: 'fail' }) });

    await mergeTicket(h.input);

    const names = h.git.names();
    const restore = h.git.calls.findIndex(
      (call) => call.name === 'checkout' && call.args[0] === 'main',
    );
    const reset = names.indexOf('resetBranch');
    expect(restore, 'nothing restored the checkout').toBeGreaterThanOrEqual(0);
    expect(reset, 'nothing reverted the branch').toBeGreaterThanOrEqual(0);
    expect(
      restore,
      'the branch was reverted while the operator’s checkout still held it — ' +
        'that is the `git reset --hard` path',
    ).toBeLessThan(reset);
  });

  it('restores exactly once, not again in the finally', async () => {
    const h = harness({ startingBranch: 'main', gates: results({ tests: 'fail' }) });

    await mergeTicket(h.input);

    expect(h.git.calls.filter((call) => call.name === 'checkout')).toHaveLength(1);
  });

  it('restores before the revert on the gate-run-threw path too', async () => {
    const h = harness({ startingBranch: 'main', gates: new Error('the gate runner exploded') });

    await mergeTicket(h.input);

    const names = h.git.names();
    expect(names.indexOf('checkout')).toBeLessThan(names.indexOf('resetBranch'));
  });

  it('restores a detached HEAD before the revert, and only once', async () => {
    const h = harness({ startingBranch: null, gates: results({ tests: 'fail' }) });

    await mergeTicket(h.input);

    const restores = h.git.calls.filter((call) => call.name === 'checkout');
    expect(restores).toHaveLength(1);
    expect(restores[0]?.args[1], 'a detached HEAD was restored onto a branch').toBe(true);
    expect(h.git.names().indexOf('checkout')).toBeLessThan(h.git.names().indexOf('resetBranch'));
  });
});

// ---------------------------------------------------------------------------
// Preconditions.
// ---------------------------------------------------------------------------

describe('preconditions', () => {
  it('refuses when the feature branch does not exist', async () => {
    const h = harness({ branches: [TICKET_BRANCH] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('refuses when the ticket branch does not exist', async () => {
    const h = harness({ branches: [FEATURE_BRANCH] });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain(TICKET_BRANCH);
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('reports a refused checkout instead of raising it', async () => {
    // Real git refuses `git checkout <feature>` when an untracked file in the
    // main checkout is tracked on the feature branch, and `ShellGit.mergeNoFf`
    // raises. Left uncaught, the loop treats it as a dispatch failure, releases
    // the claim, and the ticket sits at `merge` forever — retried every cycle,
    // no pause, no attempt charged, nobody told.
    const h = harness({
      mergeThrows:
        'git checkout feature/sample failed: The following untracked working tree files would ' +
        'be overwritten by checkout: src/describe.ts',
    });

    const outcome = await mergeTicket(h.input);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail, 'git’s own message was dropped').toContain(
      'untracked working tree files',
    );
    // Nothing was merged, so there is nothing to undo and nothing to delete.
    expect(h.git.names()).not.toContain('resetBranch');
    expect(h.git.names()).not.toContain('deleteBranch');
    expect(await featureSha(h.git)).toBe(BEFORE);
  });
});

// ---------------------------------------------------------------------------
// The base branch is Phase 11's, and only Phase 11's (Section E item 8).
// ---------------------------------------------------------------------------

/**
 * ADR-001 makes the vault human-editable, so `feature_branch` and a ticket's
 * `branch` are both values a person can type. `featureBranchFor` returns the
 * note's field unconditionally, so `feature_branch: main` would have this module
 * merge into the base branch and then `resetBranch` rewind it — and `branch:
 * main` on a ticket would end with `git branch -D main`. Nothing else in the
 * pipeline checks, so the refusal lives here.
 */
describe('the base branch', () => {
  it('is never merged into', async () => {
    const h = harness({ branches: ['main', TICKET_BRANCH] });

    const outcome = await mergeTicket({ ...h.input, featureBranch: 'main' });

    expect(outcome.kind).toBe('refused');
    // The reason has to be *this* one. Asserting only `refused` would pass on
    // the fixture's incidental "main does not resolve to a commit" answer.
    expect(outcome.kind === 'refused' && outcome.detail).toContain('the base branch');
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('resetBranch');
    // Refused before git was asked anything at all.
    expect(h.git.names(), 'the base branch was inspected before being refused').toEqual([]);
  });

  it('is never merged from, and so never deleted', async () => {
    const h = harness({ branches: [FEATURE_BRANCH, 'main'] });

    const outcome = await mergeTicket({ ...h.input, ticketBranch: 'main' });

    expect(outcome.kind).toBe('refused');
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('deleteBranch');
  });

  it('refuses a ticket branch that is the feature branch', async () => {
    // `git merge --no-ff <itself>` is a no-op that then deletes the branch the
    // whole feature lives on.
    const h = harness();

    const outcome = await mergeTicket({ ...h.input, ticketBranch: FEATURE_BRANCH });

    expect(outcome.kind).toBe('refused');
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('deleteBranch');
  });
});

/**
 * The ticket merge against real git (plan Phase 10).
 *
 * Real repository, real branches, real worktrees, real subprocess gates. The
 * only thing faked is the model.
 *
 * ============================================================================
 * THE FAILURE THESE TESTS EXIST TO CATCH
 * ============================================================================
 * A feature branch that permanently carries a merge which fails its own gates.
 *
 * `git merge --abort` only works while a merge is **in progress**, and the
 * post-merge gates run after the merge has committed — so a red gate there has
 * no abort available to it. Left alone, every later ticket merges on top of a
 * broken branch and the *next* ticket's merge looks like the culprit. Nothing in
 * the Phase 9 suite could have caught it: every gate run before this phase
 * happened in a throwaway ticket worktree cut fresh from the feature branch, and
 * no test anywhere asserted anything about the feature branch's SHA.
 *
 * `a ticket that breaks the feature branch when combined` below is that case,
 * and it asserts the **SHA**: the branch is back exactly where it was, and the
 * merge commit is not an ancestor of it.
 *
 * ============================================================================
 * WHY THE TICKETS ARE BUILT BEFORE EITHER IS MERGED
 * ============================================================================
 * Two branches can only conflict, or break in combination, if neither was cut
 * from the other. The orchestrator produces exactly that on its own — a ticket
 * that bounces while another advances ends up with an older branch — but the
 * shortest honest way to reach it in a test is to run the dev loop with no merge
 * capability, which leaves both tickets waiting at `merge` with branches cut
 * from the same commit, and then hand the orchestrator the capability.
 *
 * That is not a contrivance: it is exactly what `canMergeTickets` describes, and
 * the first case below asserts the waiting-at-merge half of it directly.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import type { FeatureFrontmatter, TicketFrontmatter } from '../../src/domain/types.js';
import { ORCHESTRATOR_IDENTITY, ShellGit } from '../../src/git/git.js';
import { vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { Orchestrator } from '../../src/orchestrator/loop.js';
import {
  developerPayload,
  devVault,
  qaPayload,
  realCapability,
  reviewerPayload,
  scriptedAgents,
  SLUG,
  TICKET_ID,
} from '../helpers/devLoopFixtures.js';
import type { AgentStep, Capability, ScriptedRunner } from '../helpers/devLoopFixtures.js';
import { makeTicket } from '../helpers/notes.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { readNoteFile } from '../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, git, toyRepo } from '../helpers/toyRepo.js';
import type { FeatureVerifyRequest, Workspace } from '../../src/orchestrator/dispatchTypes.js';
import { appendToSection } from '../../src/vault/storage.js';

const SECOND_TICKET_ID = 'FEAT-SAMPLE-T002';
const FEATURE_BRANCH = 'feature/sample';

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let vault: FactoryFixture;
let events: MemoryEventLog;
let clockMs: number;
const worktreeRoots = new Set<string>();

function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

beforeEach(() => {
  clockMs = Date.parse('2026-09-02T10:00:00.000Z');
  events = new MemoryEventLog(now);
});

afterEach(() => {
  vault?.cleanup();
});

afterAll(() => {
  for (const root of worktreeRoots) rmSync(root, { recursive: true, force: true });
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

/** A vault with one ticket, or two independent ones. */
async function openVault(options: { readonly tickets?: 1 | 2 } = {}): Promise<FactoryFixture> {
  vault = await devVault();
  worktreeRoots.add(worktreeRoot(vault.config.target_repo, vaultWorktreeName(vault.paths.root)));

  if (options.tickets === 2) {
    // The body matters: the QA recipe requires `## Acceptance Criteria` and
    // refuses to run without it, so a ticket with an empty body never leaves
    // `qa` and every merge assertion below would be about a ticket that never
    // arrived.
    let body = '';
    body = appendToSection(body, SECTION.rawRequirement, 'Add a second helper to the calculator.');
    body = appendToSection(body, SECTION.acceptanceCriteria, '- the second helper returns a string');

    await vault.storage.writeNote(
      vault.paths.ticketPath(SLUG, SECOND_TICKET_ID),
      makeTicket(
        {
          id: SECOND_TICKET_ID,
          feature: SLUG,
          title: 'Add a second helper',
          ordinal: 2,
          status: 'ready',
        },
        body,
      ),
    );
  }

  return vault;
}

/**
 * Run the loop.
 *
 * `merge` chooses whether the orchestrator is given somewhere to verify a merge
 * — which is the whole difference between a ticket that lands and one that waits
 * (`canMergeTickets`).
 */
async function drive(
  runner: ScriptedRunner,
  cycles: number,
  options: { readonly merge: boolean; readonly capability?: Capability } = { merge: true },
): Promise<void> {
  const capability = options.capability ?? realCapability(vault, { events, now });
  const instance = await Orchestrator.start({
    paths: vault.paths,
    config: vault.config,
    storage: vault.storage,
    runner,
    events,
    now,
    isAlive: () => true,
    workspace: capability.workspace,
    reconcile: capability.reconcile,
    git: capability.git,
    gates: capability.gates,
    ...(options.merge ? { featureWorkspace: capability.featureWorkspace } : {}),
  });
  try {
    await instance.run({ maxCycles: cycles, sleep: async () => undefined });
  } finally {
    await instance.shutdown();
  }
}

function ticket(id = TICKET_ID): { frontmatter: TicketFrontmatter; body: string } {
  const note = readNoteFile(vault.paths.ticketPath(SLUG, id));
  return { frontmatter: note.frontmatter as TicketFrontmatter, body: note.body };
}

function feature(): FeatureFrontmatter {
  return readNoteFile(vault.paths.featureNote(SLUG)).frontmatter as FeatureFrontmatter;
}

function transitions(id = TICKET_ID): string[] {
  return historyLines(ticket(id).body).map((line) => line.split(' | ')[1] ?? '');
}

function sha(ref: string): string {
  return git(vault.repo.path, ['rev-parse', ref]).trim();
}

function branches(): string[] {
  return git(vault.repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/** Commit subjects on a ref, newest first. */
function subjects(ref: string): string[] {
  return git(vault.repo.path, ['log', '--format=%s', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isAncestor(candidate: string, ref: string): boolean {
  try {
    git(vault.repo.path, ['merge-base', '--is-ancestor', candidate, ref]);
    return true;
  } catch {
    return false;
  }
}

/** Nothing half-merged, nothing staged, no MERGE_HEAD. */
function repoIsMidMerge(): boolean {
  return existsSync(path.join(vault.repo.path, '.git', 'MERGE_HEAD'));
}

// ---------------------------------------------------------------------------
// The change each scripted Developer makes.
// ---------------------------------------------------------------------------

/**
 * Replace `needle` with `replacement`, or throw.
 *
 * Throwing matters: a fixture edit that silently matched nothing would leave a
 * ticket that changes nothing, which bounces as `no_changes` — and the test
 * would then be asserting about a merge that never had anything to merge.
 */
function patch(file: string, needle: string, replacement: string): void {
  const before = readFileSync(file, 'utf8');
  if (!before.includes(needle)) {
    throw new Error(`patch: ${JSON.stringify(needle)} is not in ${file}`);
  }
  writeFileSync(file, before.replace(needle, replacement), 'utf8');
}

/** Change what `add` does, and keep the repo's own test in step. Green alone. */
function changesAdd(offset: number): AgentStep {
  return {
    then: (cwd: string): void => {
      patch(path.join(cwd, 'src/calc.ts'), 'return a + b;', `return a + b + ${String(offset)};`);
      patch(
        path.join(cwd, 'src/calc.test.ts'),
        'assert.equal(add(2, 3), 5);',
        `assert.equal(add(2, 3), ${String(5 + offset)});`,
      );
      patch(
        path.join(cwd, 'src/calc.test.ts'),
        'assert.equal(add(-1, 1), 0);',
        `assert.equal(add(-1, 1), ${String(offset)});`,
      );
    },
    structured: developerPayload({
      commit_message: `feat(calc): shift add by ${String(offset)}`,
      files_changed: ['src/calc.ts', 'src/calc.test.ts'],
    }),
  };
}

/**
 * A new test that asserts `add` still sums.
 *
 * Green on its own branch, where `calc.ts` is untouched. Red the moment it sits
 * beside a ticket that changed `add` — with no textual conflict at all, because
 * the two tickets touch different files. That is the shape the post-merge gates
 * exist for.
 */
const ASSERTS_ADD_SUMS: AgentStep = {
  write: {
    'src/sum.test.ts': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "import { add } from './calc.ts';",
      '',
      "test('add sums its arguments', () => {",
      '  assert.equal(add(2, 3), 5);',
      '});',
      '',
    ].join('\n'),
  },
  structured: developerPayload({
    commit_message: 'test(calc): pin add to summation',
    files_changed: ['src/sum.test.ts'],
  }),
};

/** A new module and its test. Touches nothing anybody else touches. */
function addsModule(name: string): AgentStep {
  return {
    write: {
      [`src/${name}.ts`]: `export function ${name}(value: string): string {\n  return \`${name}: \${value}\`;\n}\n`,
      [`src/${name}.test.ts`]: [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        `import { ${name} } from './${name}.ts';`,
        '',
        `test('${name} formats', () => {`,
        `  assert.equal(${name}('x'), '${name}: x');`,
        '});',
        '',
      ].join('\n'),
    },
    structured: developerPayload({
      commit_message: `feat(${name}): add the ${name} helper`,
      files_changed: [`src/${name}.ts`],
    }),
  };
}

const APPROVING = {
  code_reviewer: { structured: reviewerPayload('approve') },
  qa: { structured: qaPayload('pass') },
};

// ---------------------------------------------------------------------------
// The capability itself.
// ---------------------------------------------------------------------------

describe('a ticket at merge', () => {
  it('waits when the orchestrator has nowhere to verify the merge', async () => {
    // The Phase 9 shape, stated as a property rather than left implicit. A merge
    // that cannot be verified must not happen: better a ticket visibly parked at
    // `merge` than an unverified commit on a shared branch.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    const before = sha(vault.repo.branch);

    await drive(runner, 2, { merge: false });

    expect(ticket().frontmatter.status).toBe('merge');
    expect(sha(FEATURE_BRANCH), 'a merge happened without the capability').toBe(before);
    expect(events.ofType('merge_started')).toHaveLength(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

describe('two sequential tickets', () => {
  it('both merge into the feature branch, and it carries both commits in order', async () => {
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': addsModule('describe'),
      'developer:FEAT-SAMPLE-T002': addsModule('explain'),
      ...APPROVING,
    });
    const base = sha(vault.repo.branch);

    await drive(runner, 2, { merge: false });
    expect(ticket().frontmatter.status).toBe('merge');
    expect(ticket(SECOND_TICKET_ID).frontmatter.status).toBe('merge');

    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status).toBe('done');
    expect(ticket(SECOND_TICKET_ID).frontmatter.status).toBe('done');
    expect(transitions()).toContain('merge → done');

    // Two `--no-ff` merges, newest first, and both tickets' work is on the branch.
    const log = subjects(FEATURE_BRANCH);
    expect(log.filter((line) => line.startsWith('Merge branch'))).toHaveLength(2);
    expect(log).toContain('feat(describe): add the describe helper');
    expect(log).toContain('feat(explain): add the explain helper');
    expect(git(vault.repo.path, ['show', `${FEATURE_BRANCH}:src/describe.ts`])).toContain(
      'describe',
    );
    expect(git(vault.repo.path, ['show', `${FEATURE_BRANCH}:src/explain.ts`])).toContain('explain');

    // Section E item 8: only Phase 11's code writes to the base branch.
    expect(sha(vault.repo.branch), 'the ticket merge moved the base branch').toBe(base);
  }, 240_000);

  it('the feature reaches awaiting_feature_close only once the last ticket is done', async () => {
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': addsModule('describe'),
      'developer:FEAT-SAMPLE-T002': addsModule('explain'),
      ...APPROVING,
    });

    await drive(runner, 2, { merge: false });
    // Both tickets verified but neither merged: the feature must not move.
    expect(feature().status, 'the feature closed with tickets still at merge').toBe(
      'in_development',
    );

    await drive(runner, 2, { merge: true });

    expect(feature().status).toBe('awaiting_feature_close');
    expect(
      historyLines(readNoteFile(vault.paths.featureNote(SLUG)).body).join('\n'),
    ).toContain('in_development → awaiting_feature_close');
  }, 240_000);
});

describe('after a ticket is done', () => {
  it('its worktree is gone and its branch is deleted', async () => {
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 2, { merge: false });
    const worktree = ticket().frontmatter.worktree;
    const branch = ticket().frontmatter.branch;
    expect(worktree, 'the ticket recorded no worktree').not.toBeNull();
    expect(existsSync(worktree ?? ''), 'there was no worktree to remove').toBe(true);
    expect(branches()).toContain(branch);

    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status).toBe('done');
    expect(existsSync(worktree ?? ''), 'the merged ticket kept its worktree').toBe(false);
    expect(branches(), 'the merged ticket kept its branch').not.toContain(branch);
    // Git's own registration went too, not just the directory.
    expect(git(vault.repo.path, ['worktree', 'list'])).not.toContain(worktree ?? 'unset');
    expect(events.ofType('ticket_branch_deleted')[0]?.branch).toBe(branch);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// THE CASE THIS FILE EXISTS FOR.
// ---------------------------------------------------------------------------

describe('a ticket that breaks the feature branch when combined', () => {
  it('is caught by the post-merge gates and never reaches done', async () => {
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      // T001 changes what `add` does; T002 adds a test that says it must not
      // change. Different files, so the merge itself is clean — and the two
      // together are red.
      'developer:FEAT-SAMPLE-T001': changesAdd(1),
      'developer:FEAT-SAMPLE-T002': ASSERTS_ADD_SUMS,
      ...APPROVING,
    });

    await drive(runner, 2, { merge: false });
    expect(ticket().frontmatter.status, 'T001 did not pass its own gates').toBe('merge');
    expect(ticket(SECOND_TICKET_ID).frontmatter.status, 'T002 did not pass its own gates').toBe(
      'merge',
    );
    const attemptsBefore = ticket(SECOND_TICKET_ID).frontmatter.attempts;

    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status, 'the first ticket should have merged cleanly').toBe('done');
    const second = ticket(SECOND_TICKET_ID);
    expect(second.frontmatter.status, 'a ticket that broke the branch reached done').toBe(
      'needs_human',
    );
    expect(second.frontmatter.pause_detail).toContain('feature branch');
    // `FREE_FAILURES` in `attempts.ts`: a merge failure costs no attempt,
    // because there is no retry for one and the count would be a number nobody
    // acts on. Pinned here because charging it fails no other test.
    expect(
      second.frontmatter.attempts,
      'a red feature-branch gate charged the ticket an attempt',
    ).toBe(attemptsBefore);
  }, 240_000);

  it('resets the feature branch to its pre-merge SHA, so the next ticket does not inherit it', async () => {
    // The whole point. A merge commit cannot be un-merged by `git merge
    // --abort`, so without this the branch permanently carries a merge that
    // fails its own gates.
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': changesAdd(1),
      'developer:FEAT-SAMPLE-T002': ASSERTS_ADD_SUMS,
      ...APPROVING,
    });

    await drive(runner, 2, { merge: false });
    await drive(runner, 2, { merge: true });

    const started = events.ofType('merge_started').filter((e) => e.itemId === SECOND_TICKET_ID);
    expect(started, 'the second merge never started').toHaveLength(1);
    const beforeSecondMerge = started[0]?.beforeSha ?? '';
    expect(beforeSecondMerge).not.toBe('');

    expect(sha(FEATURE_BRANCH), 'the bad merge is still on the feature branch').toBe(
      beforeSecondMerge,
    );
    // Exactly one merge commit: T001's. T002's was made and then rewound.
    expect(subjects(FEATURE_BRANCH).filter((line) => line.startsWith('Merge branch'))).toHaveLength(
      1,
    );
    // And the branch really is green again: the file that broke it is not on it.
    expect(() => git(vault.repo.path, ['show', `${FEATURE_BRANCH}:src/sum.test.ts`])).toThrow();

    const reverted = events.ofType('merge_reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.itemId).toBe(SECOND_TICKET_ID);
    expect(reverted[0]?.toSha).toBe(beforeSecondMerge);
    // The merge commit is not an ancestor of the branch any more.
    const mergeSha = events.ofType('gates_finished').find((e) => e.green === false)?.commitSha ?? '';
    expect(mergeSha).not.toBe('');
    expect(isAncestor(mergeSha, FEATURE_BRANCH), 'the rewound merge is still reachable').toBe(false);
  }, 240_000);

  it('keeps the ticket branch and its worktree, because they are the only copy left', async () => {
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': changesAdd(1),
      'developer:FEAT-SAMPLE-T002': ASSERTS_ADD_SUMS,
      ...APPROVING,
    });

    await drive(runner, 2, { merge: false });
    await drive(runner, 2, { merge: true });

    const second = ticket(SECOND_TICKET_ID);
    expect(second.frontmatter.status).toBe('needs_human');
    expect(branches(), 'the rejected ticket lost its branch').toContain(second.frontmatter.branch);
    expect(existsSync(second.frontmatter.worktree ?? '')).toBe(true);
    // A human can retry the merge, or send it back to a Developer.
    expect(second.frontmatter.resume_to).toBe('merge');
    expect(second.frontmatter.reject_to).toBe('in_progress');
    // The evidence is in the ticket, not only in the log.
    expect(sectionText(second.body, SECTION.gateResults)).toContain('Feature-branch gates');
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Conflicts.
// ---------------------------------------------------------------------------

describe('two tickets editing the same lines', () => {
  it('the second conflicts, pauses, and leaves no merge in progress', async () => {
    await openVault({ tickets: 2 });
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': changesAdd(1),
      'developer:FEAT-SAMPLE-T002': changesAdd(2),
      ...APPROVING,
    });

    await drive(runner, 2, { merge: false });
    const attemptsBefore = ticket(SECOND_TICKET_ID).frontmatter.attempts;
    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status).toBe('done');

    const second = ticket(SECOND_TICKET_ID);
    expect(second.frontmatter.status).toBe('needs_human');
    expect(second.frontmatter.pause_reason).toBe('merge_conflict');
    expect(second.frontmatter.pause_detail).toContain('src/calc.ts');
    // The same `FREE_FAILURES` ruling as the red-gate case above: the same two
    // branches conflict the same way every time, so no retry exists to spend an
    // attempt on. Pinned because charging it fails no other test.
    expect(
      second.frontmatter.attempts,
      'a merge conflict charged the ticket an attempt',
    ).toBe(attemptsBefore);

    // The repository is clean: no MERGE_HEAD, no conflict markers left staged.
    expect(repoIsMidMerge(), 'the repository was left mid-merge').toBe(false);
    expect(git(vault.repo.path, ['status', '--porcelain']).trim()).toBe('');

    const conflict = events.ofType('merge_conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.conflicts).toContain('src/calc.ts');

    // The feature branch still carries T001's merge and nothing else.
    expect(subjects(FEATURE_BRANCH).filter((line) => line.startsWith('Merge branch'))).toHaveLength(
      1,
    );
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The operator's main checkout.
// ---------------------------------------------------------------------------

describe('the operator’s main checkout', () => {
  it('is refused, and its uncommitted work survives, when it is dirty', async () => {
    // The merge runs there (spec §10), and a red post-merge gate resets the
    // feature branch — which for a checkout sitting on that branch means
    // `git reset --hard`. Refusing first is what keeps that safe.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 2, { merge: false });

    const edited = path.join(vault.repo.path, 'src', 'calc.ts');
    const operatorText = `${readFileSync(edited, 'utf8')}\n// the operator was in the middle of something\n`;
    writeFileSync(edited, operatorText, 'utf8');
    const featureBefore = sha(FEATURE_BRANCH);

    await drive(runner, 2, { merge: true });

    const state = ticket();
    expect(state.frontmatter.status, 'a dirty checkout was merged into').toBe('needs_human');
    expect(state.frontmatter.pause_detail).toContain('uncommitted');
    expect(state.frontmatter.pause_detail).toContain('src/calc.ts');
    expect(sha(FEATURE_BRANCH)).toBe(featureBefore);
    expect(
      readFileSync(edited, 'utf8'),
      'the factory touched the operator’s uncommitted work',
    ).toBe(operatorText);
    expect(events.ofType('merge_refused')).toHaveLength(1);
  }, 240_000);

  it('is left on the branch it was on, not on the feature branch', async () => {
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    const startingBranch = git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    await drive(runner, 2, { merge: false });
    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status).toBe('done');
    expect(
      git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      'the factory left the operator on the feature branch',
    ).toBe(startingBranch);
  }, 240_000);

  it('is not where the post-merge gates run', async () => {
    // Constructed, not hoped for. An untracked failing test in the main checkout
    // turns `npm test` red **there** and is invisible in a tree cut from the
    // merge commit. If the gates ran in the operator's checkout, this ticket
    // would be reverted and parked instead of merged — and every merge would
    // then be at the mercy of whatever the operator happened to have lying about.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 2, { merge: false });

    const rogue = path.join(vault.repo.path, 'src', 'rogue.test.ts');
    writeFileSync(
      rogue,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('the operator left this failing', () => {",
        '  assert.equal(1, 2);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );

    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status, 'the gates ran in the operator’s checkout').toBe('done');
    expect(events.ofType('merge_reverted')).toHaveLength(0);
    // The untracked file is still there: an untracked mess is not a refusal, and
    // nothing the merge did removed it.
    expect(existsSync(rogue)).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — the repository's own hooks, executing as the orchestrator.
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * THE ESCAPE ADR-003 AND SECTION E ITEM 8a EXIST TO CLOSE, REOPENED AT THE MERGE
 * ============================================================================
 * Phase 9 closed this for `git commit`. Phase 10 shipped three more commands
 * that run git in the operator's checkout — `merge`, `checkout`, `reset` — and
 * none of them carried the fence.
 *
 * The route is not hypothetical and it needs no `.git/hooks` write, which is
 * what the `denyWrite` fence covers: a husky-style `prepare` script points
 * `core.hooksPath` at a **tracked** directory when Phase 8's unsandboxed
 * `setup_command` runs `npm ci`, `.git/config` is shared by every worktree, and
 * the agent may then commit hook scripts into that directory like any other
 * worktree file. `mergeNoFf` checks its branch out and merges — and the tree it
 * merges *in* is where the scripts are.
 *
 * These run `ShellGit` directly rather than through the loop. The evidence
 * wanted is which commands git ran hooks for, and that is a property of the
 * argv, not of the pipeline.
 */
describe('the git commands the merge runs', () => {
  const MERGE_HOOKS = ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge'];

  /** Executable hook scripts that append their own name to `evidence`. */
  function plantHooks(repoPath: string, names: readonly string[], evidence: string): void {
    const dir = path.join(repoPath, 'githooks');
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const hook = path.join(dir, name);
      writeFileSync(hook, `#!/bin/sh\necho "${name}" >> ${JSON.stringify(evidence)}\n`, 'utf8');
      chmodSync(hook, 0o755);
    }
    // What the husky-style `prepare` script does: a **tracked**, relative path.
    git(repoPath, ['config', 'core.hooksPath', 'githooks']);
  }

  /** Local branch names in any repo — `branches()` above is bound to the vault fixture. */
  function branchesIn(repoPath: string): string[] {
    return git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  function hooksThatRan(evidence: string): string[] {
    if (!existsSync(evidence)) return [];
    return readFileSync(evidence, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  it('runs no repository hook when it merges', async () => {
    const repo = toyRepo();
    const evidence = path.join(repo.path, 'HOOK_RAN.txt');

    git(repo.path, ['branch', FEATURE_BRANCH]);
    git(repo.path, ['checkout', '--quiet', '-b', 'ticket/x', FEATURE_BRANCH]);
    // The agent commits the hook scripts on its own ticket branch, so the merge
    // brings them into the tree it is about to commit.
    plantHooks(repo.path, MERGE_HOOKS, evidence);
    writeFileSync(path.join(repo.path, 'src', 'agent.ts'), 'export const x = 1;\n', 'utf8');
    git(repo.path, ['add', '-A']);
    git(repo.path, ['commit', '--quiet', '-m', 'feat: agent work, plus four hooks']);
    git(repo.path, ['checkout', '--quiet', 'main']);

    const result = await new ShellGit({ repoRoot: repo.path }).mergeNoFf(FEATURE_BRANCH, 'ticket/x');

    expect(result.ok, 'the merge itself failed, so this proves nothing').toBe(true);
    // The scripts really are in the tree the merge committed — otherwise a
    // green assertion below would only mean the fixture was wrong.
    expect(git(repo.path, ['show', `${FEATURE_BRANCH}:githooks/commit-msg`])).toContain('#!/bin/sh');
    expect(
      hooksThatRan(evidence),
      'an agent-authored repository hook executed unsandboxed as the orchestrator',
    ).toEqual([]);
  }, 120_000);

  it('gives the merge commit the orchestrator’s identity, not the operator’s', async () => {
    // Resolution A6's visible half: `git log` should say a machine wrote it.
    // Without this the merge commit carries whoever owns the checkout — and a
    // repo with `commit.gpgsign=true` would hang on a signing prompt instead.
    const repo = toyRepo();
    git(repo.path, ['branch', FEATURE_BRANCH]);
    git(repo.path, ['checkout', '--quiet', '-b', 'ticket/x', FEATURE_BRANCH]);
    writeFileSync(path.join(repo.path, 'src', 'agent.ts'), 'export const x = 1;\n', 'utf8');
    git(repo.path, ['add', '-A']);
    git(repo.path, ['commit', '--quiet', '-m', 'feat: agent work']);
    git(repo.path, ['checkout', '--quiet', 'main']);

    await new ShellGit({ repoRoot: repo.path }).mergeNoFf(FEATURE_BRANCH, 'ticket/x');

    expect(
      git(repo.path, ['log', '-1', '--format=%an|%ae|%cn|%ce', FEATURE_BRANCH]).trim(),
    ).toBe(
      [
        ORCHESTRATOR_IDENTITY.name,
        ORCHESTRATOR_IDENTITY.email,
        ORCHESTRATOR_IDENTITY.name,
        ORCHESTRATOR_IDENTITY.email,
      ].join('|'),
    );
  }, 120_000);

  it('runs no repository hook when it provisions a worktree, or moves any other ref', async () => {
    // `worktree add` is the most frequently executed git command in the factory
    // — once per ticket provisioning, and again for every post-merge gate run —
    // and it performs a checkout, so it runs `post-checkout`. The chain needs no
    // agent to commit anything: the orchestrator commits the agent's work to the
    // ticket branch (ADR-003), the merge lands it on the feature branch, and the
    // next worktree is cut from a feature branch that now carries the script.
    //
    // `tag` matters one phase ahead for the same reason — Phase 11 tags the base
    // branch. Probed against real git: without the fence these fired
    // `post-checkout` and `reference-transaction`; with it, none of them do.
    const repo = toyRepo();
    const evidence = path.join(repo.path, 'HOOK_RAN.txt');
    plantHooks(repo.path, ['post-checkout', 'reference-transaction'], evidence);
    git(repo.path, ['add', '-A']);
    git(repo.path, ['commit', '--quiet', '-m', 'chore: hooks, tracked on every branch']);
    const base = git(repo.path, ['rev-parse', 'HEAD']).trim();

    const shell = new ShellGit({ repoRoot: repo.path });
    const worktrees = path.join(repo.path, '..', `probe-wt-${path.basename(repo.path)}`);

    await shell.ensureBranch(FEATURE_BRANCH, base);
    await shell.createWorktree(path.join(worktrees, 't001'), 'feat/sample/t001', FEATURE_BRANCH);
    await shell.createDetachedWorktree(path.join(worktrees, 'verify'), base);
    await shell.tag('factory/sample/2026-09-02', base);
    await shell.removeWorktree(path.join(worktrees, 'verify'), true);
    await shell.removeWorktree(path.join(worktrees, 't001'), true);
    await shell.deleteBranch('feat/sample/t001', { force: true });
    rmSync(worktrees, { recursive: true, force: true });

    // Every one of those really did happen — otherwise an empty hook log would
    // only mean no git ran.
    expect(git(repo.path, ['tag']).trim()).toBe('factory/sample/2026-09-02');
    expect(branchesIn(repo.path)).toContain(FEATURE_BRANCH);
    expect(branchesIn(repo.path)).not.toContain('feat/sample/t001');
    expect(
      hooksThatRan(evidence),
      'a repository hook executed unsandboxed as the orchestrator',
    ).toEqual([]);
  }, 120_000);

  it('runs no repository hook when it checks out or resets a branch', async () => {
    // `checkout` fires `post-checkout`; every ref move, `git branch --force` and
    // `git reset --hard` alike, fires `reference-transaction`.
    const repo = toyRepo();
    const evidence = path.join(repo.path, 'HOOK_RAN.txt');
    plantHooks(repo.path, ['post-checkout', 'reference-transaction'], evidence);
    git(repo.path, ['add', '-A']);
    git(repo.path, ['commit', '--quiet', '-m', 'chore: two hooks on main']);
    const before = git(repo.path, ['rev-parse', 'HEAD']).trim();

    git(repo.path, ['branch', FEATURE_BRANCH]);
    writeFileSync(path.join(repo.path, 'src', 'more.ts'), 'export const y = 2;\n', 'utf8');
    git(repo.path, ['add', '-A']);
    git(repo.path, ['commit', '--quiet', '-m', 'chore: something to rewind past']);

    const shell = new ShellGit({ repoRoot: repo.path });
    await shell.checkout(FEATURE_BRANCH);
    // Checked out here, so this is the `git reset --hard` fallback, not
    // `git branch --force`. Both are covered.
    await shell.resetBranch(FEATURE_BRANCH, before);

    expect(git(repo.path, ['rev-parse', FEATURE_BRANCH]).trim()).toBe(before);
    expect(
      hooksThatRan(evidence),
      'a repository hook executed unsandboxed as the orchestrator',
    ).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — an edit made in the main checkout *while the gates run*.
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * THE WINDOW THE PRE-MERGE REFUSAL CANNOT SEE INTO
 * ============================================================================
 * `mergeTicket` checks the main checkout for uncommitted tracked changes once,
 * before the merge, and reverts through `git reset --hard` afterwards. Between
 * those two moments the post-merge gates run, for as long as the target repo's
 * test suite takes. A human who edits a file in that window was clean when we
 * looked and is dirty by the time the revert fires.
 *
 * No unit test can catch this and it is not for want of trying: the mocked
 * `Git` those tests drive has **no working tree at all** — its `resetBranch`
 * moves a SHA field — so it cannot lose a file, and the whole hazard is
 * invisible to it. Only real git can show the file coming back with the wrong
 * content, which is what these two cases do.
 *
 * They make the edit by wrapping `featureWorkspace`, which the merge calls
 * exactly once, after the merge has committed and before the gates start. That
 * is the window, precisely.
 */
describe('an edit made in the main checkout while the post-merge gates run', () => {
  /** The real capability, with `during` fired inside `ticketId`'s gate window. */
  function editingDuringGates(ticketId: string, during: () => void): Capability {
    const real = realCapability(vault, { events, now });
    return {
      ...real,
      featureWorkspace: async (request: FeatureVerifyRequest): Promise<Workspace> => {
        if (request.ticketId === ticketId) during();
        return await real.featureWorkspace(request);
      },
    };
  }

  /** T001 merges green; T002 merges clean and turns the branch red. */
  function twoTicketsSecondGoesRed(): ScriptedRunner {
    return scriptedAgents({
      'developer:FEAT-SAMPLE-T001': changesAdd(1),
      'developer:FEAT-SAMPLE-T002': ASSERTS_ADD_SUMS,
      ...APPROVING,
    });
  }

  it('survives the revert, because the checkout is put back before the branch is', async () => {
    // With the restore first, `resetBranch` gets `git branch --force` and no
    // working tree is touched at all. Reverting first — what this module used
    // to do — gets `git reset --hard` in the operator's own checkout, and this
    // edit came back as its pre-merge content.
    await openVault({ tickets: 2 });
    const runner = twoTicketsSecondGoesRed();

    await drive(runner, 2, { merge: false });

    const edited = path.join(vault.repo.path, 'CLAUDE.md');
    let operatorText = '';
    const capability = editingDuringGates(SECOND_TICKET_ID, () => {
      operatorText = `${readFileSync(edited, 'utf8')}\n<!-- mid-edit while the gates ran -->\n`;
      writeFileSync(edited, operatorText, 'utf8');
    });

    await drive(runner, 2, { merge: true, capability });

    const second = ticket(SECOND_TICKET_ID);
    expect(second.frontmatter.status, 'the red branch gates did not park the ticket').toBe(
      'needs_human',
    );
    expect(operatorText, 'the gate window never fired, so nothing was tested').not.toBe('');
    expect(
      readFileSync(edited, 'utf8'),
      'the revert destroyed a human’s uncommitted edit',
    ).toBe(operatorText);
    // And the revert still did its job.
    expect(events.ofType('merge_reverted')).toHaveLength(1);
    expect(events.ofType('merge_revert_failed')).toHaveLength(0);
    const started = events.ofType('merge_started').filter((e) => e.itemId === SECOND_TICKET_ID);
    expect(sha(FEATURE_BRANCH)).toBe(started[0]?.beforeSha);
  }, 240_000);

  it('is never reset away silently when the restore itself could not happen', async () => {
    // `restoreCheckout` deliberately never throws — it runs in a `finally` and
    // an exception there would replace the merge's real outcome. So a restore
    // that fails is *silent*, and reverting after a silent failure is `git reset
    // --hard` again. Here it really does fail: the edited file is one the merge
    // brought in, so it does not exist on `main` and `git checkout main`
    // refuses. Probed before the fix, this file was deleted outright.
    //
    // The backstop is `ShellGit.resetBranch` re-reading the status immediately
    // before `reset --hard` and raising instead. A bad merge left on a branch is
    // recoverable; a deleted edit is not.
    await openVault({ tickets: 2 });
    const runner = twoTicketsSecondGoesRed();

    await drive(runner, 2, { merge: false });

    const broughtIn = path.join(vault.repo.path, 'src', 'sum.test.ts');
    const operatorText = '// the operator patched the file the merge brought in\n';
    const capability = editingDuringGates(SECOND_TICKET_ID, () => {
      writeFileSync(broughtIn, `${readFileSync(broughtIn, 'utf8')}${operatorText}`, 'utf8');
    });

    await drive(runner, 2, { merge: true, capability });

    expect(existsSync(broughtIn), 'the revert deleted a human’s uncommitted edit').toBe(true);
    expect(readFileSync(broughtIn, 'utf8')).toContain(operatorText);
    // It failed loudly rather than quietly succeeding at the wrong thing.
    const failed = events.ofType('merge_revert_failed');
    expect(failed, 'the reset went ahead and nobody was told').toHaveLength(1);
    expect(failed[0]?.error).toContain('src/sum.test.ts');
    expect(events.ofType('merge_reverted')).toHaveLength(0);

    const second = ticket(SECOND_TICKET_ID);
    expect(second.frontmatter.status).toBe('needs_human');
    expect(
      second.frontmatter.pause_detail,
      'a human was not told the branch still carries the bad merge',
    ).toContain('could not be undone');
    expect(second.frontmatter.resume_to).toBe('merge');
  }, 240_000);
});

// ---------------------------------------------------------------------------
// ADR-004 — no agent is anywhere near a merge.
// ---------------------------------------------------------------------------

describe('the Runner', () => {
  it('is never invoked at merge', async () => {
    // Asserted on the Runner itself, not on the end state: a dispatcher that
    // ran an agent and then merged deterministically anyway would satisfy every
    // state assertion in this file. `merge` has no row in `TICKET_STATE_ROLES`
    // and this is what proves that stays true.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 2, { merge: false });
    expect(ticket().frontmatter.status).toBe('merge');
    const beforeMerge = runner.roles();
    expect(beforeMerge, 'the dev loop ran no agent at all, so this proves nothing').not.toEqual([]);

    await drive(runner, 2, { merge: true });

    expect(ticket().frontmatter.status, 'the merge did not happen').toBe('done');
    expect(runner.roles(), 'an agent was invoked during the merge (ADR-004)').toEqual(beforeMerge);
  }, 240_000);
});

/**
 * The feature close against real git (plan Phase 11).
 *
 * Real repository, real branches, real worktrees, real subprocess gates, real
 * `git merge --no-ff` into the base branch and a real `git tag`. The only thing
 * faked is the model.
 *
 * ============================================================================
 * THE FAILURE THESE TESTS EXIST TO CATCH
 * ============================================================================
 * A feature the vault records as delivered that is not on the base branch.
 *
 * This is the only code in the system permitted to write the base branch (plan
 * Section E item 8), `done` is terminal, and until this phase the transition
 * into `done` carried **no guard at all** — its own description claimed "merged
 * into base and tagged" while checking neither. Nothing in the Phase 9 or Phase
 * 10 suites could have caught it: no feature in either reaches
 * `awaiting_feature_close` with a capability that could close it, and no test
 * anywhere asserted anything about the base branch's tag.
 *
 * `the base branch is written by nothing else` below is the other half, and it
 * is asserted on the **SHA**: the whole dev loop and both ticket merges run, and
 * the base branch does not move until a human approves.
 *
 * ============================================================================
 * WHY THE UNIT SUITE IS NOT ENOUGH, STATED PLAINLY
 * ============================================================================
 * The mocked `Git` next door has no working tree. It cannot lose a file, cannot
 * produce a real conflict, and its `tag` is a `Map.set`. Every hazard on the
 * destructive path — a base branch that moved underneath us, a checkout that
 * refuses, a tag git itself rejects — is invisible to it. These cases are the
 * ones only real git can answer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { runStatus } from '../../src/cli/status.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import type { FeatureFrontmatter, TicketFrontmatter } from '../../src/domain/types.js';
import { ShellGit } from '../../src/git/git.js';
import { featureTagName, vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { ActionError, approve, reject } from '../../src/orchestrator/actions.js';
import type { ActionContext } from '../../src/orchestrator/actions.js';
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
  FEATURE_ID,
} from '../helpers/devLoopFixtures.js';
import type { AgentStep, Capability, ScriptedRunner } from '../helpers/devLoopFixtures.js';
import { makeTicket } from '../helpers/notes.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { readNoteFile } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  run,
  scratchFactoryHome,
  toyRepo,
} from '../helpers/toyRepo.js';
import { appendToSection } from '../../src/vault/storage.js';

const SECOND_TICKET_ID = 'FEAT-SAMPLE-T002';
const THIRD_TICKET_ID = 'FEAT-SAMPLE-T003';
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

async function openVault(
  options: { readonly tickets?: 1 | 2; readonly finalAcceptance?: boolean } = {},
): Promise<FactoryFixture> {
  vault = await devVault({
    ...(options.finalAcceptance === undefined
      ? {}
      : {
          config: {
            human_checkpoints: {
              after_pm_refinement: true,
              after_ticket_breakdown: true,
              final_acceptance: options.finalAcceptance,
            },
          },
        }),
  });
  worktreeRoots.add(worktreeRoot(vault.config.target_repo, vaultWorktreeName(vault.paths.root)));

  if (options.tickets === 2) await addTicket(SECOND_TICKET_ID, 'Add a second helper', 2);
  return vault;
}

/** One more ticket in the same feature, ready to be picked up. */
async function addTicket(id: string, title: string, ordinal: number): Promise<void> {
  // The body matters: the QA recipe refuses to run without `## Acceptance
  // Criteria`, so a ticket with an empty body never leaves `qa`.
  let body = '';
  body = appendToSection(body, SECTION.rawRequirement, `${title} in the calculator.`);
  body = appendToSection(body, SECTION.acceptanceCriteria, `- ${title} returns a string`);

  await vault.storage.writeNote(
    vault.paths.ticketPath(SLUG, id),
    makeTicket({ id, feature: SLUG, title, ordinal, status: 'ready' }, body),
  );
}

/**
 * Run the loop.
 *
 * `close` chooses whether the orchestrator is given a `featureWorkspace` — which
 * is what makes both the ticket merge and the feature close possible at all
 * (`canMergeTickets`, `canCloseFeature`). Withholding it is how the Phase 9 and
 * Phase 10 states are reached.
 */
async function drive(
  runner: ScriptedRunner,
  cycles: number,
  options: {
    readonly close: boolean;
    readonly capability?: Capability;
    /** Overrides the orchestrator's clock. Only the tag-date case needs it. */
    readonly now?: () => string;
  } = { close: true },
): Promise<void> {
  const clock = options.now ?? now;
  const capability = options.capability ?? realCapability(vault, { events, now: clock });
  const instance = await Orchestrator.start({
    paths: vault.paths,
    config: vault.config,
    storage: vault.storage,
    runner,
    events,
    now: clock,
    isAlive: () => true,
    workspace: capability.workspace,
    reconcile: capability.reconcile,
    git: capability.git,
    gates: capability.gates,
    ...(options.close ? { featureWorkspace: capability.featureWorkspace } : {}),
  });
  try {
    await instance.run({ maxCycles: cycles, sleep: async () => undefined });
  } finally {
    await instance.shutdown();
  }
}

/** An `ActionContext` with a real handle on the toy repo, as `factory approve` gets. */
function actions(): ActionContext {
  return {
    paths: vault.paths,
    storage: vault.storage,
    config: vault.config,
    now,
    events,
    git: new ShellGit({ repoRoot: vault.config.target_repo }),
  };
}

function ticket(id = TICKET_ID): { frontmatter: TicketFrontmatter; body: string } {
  const note = readNoteFile(vault.paths.ticketPath(SLUG, id));
  return { frontmatter: note.frontmatter as TicketFrontmatter, body: note.body };
}

function feature(): FeatureFrontmatter {
  return readNoteFile(vault.paths.featureNote(SLUG)).frontmatter as FeatureFrontmatter;
}

function featureBody(): string {
  return readNoteFile(vault.paths.featureNote(SLUG)).body;
}

function sha(ref: string): string {
  return git(vault.repo.path, ['rev-parse', ref]).trim();
}

function tags(): string[] {
  return git(vault.repo.path, ['tag'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/** Gate-log filenames the feature close has written, for this feature. */
function closeGateLogs(): string[] {
  const dir = path.join(vault.paths.logsDir(), SLUG);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.includes(`${FEATURE_ID}-close`) && name.endsWith('.log'))
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

function repoIsMidMerge(): boolean {
  return existsSync(path.join(vault.repo.path, '.git', 'MERGE_HEAD'));
}

// ---------------------------------------------------------------------------
// The change each scripted Developer makes.
// ---------------------------------------------------------------------------

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

/**
 * Commit onto `branch` and put the checkout back where it was.
 *
 * The realistic shape of both hazards this file probes: somebody lands one more
 * commit while the factory is between steps. Returns the new SHA.
 */
function commitOnBranch(branch: string, file: string, contents: string, message: string): string {
  const startedOn = git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(vault.repo.path, ['checkout', '--quiet', branch]);
  writeFileSync(path.join(vault.repo.path, file), contents, 'utf8');
  git(vault.repo.path, ['add', '--', file]);
  git(vault.repo.path, [
    '-c', 'user.name=A Colleague', '-c', 'user.email=colleague@example.invalid',
    'commit', '--quiet', '-m', message,
  ]);
  const made = sha('HEAD');
  git(vault.repo.path, ['checkout', '--quiet', startedOn]);
  return made;
}

/** A test that always fails, for turning a branch red. */
const RED_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "test('somebody broke it', () => {",
  '  assert.equal(1, 2);',
  '});',
  '',
].join('\n');

/** Commit straight onto the base branch, as a colleague would. */
function commitOnBase(file: string, contents: string, message: string): string {
  const target = path.join(vault.repo.path, file);
  writeFileSync(target, contents, 'utf8');
  git(vault.repo.path, ['add', '--', file]);
  git(vault.repo.path, [
    '-c',
    'user.name=A Colleague',
    '-c',
    'user.email=colleague@example.invalid',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return sha('HEAD');
}

/** Drive one ticket all the way to `done` on the feature branch. */
async function oneTicketToDone(): Promise<ScriptedRunner> {
  const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
  await drive(runner, 3, { close: true });
  return runner;
}

// ===========================================================================
// THE HAPPY PATH.
// ===========================================================================

describe('a feature whose tickets are all done', () => {
  it('is verified, offered for approval, and lands on the base branch when approved', async () => {
    await openVault();
    const baseBefore = sha(vault.repo.branch);

    await oneTicketToDone();

    // --- the checkpoint -----------------------------------------------------
    expect(ticket().frontmatter.status).toBe('done');
    const parked = feature();
    expect(parked.status, 'the feature was never offered for final acceptance').toBe('needs_human');
    expect(parked.pause_reason).toBe('checkpoint');
    expect(parked.resume_to).toBe('done');
    expect(parked.reject_to).toBe('in_development');
    expect(parked.tag, 'a feature was tagged before anybody approved it').toBeNull();

    // The gates really ran, against the feature branch, and the summary names
    // the ticket and the commit it merged as.
    expect(sectionText(featureBody(), SECTION.gateResults)).toContain('Feature-branch gates');
    const summary = sectionText(featureBody(), SECTION.notes);
    expect(summary).toContain(TICKET_ID);
    expect(summary).toContain(sha(FEATURE_BRANCH).slice(0, 8));

    // Nothing has touched the base branch yet.
    expect(sha(vault.repo.branch), 'the base branch moved before approval').toBe(baseBefore);
    expect(tags(), 'something tagged the repo before approval').toEqual([]);

    // --- factory approve ----------------------------------------------------
    const approvedAt = now();
    const result = await approve(actions(), FEATURE_ID, 'ship it');

    expect(result.to).toBe('done');
    const done = feature();
    expect(done.status).toBe('done');

    // The base branch carries the feature, by a real `--no-ff` merge commit.
    //
    // Asserted on the **parent count** rather than on how many "Merge branch"
    // subjects the log holds: the feature branch already carries one merge
    // commit per ticket, so a subject count says nothing about whether this
    // merge was `--no-ff`. Two parents is exactly what `--no-ff` means, and a
    // fast-forward — which would move the base branch with no merge commit at
    // all — has one.
    expect(sha(vault.repo.branch)).not.toBe(baseBefore);
    expect(
      git(vault.repo.path, ['rev-list', '--parents', '-n', '1', vault.repo.branch])
        .trim()
        .split(/\s+/),
      'the base branch tip is not a two-parent merge commit, so this was not --no-ff',
    ).toHaveLength(3);
    expect(subjects(vault.repo.branch)[0]).toMatch(/^Merge branch/);
    expect(subjects(vault.repo.branch)).toContain('feat(describe): add the describe helper');
    expect(git(vault.repo.path, ['show', `${vault.repo.branch}:src/describe.ts`])).toContain(
      'describe',
    );
    // Nothing from before was dropped.
    expect(isAncestor(baseBefore, vault.repo.branch)).toBe(true);
    expect(isAncestor(sha(FEATURE_BRANCH), vault.repo.branch)).toBe(true);

    // And the tag exists, on the merge commit, with the name the note records.
    const expectedTag = featureTagName(SLUG, approvedAt);
    expect(tags()).toContain(expectedTag);
    expect(done.tag).toBe(expectedTag);
    expect(sha(expectedTag)).toBe(sha(vault.repo.branch));

    // The audit trail says what happened, and the operator's note survived.
    expect(historyLines(featureBody()).map((line) => line.split(' | ')[1])).toContain(
      'needs_human → done',
    );
    expect(sectionText(featureBody(), SECTION.notes)).toContain('ship it');
    expect(repoIsMidMerge()).toBe(false);
    expect(git(vault.repo.path, ['status', '--porcelain']).trim()).toBe('');
  }, 240_000);

  /**
   * ========================================================================
   * STRENGTHENED AFTER REVIEW — THIS CASE USED TO PROVE NOTHING
   * ========================================================================
   * It read the starting branch, closed the feature, and asserted the checkout
   * was still on the starting branch. But the toy repo starts on the **base**
   * branch, and `mergeNoFf` checks the base branch out — so the checkout ended
   * where it began whether or not anything restored it. The reviewer made
   * `restoreCheckout` a no-op and this case stayed green.
   *
   * Both cases below start somewhere the close will move away from, which is
   * the only arrangement in which the assertion can fail.
   */
  it('puts the operator back on their own branch, not the base branch it checked out', async () => {
    await openVault();
    await oneTicketToDone();

    // Somewhere the close genuinely has to come back from.
    git(vault.repo.path, ['checkout', '--quiet', '-b', 'wip/mine']);
    expect(git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wip/mine');

    await approve(actions(), FEATURE_ID);

    expect(feature().status, 'the close did not happen, so this proves nothing').toBe('done');
    expect(
      git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      'the factory left the operator on the base branch after checking it out',
    ).toBe('wip/mine');
  }, 240_000);

  it('puts them back onto the feature branch when that is where they were', async () => {
    // The other non-base starting point, and the more awkward one: the branch
    // being merged *from* is checked out while the merge runs.
    await openVault();
    await oneTicketToDone();
    git(vault.repo.path, ['checkout', '--quiet', FEATURE_BRANCH]);

    await approve(actions(), FEATURE_ID);

    expect(feature().status).toBe('done');
    expect(
      git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      'the operator was left on the base branch',
    ).toBe(FEATURE_BRANCH);
  }, 240_000);

  it('is not verified in the operator’s checkout', async () => {
    // Constructed, not hoped for. An untracked failing test in the main
    // checkout turns `npm test` red **there** and is invisible in a tree cut
    // from the feature branch tip. If the pre-approval gates ran in the
    // operator's checkout, this feature would be parked with a red gate
    // instead of offered for approval — and every close would be at the mercy
    // of whatever they happened to have lying about.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    await drive(runner, 2, { close: false });

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

    await drive(runner, 3, { close: true });

    expect(feature().pause_reason, 'the feature-branch gates ran in the operator’s checkout').toBe(
      'checkpoint',
    );
    expect(existsSync(rogue)).toBe(true);
  }, 240_000);
});

// ===========================================================================
// THE HUMAN CHECKPOINT IS NOT DECORATIVE.
// ===========================================================================

/**
 * ============================================================================
 * WHY THIS CASE EXISTS, AND WHY THE ACTOR LIST IS NOT THE REASON IT PASSES
 * ============================================================================
 * Phase 11 permitted the **orchestrator** on `awaiting_feature_close → done`,
 * so that an auto-close (`final_acceptance: false`) records the actor that
 * actually took the move instead of claiming a human did. Actor lists are not
 * conditional on config, so that widened the rule for **every** run, including
 * the ones where the checkpoint is on.
 *
 * The guard does not close that gap either. `featureCloseVerified` demands a
 * clean base merge and a tag, and the close is the code that *produces* both —
 * by the time it asked, it could answer.
 *
 * What holds is an **ordering** property: the checkpoint decision is made
 * before any base-branch write, so for a feature that is supposed to be waiting
 * on a person the facts the guard needs are never produced at all. A second
 * lock in `mergeAndFinish` re-reads the config switch and refuses, for the route
 * a future caller would otherwise open — see its own note.
 *
 * Asserted on **cycles driven**, not on the end state, in the shape of Phase
 * 10's Runner case: an implementation that closed the feature on the fifth
 * cycle would satisfy a single-shot assertion and fail this one.
 */
describe('an enabled final_acceptance checkpoint', () => {
  it('is never advanced past, however many cycles run', async () => {
    await openVault();
    const baseBefore = sha(vault.repo.branch);
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    // Three cycles get the ticket through the dev loop, the merge, and the
    // feature to the checkpoint. Then eleven more, with nobody approving.
    await drive(runner, 3, { close: true });
    expect(feature().pause_reason, 'the feature never reached the checkpoint').toBe('checkpoint');
    const cyclesBefore = events.ofType('cycle_started').length;

    const EXTRA_CYCLES = 11;
    await drive(runner, EXTRA_CYCLES, { close: true });

    // The cycles really ran. Without this, everything below is vacuous — a
    // loop that had stopped would also merge nothing.
    expect(
      events.ofType('cycle_started').length - cyclesBefore,
      'the loop did not actually run the extra cycles',
    ).toBe(EXTRA_CYCLES);

    // The feature is exactly where the checkpoint left it.
    const front = feature();
    expect(
      front.status,
      `${String(EXTRA_CYCLES)} cycles advanced the feature past a checkpoint nobody approved`,
    ).toBe('needs_human');
    expect(front.pause_reason).toBe('checkpoint');
    expect(front.resume_to).toBe('done');
    expect(front.tag, 'a feature was tagged with nobody having approved it').toBeNull();

    // The base branch was never written, and nothing was ever tagged.
    expect(sha(vault.repo.branch), 'the base branch moved without an approval').toBe(baseBefore);
    expect(tags(), 'the repo was tagged without an approval').toEqual([]);
    expect(events.ofType('feature_close_started')).toHaveLength(0);
    expect(events.ofType('feature_closed')).toHaveLength(0);
    expect(events.ofType('feature_tagged')).toHaveLength(0);
    // It closed exactly once and never re-entered the state to try again.
    const moves = historyLines(featureBody()).map((line) => line.split(' | ')[1]);
    expect(moves.filter((move) => move === 'awaiting_feature_close → done')).toEqual([]);

    // ======================================================================
    // THE CONTROL
    // ======================================================================
    // The machinery was capable throughout — only the checkpoint held it. Without
    // this, a close that was broken for some unrelated reason would pass every
    // assertion above.
    await approve(actions(), FEATURE_ID);
    expect(feature().status).toBe('done');
    expect(sha(vault.repo.branch)).not.toBe(baseBefore);
    expect(tags()).toHaveLength(1);
  }, 300_000);

  it('records the human as the actor when it is a human who approves', async () => {
    // The other side of the actor change: `needs_human → done` stays human-only
    // and is taken by a person, so it must still say so.
    await openVault();
    await oneTicketToDone();
    await approve(actions(), FEATURE_ID);

    const closing = historyLines(featureBody()).find((line) =>
      line.includes('needs_human → done'),
    );
    expect(closing, 'the feature never closed').not.toBeUndefined();
    expect((closing ?? '').split('|').map((part) => part.trim())[2]).toBe('human');
  }, 240_000);
});

// ===========================================================================
// THE GATE VERDICT GOES STALE BETWEEN THE CHECKPOINT AND THE APPROVAL.
// ===========================================================================

/**
 * ============================================================================
 * THE WINDOW THE CHECKPOINT OPENS, AND WHAT IT LETS THROUGH
 * ============================================================================
 * The feature-branch gates run **before** the checkpoint. The approval arrives
 * whenever a person gets to it — minutes or days later. Nothing re-checked in
 * between, so anything landing on the feature branch inside that window went to
 * the base branch **unverified**, carrying a tag that says it was delivered.
 *
 * Probed on real git before the fix: a failing test committed to the feature
 * branch after the checkpoint was offered, then approved. The feature reached
 * `done`, the red commit became an ancestor of the base branch, and it was
 * tagged.
 *
 *     P1 approve threw: no
 *     P1 feature status: done  pause_reason: null
 *     P1 red commit on base? true
 *     P1 tags: [ 'factory/sample/2026-09-02' ]
 *
 * That is the same class of bug Phase 10 found one level down — a check made
 * once, with a window after it as long as a human's attention span rather than
 * as long as a test suite — and it breaches plan Section E item 3 in spirit: a
 * **stale green** does what no red gate is permitted to do.
 *
 * The fix is Phase 10's: record the SHA the gates actually verified
 * (`verified_sha`) and re-check it at approve time. It **refuses** rather than
 * re-running the gates, and the refusal rewrites `resume_to` to
 * `awaiting_feature_close` so that approving again sends the feature back to be
 * verified afresh. Refusing fails toward a stuck feature rather than an
 * unverified base branch, and re-running the gates inside `factory approve`
 * would need a gate runner and a worktree provider in the CLI's action context —
 * handing every `approve`/`reject`/`kill` the ability to run subprocesses in the
 * target repo, to do a job the loop already does on its next cycle.
 */
describe('a feature branch that moves after the checkpoint', () => {
  it('records the commit the gates verified, and it is the branch tip at that moment', async () => {
    await openVault();
    await oneTicketToDone();

    const front = feature();
    expect(front.pause_reason).toBe('checkpoint');
    expect(front.verified_sha, 'nothing recorded what the gates verified').not.toBeNull();
    expect(front.verified_sha).toBe(sha(FEATURE_BRANCH));
    // And the summary a human reads names the same commit.
    expect(sectionText(featureBody(), SECTION.notes)).toContain(
      (front.verified_sha ?? '').slice(0, 8),
    );
  }, 240_000);

  it('refuses the approval when the branch has gone red underneath it', async () => {
    await openVault();
    await oneTicketToDone();

    const verified = feature().verified_sha ?? '';
    const baseBefore = sha(vault.repo.branch);
    const red = commitOnBranch(
      FEATURE_BRANCH,
      'src/late.test.ts',
      RED_TEST,
      'chore: one more fix, landed while the approval was pending',
    );
    expect(sha(FEATURE_BRANCH), 'the fixture did not move the branch').toBe(red);

    await expect(approve(actions(), FEATURE_ID, 'approving what the summary showed me')).rejects.toThrow(
      ActionError,
    );

    // Nothing reached the base branch, and nothing was tagged.
    expect(
      isAncestor(red, vault.repo.branch),
      'an unverified commit reached the base branch',
    ).toBe(false);
    expect(sha(vault.repo.branch), 'the base branch moved on a stale verdict').toBe(baseBefore);
    expect(tags(), 'a stale verdict was tagged as a delivery').toEqual([]);

    const parked = feature();
    expect(parked.status).toBe('needs_human');
    expect(parked.tag).toBeNull();
    expect(parked.pause_reason).toBe('escalation');
    // Both SHAs are named, so a human can see exactly what moved.
    expect(parked.pause_detail).toContain(verified.slice(0, 8));
    expect(parked.pause_detail).toContain(red.slice(0, 8));
    // And approving again sends it back to be verified rather than refusing forever.
    expect(
      parked.resume_to,
      'the refusal left no way back, so the feature is stuck for good',
    ).toBe('awaiting_feature_close');
    expect(parked.reject_to).toBe('in_development');

    // The refused approval reaches the event log too. Without it the attempt
    // exists only in the note, so a log reader sees an approval that never
    // happened (spec §12: one line per decision).
    const refused = events.ofType('feature_close_refused');
    expect(refused, 'a refused approval left no trace in the event log').toHaveLength(1);
    expect(refused[0]?.featureId).toBe(FEATURE_ID);
    expect(refused[0]?.detail).toContain('has moved since its gates ran');
    // And no close was ever started, so the nothing-happened contract holds.
    expect(events.ofType('feature_close_started')).toHaveLength(0);
  }, 240_000);

  it('refuses even when the branch moved and is still green', async () => {
    // ======================================================================
    // THE POINT IS NOT THAT RED IS BAD
    // ======================================================================
    // It is that **the thing a human approved is the thing that lands**. A
    // passing commit added after the checkpoint was never shown to the
    // approver, was never gated on the branch they were told about, and would
    // reach the base branch on their signature. An implementation that only
    // re-ran the gates would let this through; this case is what separates the
    // two designs.
    await openVault();
    await oneTicketToDone();

    const baseBefore = sha(vault.repo.branch);
    const green = commitOnBranch(
      FEATURE_BRANCH,
      'src/extra.ts',
      'export const extra = 1;\n',
      'chore: a harmless extra commit',
    );

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(/verified/i);

    expect(isAncestor(green, vault.repo.branch)).toBe(false);
    expect(sha(vault.repo.branch)).toBe(baseBefore);
    expect(tags()).toEqual([]);
    expect(feature().status).toBe('needs_human');
    expect(feature().resume_to).toBe('awaiting_feature_close');
  }, 240_000);

  it('refuses when nothing recorded what was verified at all', async () => {
    // `verified_sha: null` is absent evidence, and absent evidence refuses —
    // the same rule as the transition guard's `!== true`. Reachable by a
    // hand-edited note, which ADR-001 makes a supported way into any state.
    await openVault();
    await oneTicketToDone();

    const note = readNoteFile(vault.paths.featureNote(SLUG));
    await vault.storage.writeNote(vault.paths.featureNote(SLUG), {
      frontmatter: { ...(note.frontmatter as FeatureFrontmatter), verified_sha: null },
      body: note.body,
    });
    const baseBefore = sha(vault.repo.branch);

    // The *message* matters, not just the refusal. With the null branch removed
    // the tip-comparison below refuses anyway — `tip === null` is false — so a
    // bare `rejects.toThrow(ActionError)` passed with the check disabled and
    // pinned nothing. A note with no recorded verdict is a different situation
    // from a branch that moved, and the human is told which one it is.
    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(/records no verified commit/);

    expect(sha(vault.repo.branch)).toBe(baseBefore);
    expect(tags()).toEqual([]);
    expect(feature().status).toBe('needs_human');
    expect(feature().pause_detail).toContain('records no verified commit');
    expect(feature().resume_to).toBe('awaiting_feature_close');
  }, 240_000);

  it('re-verifies and then closes, once the branch is fixed', async () => {
    // The whole recovery narrative, because a refusal with no way out is its
    // own bug. Red commit → refused → approve again → back to
    // `awaiting_feature_close` → the loop re-runs the gates → red, so parked
    // again → the branch is fixed → fresh checkpoint at a new `verified_sha` →
    // approve → the fixed branch lands.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    await drive(runner, 3, { close: true });
    const firstVerified = feature().verified_sha;

    commitOnBranch(FEATURE_BRANCH, 'src/late.test.ts', RED_TEST, 'chore: late red commit');
    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(ActionError);

    // Approving again takes the generic route back to be verified.
    const back = await approve(actions(), FEATURE_ID);
    expect(back.to).toBe('awaiting_feature_close');
    expect(feature().status).toBe('awaiting_feature_close');

    // The loop re-runs the gates and finds the branch red.
    await drive(runner, 2, { close: true });
    expect(feature().pause_reason, 'the re-run did not catch the red branch').toBe('escalation');
    expect(feature().verified_sha, 'a red run left a verified SHA behind').toBeNull();
    expect(tags()).toEqual([]);

    // Somebody fixes the branch.
    git(vault.repo.path, ['checkout', '--quiet', FEATURE_BRANCH]);
    rmSync(path.join(vault.repo.path, 'src', 'late.test.ts'));
    git(vault.repo.path, ['add', '-A']);
    git(vault.repo.path, [
      '-c', 'user.name=A Colleague', '-c', 'user.email=colleague@example.invalid',
      'commit', '--quiet', '-m', 'fix: drop the broken test',
    ]);
    git(vault.repo.path, ['checkout', '--quiet', vault.repo.branch]);

    // Back round: approve the escalation, and the loop offers a fresh checkpoint.
    await approve(actions(), FEATURE_ID);
    await drive(runner, 2, { close: true });

    const fresh = feature();
    expect(fresh.pause_reason, 'no fresh checkpoint was offered').toBe('checkpoint');
    expect(fresh.verified_sha).toBe(sha(FEATURE_BRANCH));
    expect(fresh.verified_sha, 'the stale verdict was reused').not.toBe(firstVerified);

    await approve(actions(), FEATURE_ID);
    expect(feature().status).toBe('done');
    expect(isAncestor(sha(FEATURE_BRANCH), vault.repo.branch)).toBe(true);
    expect(tags()).toHaveLength(1);
  }, 300_000);
});

// ===========================================================================
// A RE-VERIFICATION DOES NOT DESTROY THE RUN BEFORE IT.
// ===========================================================================

describe('the gate logs of a feature verified twice', () => {
  it('keeps both runs, because the log path carries the commit', async () => {
    // A feature's `attempts` never moves, so both verifications write
    // `attempt 1` — and with only that in the path the second run overwrote the
    // first. The run destroyed is precisely the one somebody debugging a
    // rejected feature came to read. Phase 5 settled the principle for agent
    // transcripts; this is it for gate logs.
    await openVault();
    const runner = scriptedAgents({
      developer: addsModule('describe'),
      [`developer:${THIRD_TICKET_ID}`]: addsModule('summarise'),
      ...APPROVING,
    });

    await drive(runner, 3, { close: true });
    const firstSha = feature().verified_sha ?? '';
    const firstLogs = closeGateLogs();
    expect(firstLogs, 'the first verification wrote no gate logs').not.toEqual([]);

    // Rejected, another ticket lands, and the feature is verified again at a
    // different commit.
    await reject(actions(), FEATURE_ID, 'we also need a summarise() helper');
    await addTicket(THIRD_TICKET_ID, 'Add a summarise helper', 3);
    await drive(runner, 4, { close: true });

    const secondSha = feature().verified_sha ?? '';
    expect(feature().pause_reason).toBe('checkpoint');
    expect(secondSha, 'the second verification was of the same commit').not.toBe(firstSha);

    // Both runs' logs are on disk, and the first one's are still readable.
    const bothLogs = closeGateLogs();
    expect(bothLogs.some((file) => file.includes(firstSha.slice(0, 8)))).toBe(true);
    expect(bothLogs.some((file) => file.includes(secondSha.slice(0, 8)))).toBe(true);
    expect(
      bothLogs.length,
      'the second verification overwrote the first run’s gate logs',
    ).toBeGreaterThan(firstLogs.length);
    for (const file of firstLogs) {
      expect(existsSync(path.join(vault.paths.logsDir(), SLUG, file))).toBe(true);
    }
  }, 300_000);
});

// ===========================================================================
// THE TAG A HUMAN IS PROMISED IS THE TAG THEY GET.
// ===========================================================================

/**
 * The approval summary is written at checkpoint time and the tag is created at
 * approve time. Each used to read its own clock, so a human approving the next
 * day was promised one name and given another. Proven with injected clocks
 * rather than left to wall-clock luck:
 *
 *     checkpoint written at : 2026-09-02T23:00:00.000Z
 *     summary promised tag  : factory/sample/2026-09-02
 *     approved at           : 2026-09-03T09:15:00.000Z
 *     tag actually created  : factory/sample/2026-09-03
 *     MISMATCH?             : true
 *
 * `paused_at` is now the single authority for the date. It is set by `pauseItem`
 * at exactly the moment the summary is written — "when the thing you are
 * approving was put in front of you" — so the two cannot disagree, and the
 * delivery is dated by when it was verified rather than by when somebody got
 * round to clicking.
 */
describe('the tag name a human is shown', () => {
  it('is the tag that gets created, even when the approval comes the next day', async () => {
    await openVault();
    // The orchestrator's clock: pinned before midnight and not moving, so the
    // checkpoint is unambiguously written on the 2nd.
    const yesterday = (): string => '2026-09-02T23:00:00.000Z';
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    await drive(runner, 3, {
      close: true,
      capability: realCapability(vault, { events, now: yesterday }),
      now: yesterday,
    });

    const front = feature();
    expect(front.pause_reason).toBe('checkpoint');
    expect(front.paused_at, 'nothing recorded when the feature was put in front of a human').toBe(
      '2026-09-02T23:00:00.000Z',
    );
    const promised =
      /factory\/sample\/\d{4}-\d{2}-\d{2}/.exec(
        sectionText(featureBody(), SECTION.notes) ?? '',
      )?.[0] ??
      '(the summary promised no tag name)';
    expect(promised).toBe('factory/sample/2026-09-02');

    // The human's clock: the next morning.
    await approve(
      { ...actions(), now: (): string => '2026-09-03T09:15:00.000Z' },
      FEATURE_ID,
    );

    expect(feature().tag, 'the tag created is not the tag the human was promised').toBe(promised);
    expect(tags()).toEqual([promised]);
    expect(sha(promised)).toBe(sha(vault.repo.branch));
  }, 240_000);
});

// ===========================================================================
// `factory status` on a delivered feature.
// ===========================================================================

describe('factory status', () => {
  it('reports a done feature with the tag that marks its delivery', async () => {
    // `done` *means* merged into the base branch and tagged, and the tag is the
    // only half of that a human can check without opening git. Driven through
    // the real command rather than asserted on `formatReport`, so the whole
    // chain — frontmatter, report, printed line — is what is checked.
    await openVault();
    await oneTicketToDone();
    const approvedAt = now();
    await approve(actions(), FEATURE_ID);

    const lines: string[] = [];
    const report = await runStatus(
      { vault: vault.paths.root },
      {
        cwd: vault.paths.root,
        env: {},
        registry: new ProjectRegistry(scratchFactoryHome()),
        out: (line: string) => lines.push(line),
        err: () => undefined,
        now,
      },
    );

    const expectedTag = featureTagName(SLUG, approvedAt);
    const reported = report.features.find((entry) => entry.slug === SLUG);
    expect(reported?.status).toBe('done');
    expect(reported?.tag).toBe(expectedTag);
    expect(lines.join('\n')).toContain(expectedTag);
    // And it really is the tag git holds.
    expect(tags()).toContain(expectedTag);
  }, 240_000);

  it('says `(untagged)` for a done feature with no tag, rather than leaving it blank', async () => {
    // Should be unreachable — `featureCloseVerified` refuses `done` without a
    // tag — so this is a hand-edited note, which ADR-001 makes a supported way
    // to reach any state. A blank column would read as "nothing to report",
    // which for a delivery record with no marker is the wrong impression.
    await openVault();
    await oneTicketToDone();
    await approve(actions(), FEATURE_ID);

    const note = readNoteFile(vault.paths.featureNote(SLUG));
    await vault.storage.writeNote(vault.paths.featureNote(SLUG), {
      frontmatter: { ...(note.frontmatter as FeatureFrontmatter), tag: null },
      body: note.body,
    });

    const lines: string[] = [];
    await runStatus(
      { vault: vault.paths.root },
      {
        cwd: vault.paths.root,
        env: {},
        registry: new ProjectRegistry(scratchFactoryHome()),
        out: (line: string) => lines.push(line),
        err: () => undefined,
        now,
      },
    );

    expect(lines.join('\n')).toContain('(untagged)');
  }, 240_000);
});

// ===========================================================================
// THE BASE BRANCH IS WRITTEN BY NOTHING ELSE (plan Section E item 8).
// ===========================================================================

describe('the base branch', () => {
  it('is not moved by the dev loop or by either ticket merge — only by the approval', async () => {
    // Every state Phases 9 and 10 produce, in one narrative, with the base SHA
    // checked at each step. The Phase 10 suite asserts this for its own
    // scenarios; what is new here is that the *close* is the thing that moves
    // it, so "unchanged" has to be checked right up to the approval rather than
    // at the end of a run where nothing could have moved it anyway.
    await openVault({ tickets: 2 });
    const baseBefore = sha(vault.repo.branch);
    const runner = scriptedAgents({
      'developer:FEAT-SAMPLE-T001': addsModule('describe'),
      'developer:FEAT-SAMPLE-T002': addsModule('explain'),
      ...APPROVING,
    });

    // Phase 9: the dev loop, with no merge capability at all.
    await drive(runner, 2, { close: false });
    expect(ticket().frontmatter.status).toBe('merge');
    expect(ticket(SECOND_TICKET_ID).frontmatter.status).toBe('merge');
    expect(sha(vault.repo.branch), 'the Phase 9 dev loop moved the base branch').toBe(baseBefore);
    expect(tags(), 'the Phase 9 dev loop tagged the repo').toEqual([]);

    // Phase 10: both ticket merges, and the feature reaching the checkpoint.
    await drive(runner, 3, { close: true });
    expect(ticket().frontmatter.status).toBe('done');
    expect(ticket(SECOND_TICKET_ID).frontmatter.status).toBe('done');
    expect(sha(vault.repo.branch), 'a ticket merge moved the base branch').toBe(baseBefore);
    expect(tags(), 'a ticket merge tagged the repo').toEqual([]);
    expect(feature().status).toBe('needs_human');

    // Only now.
    await approve(actions(), FEATURE_ID);
    expect(sha(vault.repo.branch)).not.toBe(baseBefore);
    expect(tags()).toHaveLength(1);
  }, 300_000);

  it('is not moved by a rejection', async () => {
    await openVault();
    const baseBefore = sha(vault.repo.branch);

    await oneTicketToDone();
    await reject(actions(), FEATURE_ID, 'the empty-input case is missing');

    expect(feature().status).toBe('in_development');
    expect(sha(vault.repo.branch), 'a rejection moved the base branch').toBe(baseBefore);
    expect(tags(), 'a rejection tagged the repo').toEqual([]);
    expect(feature().tag).toBeNull();
  }, 240_000);

  it('is not moved when the feature-branch gates are red', async () => {
    // A red feature branch reached by the one route real git makes available:
    // something landed on the branch that was not a verified ticket merge — a
    // hand-applied hotfix, a colleague, a rebase gone wrong. Phase 10's
    // post-merge gates guarantee the branch is green after every *merge*, and
    // they say nothing about what happens to it afterwards.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });
    await drive(runner, 3, { close: true });
    expect(ticket().frontmatter.status).toBe('done');
    expect(feature().pause_reason).toBe('checkpoint');

    // Sent back to development, which is the one route that puts the feature
    // where the close will be attempted again — `done` is terminal and a
    // feature parked at the checkpoint is not re-dispatched.
    await reject(actions(), FEATURE_ID, 'hold on, something else is landing on the branch');
    expect(feature().status).toBe('in_development');

    const baseBefore = sha(vault.repo.branch);
    // A failing test committed straight onto the feature branch.
    git(vault.repo.path, ['checkout', '--quiet', FEATURE_BRANCH]);
    writeFileSync(
      path.join(vault.repo.path, 'src', 'hotfix.test.ts'),
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('somebody broke the branch', () => {",
        '  assert.equal(1, 2);',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    git(vault.repo.path, ['add', '-A']);
    git(vault.repo.path, [
      '-c',
      'user.name=A Colleague',
      '-c',
      'user.email=colleague@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'chore: a hotfix that does not pass',
    ]);
    git(vault.repo.path, ['checkout', '--quiet', vault.repo.branch]);

    await drive(runner, 2, { close: true });

    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.pause_reason, 'a red feature branch was offered for final acceptance').toBe(
      'escalation',
    );
    expect(front.resume_to).toBe('awaiting_feature_close');
    expect(sha(vault.repo.branch), 'a red feature branch reached the base branch').toBe(baseBefore);
    expect(tags()).toEqual([]);

    // And approving it is refused, because the guard has no merge to be told
    // about — the pause is not a final-acceptance pause at all.
    await expect(approve(actions(), FEATURE_ID)).resolves.toMatchObject({
      to: 'awaiting_feature_close',
    });
    expect(feature().status).toBe('awaiting_feature_close');
    expect(sha(vault.repo.branch)).toBe(baseBefore);
  }, 300_000);
});

// ===========================================================================
// A BASE BRANCH THAT MOVED SINCE THE FEATURE BRANCH WAS CUT.
// ===========================================================================

describe('a base branch that moved ahead', () => {
  it('merges cleanly and drops neither side’s commits', async () => {
    await openVault();
    const baseBefore = sha(vault.repo.branch);

    await oneTicketToDone();
    const featureTip = sha(FEATURE_BRANCH);

    // A colleague lands something unrelated on the base branch.
    const colleague = commitOnBase(
      'src/unrelated.ts',
      'export const unrelated = true;\n',
      'chore: something else entirely',
    );
    expect(sha(vault.repo.branch)).toBe(colleague);

    await approve(actions(), FEATURE_ID);

    expect(feature().status).toBe('done');
    // ====================================================================
    // NEITHER SIDE IS SILENTLY DROPPED
    // ====================================================================
    // Both parents are ancestors of the new tip. A merge that had quietly
    // fast-forwarded, reset, or force-moved the base branch would lose one of
    // them, and the file assertions below would still pass for the half that
    // survived — so the ancestry is what is asserted.
    expect(isAncestor(colleague, vault.repo.branch), 'the colleague’s commit was dropped').toBe(
      true,
    );
    expect(isAncestor(featureTip, vault.repo.branch), 'the feature’s commits were dropped').toBe(
      true,
    );
    expect(isAncestor(baseBefore, vault.repo.branch)).toBe(true);
    expect(git(vault.repo.path, ['show', `${vault.repo.branch}:src/unrelated.ts`])).toContain(
      'unrelated',
    );
    expect(git(vault.repo.path, ['show', `${vault.repo.branch}:src/describe.ts`])).toContain(
      'describe',
    );
    expect(tags()).toHaveLength(1);
  }, 240_000);

  it('conflicts cleanly, tags nothing, and leaves the base branch exactly where it was', async () => {
    await openVault();

    // The Developer changes `add`; the colleague changes the same lines on base.
    const runner = scriptedAgents({
      developer: {
        then: (cwd: string): void => {
          const file = path.join(cwd, 'src/calc.ts');
          writeFileSync(
            file,
            readFileSync(file, 'utf8').replace('return a + b;', 'return a + b + 1;'),
            'utf8',
          );
          const test = path.join(cwd, 'src/calc.test.ts');
          writeFileSync(
            test,
            readFileSync(test, 'utf8')
              .replace('assert.equal(add(2, 3), 5);', 'assert.equal(add(2, 3), 6);')
              .replace('assert.equal(add(-1, 1), 0);', 'assert.equal(add(-1, 1), 1);'),
            'utf8',
          );
        },
        structured: developerPayload({
          commit_message: 'feat(calc): shift add by 1',
          files_changed: ['src/calc.ts', 'src/calc.test.ts'],
        }),
      },
      ...APPROVING,
    });
    await drive(runner, 3, { close: true });
    expect(ticket().frontmatter.status).toBe('done');
    expect(feature().pause_reason).toBe('checkpoint');

    const calc = path.join(vault.repo.path, 'src', 'calc.ts');
    commitOnBase(
      'src/calc.ts',
      readFileSync(calc, 'utf8').replace('return a + b;', 'return a + b + 100;'),
      'chore: somebody else changed add too',
    );
    const baseBefore = sha(vault.repo.branch);

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(ActionError);

    const front = feature();
    expect(front.status, 'a conflicted base merge produced a done feature').toBe('needs_human');
    expect(front.pause_reason).toBe('merge_conflict');
    expect(front.pause_detail).toContain('src/calc.ts');
    expect(front.pause_detail).toContain('never retried');
    expect(front.tag).toBeNull();

    // The base branch is exactly where it was, nothing is tagged, and the
    // repository is not left mid-merge.
    expect(sha(vault.repo.branch)).toBe(baseBefore);
    expect(tags(), 'a conflicted close tagged something').toEqual([]);
    expect(repoIsMidMerge(), 'the repository was left mid-merge').toBe(false);
    expect(git(vault.repo.path, ['status', '--porcelain']).trim()).toBe('');
    // Approving again is the documented route, and it comes back here.
    expect(front.resume_to).toBe('done');
    expect(events.ofType('feature_close_conflict')).toHaveLength(1);
    expect(events.ofType('feature_closed')).toHaveLength(0);
  }, 300_000);
});

// ===========================================================================
// A COLLIDING TAG NAME, AGAINST REAL GIT.
// ===========================================================================

describe('a tag name that git already knows', () => {
  it('refuses before the base branch is touched, rather than surfacing git’s error', async () => {
    // Two closes of the same feature on the same day want the same name, and
    // the name is required to be deterministic. `git tag` on an existing name
    // exits non-zero with "already exists"; letting that reach the operator
    // after the merge had already landed would be the worst of both.
    await openVault();
    await oneTicketToDone();

    const collidingWith = sha(vault.repo.branch);
    // Plant the tag the close is about to want, pointing somewhere else.
    git(vault.repo.path, ['tag', featureTagName(SLUG, now()), collidingWith]);
    const baseBefore = sha(vault.repo.branch);
    const before = tags();
    expect(before).toHaveLength(1);

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(/already exists/);

    expect(sha(vault.repo.branch), 'a colliding tag still let the merge happen').toBe(baseBefore);
    expect(tags(), 'the existing tag was moved or a second one was made').toEqual(before);
    expect(sha(before[0] ?? '')).toBe(collidingWith);
    expect(feature().status).toBe('needs_human');
    expect(feature().tag).toBeNull();
  }, 240_000);
});

// ===========================================================================
// REJECT, AND WHAT COMES AFTER IT.
// ===========================================================================

describe('rejecting at final acceptance', () => {
  it('returns the feature to in_development, and a new ticket then flows normally', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: addsModule('describe'),
      [`developer:${THIRD_TICKET_ID}`]: addsModule('summarise'),
      ...APPROVING,
    });

    await drive(runner, 3, { close: true });
    expect(feature().pause_reason).toBe('checkpoint');

    await reject(actions(), FEATURE_ID, 'we also need a summarise() helper');

    expect(feature().status).toBe('in_development');
    expect(sectionText(featureBody(), SECTION.notes)).toContain('summarise() helper');
    expect(historyLines(featureBody()).join('\n')).toContain('summarise() helper');

    // A new ticket, as a human would add after rejecting.
    await addTicket(THIRD_TICKET_ID, 'Add a summarise helper', 3);

    await drive(runner, 4, { close: true });

    // It went all the way through the dev loop, the ticket merge, and back to
    // the checkpoint — the whole pipeline, not just the transition.
    expect(ticket(THIRD_TICKET_ID).frontmatter.status).toBe('done');
    expect(subjects(FEATURE_BRANCH)).toContain('feat(summarise): add the summarise helper');
    expect(feature().status).toBe('needs_human');
    expect(feature().pause_reason).toBe('checkpoint');
    expect(sectionText(featureBody(), SECTION.notes)).toContain(THIRD_TICKET_ID);

    // And now approving lands both tickets on the base branch.
    await approve(actions(), FEATURE_ID);
    expect(feature().status).toBe('done');
    expect(git(vault.repo.path, ['show', `${vault.repo.branch}:src/summarise.ts`])).toContain(
      'summarise',
    );
    expect(git(vault.repo.path, ['show', `${vault.repo.branch}:src/describe.ts`])).toContain(
      'describe',
    );
  }, 300_000);
});

// ===========================================================================
// `final_acceptance: false`.
// ===========================================================================

describe('final_acceptance disabled in config', () => {
  it('merges and tags without ever pausing', async () => {
    await openVault({ finalAcceptance: false });
    const baseBefore = sha(vault.repo.branch);
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 4, { close: true });

    const front = feature();
    expect(front.status).toBe('done');
    expect(front.tag).not.toBeNull();
    expect(tags()).toEqual([front.tag]);
    expect(sha(front.tag ?? '')).toBe(sha(vault.repo.branch));
    expect(sha(vault.repo.branch)).not.toBe(baseBefore);
    expect(isAncestor(baseBefore, vault.repo.branch)).toBe(true);

    // Straight through: the feature never sat at `needs_human`.
    const moves = historyLines(featureBody()).map((line) => line.split(' | ')[1]);
    expect(moves).toContain('awaiting_feature_close → done');
    expect(moves.filter((move) => move?.endsWith('needs_human'))).toEqual([]);

    // And the actor is the orchestrator, because that is who took the move —
    // no person was involved anywhere in this run.
    const closing = historyLines(featureBody()).find((line) =>
      line.includes('awaiting_feature_close → done'),
    );
    expect((closing ?? '').split('|').map((part) => part.trim())[2]).toBe('orchestrator');
    expect(closing).toContain('final_acceptance checkpoint is disabled in config');
  }, 300_000);
});

// ===========================================================================
// THE OPERATOR'S OWN CHECKOUT.
// ===========================================================================

describe('the operator’s main checkout', () => {
  it('is refused when dirty, and its uncommitted work survives untouched', async () => {
    // The close checks the base branch out there (spec §10). Those edits would
    // otherwise end up on top of a base branch the operator did not merge into.
    await openVault();
    await oneTicketToDone();

    const edited = path.join(vault.repo.path, 'src', 'calc.ts');
    const operatorText = `${readFileSync(edited, 'utf8')}\n// the operator was mid-thought\n`;
    writeFileSync(edited, operatorText, 'utf8');
    const baseBefore = sha(vault.repo.branch);

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(/uncommitted/);

    expect(feature().status).toBe('needs_human');
    expect(feature().pause_detail).toContain('src/calc.ts');
    expect(sha(vault.repo.branch)).toBe(baseBefore);
    expect(tags()).toEqual([]);
    expect(
      readFileSync(edited, 'utf8'),
      'the factory touched the operator’s uncommitted work',
    ).toBe(operatorText);
  }, 240_000);

  it('is not refused for untracked files alone', async () => {
    await openVault();
    await oneTicketToDone();
    writeFileSync(path.join(vault.repo.path, 'notes.txt'), 'my own scratch notes\n', 'utf8');

    await approve(actions(), FEATURE_ID);

    expect(feature().status).toBe('done');
    expect(existsSync(path.join(vault.repo.path, 'notes.txt'))).toBe(true);
  }, 240_000);
});

// ===========================================================================
// TWO PATHS THAT WERE MOCK-ONLY, NOW ON REAL GIT.
// ===========================================================================

/**
 * ============================================================================
 * BOTH OF THESE WERE REPORTED AS UNVERIFIABLE, AND BOTH TURNED OUT NOT TO BE
 * ============================================================================
 * Phase 11 shipped saying real git could not be made to fail `git tag` after a
 * successful merge, and that a genuine `git checkout <base>` refusal was
 * simulated only. The review found a way to do both, so the two most dangerous
 * outcomes on the base-branch path — the merge landing without its tag, and the
 * checkout being refused mid-close — are now proven against real git rather
 * than against a `Map.set` and a thrown fixture.
 */
describe('a tag that git itself refuses, after the merge has landed', () => {
  it('leaves the merge, escalates, and completes on a second approval', async () => {
    // The blocker: a non-empty **directory** exactly where the tag's loose ref
    // file would be written. git cannot create the ref, so `git tag` fails
    // after `git merge` has already committed — the one ordering that leaves
    // the base branch moved and the delivery unmarked.
    await openVault();
    await oneTicketToDone();

    const baseBefore = sha(vault.repo.branch);
    const pausedAtCheckpoint = feature().paused_at;
    const tagName = featureTagName(SLUG, pausedAtCheckpoint ?? '');
    const blocker = path.join(vault.repo.path, '.git', 'refs', 'tags', tagName);
    mkdirSync(blocker, { recursive: true });
    writeFileSync(path.join(blocker, 'blocker'), 'x', 'utf8');

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(ActionError);

    const parked = feature();
    expect(parked.status, 'a feature with no tag was recorded as delivered').toBe('needs_human');
    expect(parked.tag, 'the note recorded a tag git never created').toBeNull();
    expect(parked.pause_reason).toBe('escalation');
    expect(parked.resume_to).toBe('done');
    // The re-park changed *why* the feature is parked and nothing else. Moving
    // `paused_at` here would re-date the delivery on every retry, which is what
    // the next-day approval below would then produce a different name for.
    expect(
      parked.paused_at,
      'the re-park moved paused_at, so a retry would rename the delivery',
    ).toBe(pausedAtCheckpoint);

    // The merge really did land, and nothing rewound it.
    const afterFirst = sha(vault.repo.branch);
    expect(afterFirst, 'the merge did not land, so this proves nothing').not.toBe(baseBefore);
    expect(isAncestor(sha(FEATURE_BRANCH), vault.repo.branch)).toBe(true);
    expect(tags(), 'a tag exists after git refused to make one').toEqual([]);
    expect(repoIsMidMerge()).toBe(false);
    expect(events.ofType('feature_tag_failed')).toHaveLength(1);
    expect(events.ofType('feature_closed')).toHaveLength(0);

    // The detail names both SHAs and tells the human that re-approving is safe.
    expect(parked.pause_detail).toContain(afterFirst);
    expect(parked.pause_detail).toContain(baseBefore);
    expect(parked.pause_detail).toContain('Approving again is safe');

    // ======================================================================
    // THE RECOVERY, WHICH USED TO BE A CLAIM IN A COMMENT
    // ======================================================================
    // `git merge --no-ff` of an already-merged branch reports success without a
    // new commit, so the second attempt goes straight to the tag. Note the tag
    // name is **not** recomputed from a fresh clock: it comes from `paused_at`,
    // so a retry cannot rename the delivery.
    rmSync(blocker, { recursive: true, force: true });
    // ======================================================================
    // AND THE RETRY HAPPENS THE NEXT DAY
    // ======================================================================
    // Deliberately across midnight. The name comes from `paused_at`, which
    // `reparkFeature` leaves alone, so a retry cannot rename the delivery. With
    // the retry inside the same day this assertion passes either way — that is
    // exactly how a `paused_at`-overwriting mutation survived the first version
    // of this case.
    await approve({ ...actions(), now: (): string => '2026-09-05T08:00:00.000Z' }, FEATURE_ID);

    const closed = feature();
    expect(closed.status).toBe('done');
    expect(
      closed.tag,
      'a retry on a later day renamed the delivery it was promised',
    ).toBe(tagName);
    expect(tags()).toEqual([tagName]);
    // The pause machinery is cleared by a successful close, so `paused_at` is
    // null here by design — the stability assertion is on `parked` above.
    expect(closed.paused_at).toBeNull();
    expect(sha(vault.repo.branch), 'the second approval moved the base branch again').toBe(
      afterFirst,
    );
    expect(sha(tagName)).toBe(afterFirst);
  }, 300_000);
});

describe('a `git checkout <base>` that real git refuses', () => {
  it('escalates without touching the base branch or the operator’s file', async () => {
    // The real refusal, not a simulated raise: the base branch gains a tracked
    // file, the operator sits on a branch cut before it, and holds an untracked
    // copy of that same path. `git checkout <base>` then refuses rather than
    // clobbering it, and `ShellGit.mergeNoFf` raises from inside the close.
    await openVault();
    await oneTicketToDone();

    const baseBefore = sha(vault.repo.branch);
    git(vault.repo.path, ['checkout', '--quiet', '-b', 'wip/old', baseBefore]);
    commitOnBranch(
      vault.repo.branch,
      'src/only-on-base.ts',
      'export const onlyOnBase = 1;\n',
      'chore: a file that exists only on the base branch',
    );
    const baseNow = sha(vault.repo.branch);
    const mine = path.join(vault.repo.path, 'src', 'only-on-base.ts');
    const myBytes = '// MY UNTRACKED COPY, NOT COMMITTED ANYWHERE\n';
    writeFileSync(mine, myBytes, 'utf8');

    await expect(approve(actions(), FEATURE_ID)).rejects.toThrow(ActionError);

    const parked = feature();
    expect(parked.status).toBe('needs_human');
    expect(parked.pause_reason).toBe('escalation');
    expect(parked.tag).toBeNull();
    // Nothing merged, nothing tagged, and the operator's bytes are their own.
    expect(sha(vault.repo.branch), 'the base branch moved through a refused checkout').toBe(
      baseNow,
    );
    expect(tags()).toEqual([]);
    expect(
      readFileSync(mine, 'utf8'),
      'the close overwrote a file the operator had not committed',
    ).toBe(myBytes);
    expect(repoIsMidMerge()).toBe(false);
    // Left where they were, on their own branch.
    expect(git(vault.repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('wip/old');
    // And git's own message survives into the note, so the fix is discoverable.
    expect(parked.pause_detail).toContain('untracked working tree files');
    expect(events.ofType('feature_close_refused')).toHaveLength(1);
  }, 300_000);
});

// ===========================================================================
// ADR-004 — no agent is anywhere near the close.
// ===========================================================================

describe('the Runner', () => {
  it('is never invoked for the feature close', async () => {
    // Asserted on the Runner itself. A dispatcher that ran an agent and then
    // closed deterministically anyway would satisfy every state assertion here.
    await openVault();
    const runner = scriptedAgents({ developer: addsModule('describe'), ...APPROVING });

    await drive(runner, 2, { close: false });
    const beforeClose = runner.roles();
    expect(beforeClose, 'the dev loop ran no agent, so this proves nothing').not.toEqual([]);

    await drive(runner, 3, { close: true });
    expect(feature().pause_reason).toBe('checkpoint');
    await approve(actions(), FEATURE_ID);

    expect(feature().status).toBe('done');
    expect(runner.roles(), 'an agent was invoked during the feature close (ADR-004)').toEqual(
      beforeClose,
    );
  }, 300_000);
});

// ===========================================================================
// The tag `ShellGit` actually makes.
// ===========================================================================

/**
 * ============================================================================
 * A REPO THAT SIGNS ITS TAGS — AND THE COMMENT THAT WAS WRONG ABOUT IT
 * ============================================================================
 * `ShellGit.tag`'s comment used to say that `commit.gpgsign=false` "says
 * nothing about `tag.gpgsign`, which only applies to **annotated** tags", and
 * that the method was therefore safe without it. Probed on git 2.39.5 while
 * writing this file, that is false: `tag.gpgsign=true` promotes even a bare
 * `git tag <name> <ref>` into a signed tag, which has no message and exits 128
 * with `fatal: no tag message?`.
 *
 * So a target repo with `tag.gpgsign=true` broke the feature close outright —
 * not by hanging on a prompt, as the comment predicted, but with an error
 * naming a message nobody asked to write. `tag.gpgsign=false` is now in
 * `orchestratorGitConfig` alongside the rest of the fence, and this is the case
 * that would go red if it were removed.
 */
describe('a target repo that signs its tags', () => {
  it('is tagged anyway, and the tag is still lightweight', async () => {
    const repo = toyRepo();
    git(repo.path, ['config', 'tag.gpgsign', 'true']);
    // A key that does not exist, so a signing attempt cannot succeed by luck.
    git(repo.path, ['config', 'user.signingkey', 'DOESNOTEXIST']);
    const base = git(repo.path, ['rev-parse', 'HEAD']).trim();

    // The control. `run` rather than the `git` helper: that helper passes the
    // test suite's own `-c tag.gpgsign=false`, so it would sail through and the
    // control would prove nothing. This is the raw command, and it must fail —
    // otherwise a green assertion below would only mean the fixture had no
    // effect.
    const unfenced = run(repo.path, 'git', ['-C', repo.path, 'tag', 'unfenced/1', base]);
    expect(unfenced.status, 'the signing fixture had no effect on plain git').not.toBe(0);
    expect(unfenced.stderr).toContain('no tag message');

    await new ShellGit({ repoRoot: repo.path }).tag('factory/sample/2026-09-02', base);

    expect(git(repo.path, ['tag']).trim()).toBe('factory/sample/2026-09-02');
    // `cat-file -t` on a lightweight tag reports the commit it names; an
    // annotated or signed one reports `tag`.
    expect(git(repo.path, ['cat-file', '-t', 'factory/sample/2026-09-02']).trim()).toBe('commit');
  }, 120_000);
});

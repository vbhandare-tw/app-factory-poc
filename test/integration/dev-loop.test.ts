/**
 * The developer → gates → review → QA loop (plan Phase 9).
 *
 * Real git, real worktrees, real subprocess gates, scripted agents that really
 * write files. The only thing faked is the model.
 *
 * ============================================================================
 * THE FAILURE THESE TESTS EXIST TO CATCH
 * ============================================================================
 * Gates that verify something other than what gets merged, with every test
 * green. Resolution A6 puts the orchestrator in charge of committing; spec §9
 * then says the gates run against the committed state, "so what is verified is
 * exactly what will be merged". That ordering is the entire guarantee, and it is
 * invisible to any test whose agent writes exactly the files its fixture names —
 * because then the dirty tree and the committed state are the same bytes and the
 * two orderings cannot be told apart.
 *
 * So the ordering is tested with a **deliberate divergence**: the scripted
 * Developer creates a file the commit cannot carry, in a path this repo ignores,
 * and the test's tree and its commit stop agreeing. `gates run against the
 * commit` below is the case; it goes red if the commit is moved after the gates
 * or removed, which is what the phase report's mutation records.
 *
 * ============================================================================
 * AND THE TRUST BOUNDARY
 * ============================================================================
 * Two cases assert on the **Runner**, not on the end state. A test that only
 * checks "the ticket did not reach qa" passes for an implementation that ran the
 * reviewer on a red ticket and then discarded its verdict — which burns money
 * and shows a red ticket to an agent that must never see one (plan Section E
 * item 3).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import type { GateResults } from '../../src/gates/results.js';
import type { GateConfig, GateRunner, GateRunOptions } from '../../src/gates/runner.js';
import { vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { Orchestrator } from '../../src/orchestrator/loop.js';
import type { TicketFrontmatter } from '../../src/domain/types.js';
import {
  commitAuthors,
  commitFiles,
  commitMessageOf,
  commitSubjects,
  developerPayload,
  devVault,
  FEATURE_ID,
  qaPayload,
  realCapability,
  reviewerPayload,
  scriptedAgents,
  SLUG,
  TICKET_ID,
} from '../helpers/devLoopFixtures.js';
import type { AgentStep, Capability, ScriptedRunner } from '../helpers/devLoopFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { readNoteFile } from '../helpers/orchestratorFixtures.js';
import type { Storage } from '../../src/vault/storage.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, git } from '../helpers/toyRepo.js';

// ---------------------------------------------------------------------------
// The change a scripted Developer makes.
// ---------------------------------------------------------------------------

/** A real, lint-clean, type-strippable module the toy repo's gates accept. */
const GOOD_MODULE = [
  'export function describeOperation(name: string): string {',
  "  return `operation: ${name}`;",
  '}',
  '',
].join('\n');

const GOOD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "import { describeOperation } from './describe.ts';",
  '',
  "test('describeOperation names the operation', () => {",
  "  assert.equal(describeOperation('add'), 'operation: add');",
  '});',
  '',
].join('\n');

/** The same module, plus a test that asserts something false. `npm test` exits 1. */
const RED_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "import { describeOperation } from './describe.ts';",
  '',
  "test('describeOperation names the operation', () => {",
  "  assert.equal(describeOperation('add'), 'operation: MULTIPLY');",
  '});',
  '',
].join('\n');

const PASSING_CHANGE: Readonly<Record<string, string>> = {
  'src/describe.ts': GOOD_MODULE,
  'src/describe.test.ts': GOOD_TEST,
};

const FAILING_CHANGE: Readonly<Record<string, string>> = {
  'src/describe.ts': GOOD_MODULE,
  'src/describe.test.ts': RED_TEST,
};

/**
 * The deliberate divergence.
 *
 * `dist/` is in the toy repo's `.gitignore`, so `dist/secret.txt` can never
 * reach a commit — but it sits happily in the working tree, and the test that
 * reads it passes there. Dirty tree: green. Committed state: the file does not
 * exist and `readFileSync` throws.
 */
const HIDDEN_DEPENDENCY_CHANGE: Readonly<Record<string, string>> = {
  'dist/secret.txt': 'forty-two\n',
  'src/hidden.test.ts': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    '',
    "test('reads the value from dist/', () => {",
    "  assert.equal(readFileSync('dist/secret.txt', 'utf8').trim(), 'forty-two');",
    '});',
    '',
  ].join('\n'),
};

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
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
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

async function openVault(options: Parameters<typeof devVault>[0] = {}): Promise<FactoryFixture> {
  vault = await devVault(options);
  worktreeRoots.add(worktreeRoot(vault.config.target_repo, vaultWorktreeName(vault.paths.root)));
  return vault;
}

/** Run `cycles` orchestrator cycles against the real capability. */
async function drive(
  runner: ScriptedRunner,
  cycles: number,
  capability: Capability = realCapability(vault, { events, now }),
): Promise<void> {
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
  });
  try {
    await instance.run({ maxCycles: cycles, sleep: async () => undefined });
  } finally {
    await instance.shutdown();
  }
}

function ticket(): { frontmatter: TicketFrontmatter; body: string } {
  const note = readNoteFile(vault.paths.ticketPath(SLUG, TICKET_ID));
  return { frontmatter: note.frontmatter as TicketFrontmatter, body: note.body };
}

function ticketBranch(): string {
  const branch = ticket().frontmatter.branch;
  if (branch === null) throw new Error('the ticket has no branch recorded');
  return branch;
}

function transitions(): string[] {
  return historyLines(ticket().body).map((line) => line.split(' | ')[1] ?? '');
}

/** The worktree the ticket was built in. */
function worktreePath(): string {
  const worktree = ticket().frontmatter.worktree;
  if (worktree === null) throw new Error('the ticket has no worktree recorded');
  return worktree;
}

function devStep(files: Readonly<Record<string, string>>, overrides: Record<string, unknown> = {}): AgentStep {
  return { write: files, structured: developerPayload(overrides) };
}

/**
 * A failing change that is **different on every attempt**.
 *
 * Rewriting byte-identical content on attempt 2 is not a change at all: the
 * commit would be empty and the bounce would come back as `no_changes` rather
 * than as a red gate. That is correct behaviour and the wrong experiment — a
 * multi-attempt gate test has to keep failing the *gates*, so each attempt
 * carries a distinct source file.
 */
function redStep(attempt: number): AgentStep {
  return devStep({
    'src/describe.ts': `${GOOD_MODULE}// attempt ${String(attempt)}\n`,
    'src/describe.test.ts': RED_TEST,
  });
}

function redSteps(count: number): AgentStep[] {
  return Array.from({ length: count }, (_entry, index) => redStep(index + 1));
}

/**
 * One cycle is one full pass down the ticket states.
 *
 * The loop re-scans between dispatches and keys what it has already handled on
 * `<id>@<stage>`, so a single cycle carries a ticket `ready → in_progress →
 * gates → code_review → qa → merge` — each stage once. A bounce lands the ticket
 * back in a stage the cycle has already used, so it waits for the next one. That
 * is why the counts below are small and exact: a cycle count that overshoots
 * silently spends extra attempts and turns "one bounce" into "parked".
 */
const ONE_PASS = 1;

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('developer → commit → green gates → approve → pass → merge', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5);

    expect(transitions()).toEqual([
      'ready → in_progress',
      'in_progress → gates',
      'gates → code_review',
      'code_review → qa',
      'qa → merge',
    ]);
    expect(ticket().frontmatter.status).toBe('merge');
    expect(ticket().frontmatter.attempts, 'a clean run charged an attempt').toBe(0);
    expect(runner.roles()).toEqual(['developer', 'code_reviewer', 'qa']);

    // Every gate is recorded, green, with its log on disk.
    const results = ticket().frontmatter.gate_results ?? {};
    for (const gate of ['tests', 'lint', 'build'] as const) {
      expect(results[gate]?.status, gate).toBe('pass');
      expect(results[gate]?.exit_code, gate).toBe(0);
      expect(existsSync(results[gate]?.log_path ?? ''), `${gate} log`).toBe(true);
    }
  }, 120_000);

  it('shows the reviewer the actual diff of the ticket branch', async () => {
    // The reviewer's recipe marks the diff **required**, and the agent cannot
    // read git itself — so if the orchestrator computed it against the wrong
    // ref, the reviewer would approve a change it was never shown and nothing
    // would go red.
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);

    const review = runner.calls.find((call) => call.role === 'code_reviewer');
    expect(review, 'the reviewer never ran').toBeDefined();
    expect(review?.prompt).toContain('the change under review');
    expect(review?.prompt).toContain('+++ b/src/describe.ts');
    expect(review?.prompt).toContain('describeOperation');
  }, 120_000);

  it('never writes to the base branch — Section E item 8', async () => {
    // Only Phase 11's code may move the base branch. Asserted here rather than
    // waited for, because this phase is the first that commits anything at all,
    // and a ticket branch cut from the wrong ref would show up as base moving.
    await openVault();
    const baseBefore = git(vault.repo.path, ['rev-parse', vault.repo.branch]).trim();

    await drive(
      scriptedAgents({
        developer: devStep(PASSING_CHANGE),
        code_reviewer: { structured: reviewerPayload('approve') },
        qa: { structured: qaPayload('pass') },
      }),
      ONE_PASS,
    );

    expect(ticket().frontmatter.status).toBe('merge');
    expect(
      git(vault.repo.path, ['rev-parse', vault.repo.branch]).trim(),
      'the dev loop moved the base branch',
    ).toBe(baseBefore);
    // The feature branch has not moved either — the ticket merge is Phase 10.
    expect(git(vault.repo.path, ['rev-parse', 'feature/sample']).trim()).toBe(baseBefore);
  }, 120_000);

  it('the commit carries the agent’s message and is authored by the orchestrator', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE, { commit_message: 'feat(calc): AGENT_WROTE_THIS' }),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5);

    const branch = ticketBranch();
    const subjects = commitSubjects(vault.repo.path, branch);
    expect(subjects[0], 'the agent’s proposed subject is not the commit subject').toBe(
      'feat(calc): AGENT_WROTE_THIS',
    );
    // Exactly one commit of ours on top of the toy repo's initial one.
    expect(subjects).toHaveLength(2);

    const message = commitMessageOf(vault.repo.path, branch);
    expect(message).toContain(`Ticket: ${TICKET_ID}`);
    expect(message).toContain('Committed-by: app-factory orchestrator');

    const [authorAndCommitter] = commitAuthors(vault.repo.path, branch);
    expect(authorAndCommitter).toBe('App Factory orchestrator|App Factory orchestrator');

    // And only the source files landed — not the build output the gates make.
    expect(commitFiles(vault.repo.path, branch)).toEqual(['src/describe.test.ts', 'src/describe.ts']);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// PROOF 1 — the gates run against the commit, not the dirty tree.
// ---------------------------------------------------------------------------

describe('the gates run against the committed state, not the dirty tree', () => {
  it('a change that only works uncommitted turns the gates red', async () => {
    // Constructed, not hoped for. `dist/` is gitignored, so `dist/secret.txt`
    // cannot be committed; the test that reads it therefore passes in the dirty
    // tree and fails against the commit. If the gates ever ran before the commit
    // — or if the uncommittable file were left lying about — this ticket would
    // sail through to code_review.
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(HIDDEN_DEPENDENCY_CHANGE, { files_changed: ['src/hidden.test.ts'] }),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);

    const state = ticket();
    expect(state.frontmatter.status, 'a change that cannot be committed passed the gates').toBe(
      'in_progress',
    );
    expect(state.frontmatter.gate_results?.tests?.status).toBe('fail');
    expect(state.frontmatter.attempts).toBe(1);

    // The commit carries the test file and not the ignored one.
    expect(commitFiles(vault.repo.path, ticketBranch())).toEqual(['src/hidden.test.ts']);

    // And the reviewer never ran.
    expect(runner.roles()).toEqual(['developer']);
  }, 120_000);

  it('still holds on attempt 2, when the ignored directory already exists', async () => {
    // The first version of this file only proved the guarantee for attempt 1,
    // and could not have failed for the reason that matters. `git status
    // --ignored` collapses a wholly-ignored directory to one entry (`dist/`), so
    // once `dist/` exists — which it does the moment the build gate has run once
    // — a *fresh* file inside it is indistinguishable from the directory that
    // was already there. The hidden-dependency escape this phase exists to close
    // then reopens on every attempt after the first.
    //
    // Sequence: attempt 1 goes green (the build gate writes `dist/`), the
    // reviewer bounces it, and attempt 2 tries to hide a file in the `dist/`
    // that attempt 1 left behind.
    await openVault();
    const runner = scriptedAgents({
      developer: [
        devStep(PASSING_CHANGE),
        devStep(HIDDEN_DEPENDENCY_CHANGE, { files_changed: ['src/hidden.test.ts'] }),
      ],
      code_reviewer: { structured: reviewerPayload('request_changes') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);
    // The build gate really did leave an ignored directory behind, or the rest
    // of this test is the attempt-1 case wearing a different hat.
    expect(
      existsSync(path.join(worktreePath(), 'dist')),
      'the build gate left no dist/, so this is not the attempt-2 shape',
    ).toBe(true);
    expect(ticket().frontmatter.status).toBe('in_progress');
    expect(ticket().frontmatter.attempts).toBe(1);

    await drive(runner, ONE_PASS);

    const state = ticket();
    expect(
      state.frontmatter.status,
      'a file hidden in a pre-existing ignored directory survived into the gate run',
    ).toBe('in_progress');
    expect(state.frontmatter.gate_results?.tests?.status).toBe('fail');
    expect(state.frontmatter.attempts).toBe(2);
    expect(commitFiles(vault.repo.path, ticketBranch())).toEqual(['src/hidden.test.ts']);
    expect(runner.roles()).not.toContain('qa');
  }, 180_000);

  it('the working tree the gates see is byte-identical to the commit', async () => {
    // The same guarantee asserted from the other side, and the one a reordering
    // breaks most directly: at the instant the first gate starts, `git status`
    // in the gate's own working directory is empty and HEAD is the commit the
    // ticket recorded.
    await openVault();
    const seen: { status: string; head: string; cwd: string }[] = [];
    const capability = realCapability(vault, { events, now });
    const watching: GateRunner = {
      run: async (cwd: string, gates: GateConfig, options: GateRunOptions): Promise<GateResults> => {
        seen.push({
          cwd,
          status: git(cwd, ['status', '--porcelain']),
          head: git(cwd, ['rev-parse', 'HEAD']).trim(),
        });
        return await capability.gates.run(cwd, gates, options);
      },
    };

    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5, { ...capability, gates: watching });

    expect(seen, 'the gates never ran').toHaveLength(1);
    const observed = seen[0];
    expect(observed?.status, 'the gates ran against a dirty tree').toBe('');
    expect(observed?.cwd).toBe(worktreePath());

    const head = git(vault.repo.path, ['rev-parse', ticketBranch()]).trim();
    expect(observed?.head, 'the gates did not run at the ticket branch’s tip').toBe(head);

    // …and that commit is the one the note reports.
    expect(sectionText(ticket().body, SECTION.implementationNotes)).toContain(head);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// PROOF 2 and 3 — the trust boundary.
// ---------------------------------------------------------------------------

describe('a red gate always bounces the ticket', () => {
  it('a Developer reporting outcome: ok with red tests is still bounced', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(FAILING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);

    const state = ticket();
    // The payload said `outcome: 'ok'` — that is what `developerPayload` returns
    // — and it advanced nothing past the gate run.
    expect(state.frontmatter.status).toBe('in_progress');
    expect(state.frontmatter.attempts).toBe(1);
    expect(state.frontmatter.gate_results?.tests?.status).toBe('fail');
    expect(state.frontmatter.gate_results?.lint?.status, 'lint ran after tests failed').toBe(
      'skipped',
    );
    expect(transitions()).toEqual(['ready → in_progress', 'in_progress → gates', 'gates → in_progress']);
  }, 120_000);

  it('never invokes the reviewer’s Runner while the gates are red', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: redSteps(3),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    // Driven to exhaustion on purpose: the reviewer must not appear on any of
    // the three attempts, not merely on the first.
    await drive(runner, 3);

    // Asserted on the Runner. "The ticket did not reach qa" would also hold for
    // an implementation that ran the reviewer and ignored what it said.
    expect(runner.roles()).not.toContain('code_reviewer');
    expect(runner.roles()).not.toContain('qa');
    expect(runner.roles().every((role) => role === 'developer')).toBe(true);
  }, 120_000);

  it('refuses to run the reviewer on a ticket a human moved into code_review with red gates', async () => {
    // The vault is a documented human editing surface (ADR-001), so a ticket can
    // arrive in `code_review` because somebody typed it there. The transition
    // guard cannot help — no transition happened. This is the second lock.
    await openVault();
    const first = scriptedAgents({ developer: devStep(FAILING_CHANGE) });
    await drive(first, ONE_PASS);
    expect(ticket().frontmatter.gate_results?.tests?.status).toBe('fail');

    // Hand-edit: red gates, but the status says code_review.
    const file = vault.paths.ticketPath(SLUG, TICKET_ID);
    const note = readNoteFile(file);
    await vault.storage.writeNote(file, {
      ...note,
      frontmatter: { ...note.frontmatter, status: 'code_review' },
    });

    const second = scriptedAgents({ code_reviewer: { structured: reviewerPayload('approve') } });
    await drive(second, 1);

    expect(second.roles(), 'the reviewer was shown a red ticket').toEqual([]);
    const parked = ticket();
    expect(parked.frontmatter.status).toBe('needs_human');
    expect(parked.frontmatter.pause_detail).toContain('gates are not green');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// PROOF 4 — an empty diff.
// ---------------------------------------------------------------------------

describe('a Developer that changes nothing', () => {
  it('produces no commit and a failed attempt, not a silent pass', async () => {
    await openVault();
    const before = commitSubjects(vault.repo.path, vault.repo.branch);
    const runner = scriptedAgents({
      // No `write`, no `remove`: the agent claims success and touched nothing.
      developer: { structured: developerPayload({ summary: 'Nothing needed changing.' }) },
      code_reviewer: { structured: reviewerPayload('approve') },
    });

    await drive(runner, ONE_PASS);

    const state = ticket();
    expect(state.frontmatter.status, 'an untouched ticket advanced').toBe('in_progress');
    expect(state.frontmatter.attempts).toBe(1);
    expect(state.frontmatter.gate_results, 'gates ran on a ticket with no commit').toBeNull();
    expect(runner.roles()).toEqual(['developer']);

    // No branch was written to. `branch` is only recorded by a successful
    // commit, so the ticket branch may not exist at all — check the base.
    expect(commitSubjects(vault.repo.path, vault.repo.branch)).toEqual(before);

    const refusals = events.ofType('commit_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toBe('no_changes');
    expect(refusals[0]?.detail).toContain('failed attempt');
  }, 120_000);

  it('a change that only produces ignored files counts as no change', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: { write: { 'dist/only-this.txt': 'nothing real\n' }, structured: developerPayload() },
    });

    await drive(runner, ONE_PASS);

    expect(ticket().frontmatter.status).toBe('in_progress');
    expect(ticket().frontmatter.attempts).toBe(1);
    expect(events.ofType('commit_refused')[0]?.detail).toContain('ignored by this repository');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Bounces from the two verdict roles.
// ---------------------------------------------------------------------------

describe('a reviewer asking for changes', () => {
  it('bounces to in_progress with the findings in Review Notes, and charges one attempt', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('request_changes') },
    });

    await drive(runner, ONE_PASS);

    const state = ticket();
    expect(state.frontmatter.status).toBe('in_progress');
    expect(state.frontmatter.attempts).toBe(1);
    expect(sectionText(state.body, SECTION.reviewNotes)).toContain(
      'describe() does not handle an unknown operation',
    );
    expect(transitions()).toContain('code_review → in_progress');
    // QA is downstream of the review and must not have run.
    expect(runner.roles()).not.toContain('qa');
  }, 120_000);

  it('the retry sees the findings, and a first attempt does not', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: [
        devStep(PASSING_CHANGE),
        devStep({ ...PASSING_CHANGE, 'src/describe.ts': `${GOOD_MODULE}// revised\n` }),
      ],
      code_reviewer: { structured: reviewerPayload('request_changes') },
    });

    await drive(runner, 2);

    const developerRuns = runner.calls.filter((call) => call.role === 'developer');
    expect(developerRuns.length, 'the developer did not run a second time').toBeGreaterThan(1);
    expect(developerRuns[0]?.prompt).not.toContain('does not handle an unknown operation');
    expect(
      developerRuns[1]?.prompt,
      'the retry could not see why it bounced',
    ).toContain('does not handle an unknown operation');
  }, 180_000);
});

describe('QA failing', () => {
  it('bounces to in_progress with the evidence in QA Notes', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('fail') },
    });

    await drive(runner, ONE_PASS);

    const state = ticket();
    expect(state.frontmatter.status).toBe('in_progress');
    expect(state.frontmatter.attempts).toBe(1);
    expect(sectionText(state.body, SECTION.qaNotes)).toContain('not ok 1 describe');
    expect(sectionText(state.body, SECTION.qaNotes)).toContain('npm test');
    expect(transitions()).toContain('qa → in_progress');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// PROOF 6 — attempt counting, and the limit.
// ---------------------------------------------------------------------------

describe('attempts', () => {
  it('a red gate charges exactly one attempt per developer-and-gate pair', async () => {
    await openVault();
    const runner = scriptedAgents({ developer: redSteps(2) });

    await drive(runner, ONE_PASS);
    expect(ticket().frontmatter.attempts).toBe(1);

    await drive(runner, ONE_PASS);
    expect(ticket().frontmatter.attempts, 'the second bounce charged more than one').toBe(2);
  }, 180_000);

  it('three red gate runs park the ticket with the logs linked', async () => {
    await openVault();
    const runner = scriptedAgents({ developer: redSteps(3) });

    await drive(runner, 3);

    const state = ticket();
    expect(state.frontmatter.attempts).toBe(3);
    expect(state.frontmatter.status).toBe('needs_human');
    expect(state.frontmatter.pause_reason).toBe('attempts_exhausted');
    expect(state.frontmatter.pause_detail).toContain('quality gate went red');
    expect(state.frontmatter.pause_detail).toContain('Gate log:');
    expect(state.frontmatter.pause_detail).toContain('Developer transcript:');
    // The gate log named in the detail is really on disk.
    const named = /Gate log: (\S+\.log)/.exec(state.frontmatter.pause_detail ?? '');
    expect(named?.[1]).toBeDefined();
    expect(existsSync(named?.[1] ?? '')).toBe(true);
  }, 240_000);

  it('at max_attempts the ticket pauses rather than retrying once more', async () => {
    await openVault({ maxAttempts: 2 });
    // Four steps offered; the fourth must never be reached.
    const runner = scriptedAgents({ developer: redSteps(4) });

    await drive(runner, 4);

    const state = ticket();
    expect(state.frontmatter.attempts, 'the off-by-one let a fourth run happen').toBe(2);
    expect(state.frontmatter.status).toBe('needs_human');
    // Two developer runs, not three: the run that would have been attempt 3
    // never happened.
    expect(runner.calls.filter((call) => call.role === 'developer')).toHaveLength(2);
  }, 240_000);

  it('a ticket-level max_attempts overrides the config default', async () => {
    await openVault({ config: { max_attempts: 5 }, maxAttempts: 1 });
    const runner = scriptedAgents({ developer: redSteps(3) });

    await drive(runner, 3);

    expect(ticket().frontmatter.attempts).toBe(1);
    expect(ticket().frontmatter.status).toBe('needs_human');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Retry context.
// ---------------------------------------------------------------------------

describe('the retry context', () => {
  it('carries the failing gate output into the next Developer run', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: [devStep(FAILING_CHANGE), devStep(PASSING_CHANGE)],
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 2);

    const developerRuns = runner.calls.filter((call) => call.role === 'developer');
    expect(developerRuns.length).toBeGreaterThan(1);
    const retry = developerRuns[1]?.prompt ?? '';
    expect(retry, 'the retry was not shown the gate output').toContain('gate_results');
    expect(retry).toContain('describeOperation names the operation');
    // The first run had nothing to be shown.
    expect(developerRuns[0]?.prompt).not.toContain('gate_results');

    // And the fixed change goes green from there.
    expect(ticket().frontmatter.status).toBe('merge');
    // `attempts` is a **lifetime** count: the successful run resets nothing, so
    // the bounce that came before it is still on the record (plan Section C).
    // Nothing else in the suite reads `attempts` after a success, so a writer
    // that zeroed it here would go unnoticed everywhere.
    expect(ticket().frontmatter.attempts, 'a successful run reset the attempt count').toBe(1);
    expect(historyLines(ticket().body).join('\n')).toContain('gates → in_progress');
  }, 240_000);

  it('escalates rather than re-running when the bounce notes are squeezed out', async () => {
    // The Phase 8 debt, closed: `buildContext` drops the lowest-priority
    // droppable document to fit, and the bounce notes sit at the bottom of the
    // developer's recipe. A retry that cannot see why it bounced is a burned
    // attempt, so the run is refused instead of paid for.
    await openVault({ config: { context_warn_chars: 3_000 } });
    const runner = scriptedAgents({ developer: redSteps(2) });

    await drive(runner, ONE_PASS);
    expect(ticket().frontmatter.status).toBe('in_progress');
    const runsBefore = runner.calls.length;

    await drive(runner, ONE_PASS);

    expect(runner.calls.length, 'a blind retry was paid for').toBe(runsBefore);
    const state = ticket();
    expect(state.frontmatter.status).toBe('needs_human');
    expect(state.frontmatter.pause_detail).toContain('gate_results');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Crash during a gate run.
// ---------------------------------------------------------------------------

describe('a crash during a gate run', () => {
  it('re-runs the gates rather than trusting a partial result', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });
    const capability = realCapability(vault, { events, now });

    let gateRuns = 0;
    const counting: GateRunner = {
      run: async (cwd: string, gates: GateConfig, options: GateRunOptions): Promise<GateResults> => {
        gateRuns += 1;
        return await capability.gates.run(cwd, gates, options);
      },
    };

    // Cycle one: run the developer, commit, run the gates, then die before
    // anything is written. `after_run` is the crash point the agent roles use
    // for exactly the same window.
    const first = await Orchestrator.start({
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
      gates: counting,
      hooks: {
        crash: (point) => {
          if (point === 'after_run' && gateRuns === 1) {
            throw new Error('simulated crash during the gate run');
          }
        },
      },
    });
    await first.run({ maxCycles: 1, sleep: async () => undefined });
    await first.shutdown();

    // Nothing about the gate run was written: the ticket is still at `gates`
    // with no results, which is what makes the re-run safe.
    expect(gateRuns).toBe(1);
    expect(ticket().frontmatter.status).toBe('gates');
    expect(ticket().frontmatter.gate_results).toBeNull();

    // The restart runs them again and the ticket advances on the fresh verdict.
    await drive(runner, 4, { ...capability, gates: counting });

    expect(gateRuns, 'the restart trusted the interrupted run').toBeGreaterThan(1);
    expect(ticket().frontmatter.status).toBe('merge');
    expect(ticket().frontmatter.gate_results?.tests?.status).toBe('pass');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Staging: what a commit may and may not sweep in.
// ---------------------------------------------------------------------------

describe('staging', () => {
  it('never commits what was already in the worktree before the agent ran', async () => {
    // The Phase 8 debt, met head on: a target repo that does not ignore its
    // install output reads every provisioned worktree as dirty. `git add -A`
    // there commits the whole dependency tree. The snapshot is what makes this
    // a property of the orchestrator rather than a requirement on the repo.
    await openVault({
      config: {
        setup_command:
          `node -e "const fs=require('fs');fs.mkdirSync('node_modules/left-pad',{recursive:true});` +
          `fs.writeFileSync('node_modules/left-pad/index.js','module.exports=1;')"`,
      },
    });
    // Remove the repo's .gitignore so `node_modules` is untracked, not ignored.
    rmSync(path.join(vault.repo.path, '.gitignore'));
    git(vault.repo.path, ['commit', '--quiet', '-am', 'chore: stop ignoring anything']);

    const runner = scriptedAgents({
      developer: devStep({ 'src/describe.ts': GOOD_MODULE }),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5);

    const files = commitFiles(vault.repo.path, ticketBranch());
    expect(files, 'the install output was swept into the commit').toEqual(['src/describe.ts']);
    expect(files.some((file) => file.startsWith('node_modules'))).toBe(false);
  }, 120_000);

  it('does not sweep in the dependency tree when the agent deletes .gitignore', async () => {
    // `.gitignore` is a plain worktree file and the fence has no reason to stop
    // an agent editing it. The moment it goes, every previously-ignored path
    // flips to *untracked* — and a staging filter that only asks "was this
    // dirty before?" no longer recognises `node_modules/` as something that was
    // already there. That is precisely the `git add -A` failure this module's
    // header claims the snapshot makes impossible.
    await openVault({
      config: {
        setup_command:
          `node -e "const fs=require('fs');fs.mkdirSync('node_modules/left-pad',{recursive:true});` +
          `fs.writeFileSync('node_modules/left-pad/index.js','module.exports=1;')"`,
      },
    });

    const runner = scriptedAgents({
      developer: {
        write: { 'src/describe.ts': GOOD_MODULE },
        remove: ['.gitignore'],
        structured: developerPayload(),
      },
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);

    const files = commitFiles(vault.repo.path, ticketBranch());
    expect(
      files.filter((file) => file.startsWith('node_modules')),
      'the dependency tree was committed once .gitignore stopped hiding it',
    ).toEqual([]);
    // The agent's real intent still lands: the deletion and the source file.
    expect(files).toEqual(['.gitignore', 'src/describe.ts']);
    // And the ticket still advances — the exclusion must not turn a legitimate
    // change into a refused commit.
    expect(ticket().frontmatter.status).toBe('merge');
  }, 120_000);

  it('stages a deletion as well as a write', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: {
        write: { 'src/describe.ts': GOOD_MODULE },
        // `calc.test.ts` goes; `calc.ts` stays, so the build gate still has
        // something to load and lint still has files to read.
        remove: ['src/calc.test.ts'],
        structured: developerPayload(),
      },
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5);

    expect(commitFiles(vault.repo.path, ticketBranch()).sort()).toEqual([
      'src/calc.test.ts',
      'src/describe.ts',
    ]);
    // And the deletion really is in the tree the gates saw.
    expect(existsSync(path.join(worktreePath(), 'src', 'calc.test.ts'))).toBe(false);
  }, 120_000);

  it('runs no repository hook when it commits', async () => {
    // `--no-verify` covers `pre-commit` and `commit-msg` and nothing else.
    // `prepare-commit-msg` and `post-commit` still run, and a husky-style repo
    // points `core.hooksPath` at a **tracked** directory — which an agent may
    // edit, and which linked worktrees share through `.git/config`. A hook there
    // executes unsandboxed, as the orchestrator, on this very commit: the same
    // escape spec §4.5 closes by denying `.git/hooks`, one level up.
    await openVault();
    const hooks = path.join(vault.repo.path, '.factory-hooks');
    mkdirSync(hooks, { recursive: true });
    const evidence = path.join(vault.repo.path, 'HOOK_RAN.txt');
    for (const name of ['prepare-commit-msg', 'post-commit', 'pre-commit', 'commit-msg']) {
      const hook = path.join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\necho "${name}" >> ${JSON.stringify(evidence)}\n`, 'utf8');
      chmodSync(hook, 0o755);
    }
    git(vault.repo.path, ['config', 'core.hooksPath', hooks]);

    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, ONE_PASS);

    // The commit happened…
    expect(ticket().frontmatter.status).toBe('merge');
    expect(commitSubjects(vault.repo.path, ticketBranch())).toHaveLength(2);
    // …and not one hook ran while it did.
    expect(
      existsSync(evidence) ? readFileSync(evidence, 'utf8') : '',
      'a repository hook executed unsandboxed as the orchestrator',
    ).toBe('');
  }, 120_000);

  it('records the ignored files it removed rather than deleting them silently', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: devStep({ ...PASSING_CHANGE, 'dist/leftover.txt': 'x\n' }),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });

    await drive(runner, 5);

    const created = events.ofType('commit_created');
    expect(created).toHaveLength(1);
    // Changed when the prune moved to git's per-file ignored view: it now names
    // the exact file it removed (`dist/leftover.txt`) instead of the directory
    // that contained it (`dist/`). Strictly more specific, and the reason the
    // attempt-2 escape above is detectable at all — a collapsed `dist/` is the
    // same string before and after the agent writes into it.
    expect(created[0]?.prunedIgnored).toContain('dist/leftover.txt');
    expect(sectionText(ticket().body, SECTION.implementationNotes)).toContain(
      'files this repository ignores',
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// One atomic write per transition — the Phase 9 paths.
// ---------------------------------------------------------------------------

describe('one atomic write per transition', () => {
  /**
   * The sibling of the block in `orchestrator-recovery.test.ts`, extended to the
   * three paths this phase adds.
   *
   * It lives here rather than there because these paths need a git handle, a
   * gate runner and a real worktree, none of which that file has. The rule is
   * the same one: body sections, frontmatter, the history line and the
   * transition are composed in memory and written **once**, so a crash leaves
   * the note either entirely before or entirely after — never half-advanced,
   * and never with a duplicated history line after the re-run.
   *
   * Gate results are the case most likely to break it. They are frontmatter
   * *and* a body section, and the obvious implementation writes them, then
   * transitions. That is two writes and a window in which a ticket says
   * `code_review` with no evidence of why.
   */
  function counting(fixture: FactoryFixture): { storage: Storage; writes: string[] } {
    const writes: string[] = [];
    const storage = new Proxy(fixture.storage, {
      get(target, property, receiver): unknown {
        const value = Reflect.get(target, property, receiver);
        if (property === 'writeNote' || property === 'appendSection' || property === 'appendHistory') {
          return async (...args: unknown[]): Promise<unknown> => {
            writes.push(`${String(property)} ${String(args[0])}`);
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return value;
      },
    }) as Storage;
    return { storage, writes };
  }

  async function driveCounting(runner: ScriptedRunner, cycles: number): Promise<string[]> {
    const { storage, writes } = counting(vault);
    const capability = realCapability(vault, { events, now });
    const instance = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage,
      runner,
      events,
      now,
      isAlive: () => true,
      workspace: capability.workspace,
      reconcile: capability.reconcile,
      git: capability.git,
      gates: capability.gates,
    });
    try {
      await instance.run({ maxCycles: cycles, sleep: async () => undefined });
    } finally {
      await instance.shutdown();
    }
    return writes;
  }

  /** Claim, the one transition write, release — per dispatch. A pause is its own release (Phase 8b). */
  function expectWritesPerDispatch(writes: readonly string[], dispatches: number, pauses = 0): void {
    const file = vault.paths.ticketPath(SLUG, TICKET_ID);
    const toTicket = writes.filter((entry) => entry.endsWith(file));
    expect(toTicket).toHaveLength(dispatches * 3 - pauses);
    expect(toTicket.every((entry) => entry.startsWith('writeNote'))).toBe(true);
    // Neither incremental helper can be part of an atomic transition: each is
    // its own read-modify-write.
    expect(writes.filter((entry) => entry.startsWith('appendSection'))).toEqual([]);
    expect(writes.filter((entry) => entry.startsWith('appendHistory'))).toEqual([]);
  }

  it('the whole green path writes the ticket note once per dispatch', async () => {
    await openVault();
    const writes = await driveCounting(
      scriptedAgents({
        developer: devStep(PASSING_CHANGE),
        code_reviewer: { structured: reviewerPayload('approve') },
        qa: { structured: qaPayload('pass') },
      }),
      ONE_PASS,
    );

    expect(ticket().frontmatter.status).toBe('merge');
    // ready→in_progress, developer, gates, code_review, qa: five dispatches.
    expectWritesPerDispatch(writes, 5);
    // The gate results really did ride along in the transition write.
    expect(ticket().frontmatter.gate_results?.tests?.status).toBe('pass');
    expect(sectionText(ticket().body, SECTION.gateResults)).toContain('All gates passed');
  }, 120_000);

  it('a red gate writes the results, the attempt and the bounce in one write', async () => {
    await openVault();
    const writes = await driveCounting(scriptedAgents({ developer: devStep(FAILING_CHANGE) }), ONE_PASS);

    // ready→in_progress, developer, gates(bounce): three dispatches.
    expectWritesPerDispatch(writes, 3);
    const state = ticket();
    expect(state.frontmatter.attempts).toBe(1);
    expect(state.frontmatter.gate_results?.tests?.status).toBe('fail');
    expect(sectionText(state.body, SECTION.gateResults)).toContain('AssertionError');
  }, 120_000);

  it('a bounce that exhausts the attempt budget writes once too', async () => {
    await openVault({ maxAttempts: 1 });
    const writes = await driveCounting(scriptedAgents({ developer: devStep(FAILING_CHANGE) }), ONE_PASS);

    expectWritesPerDispatch(writes, 3, 1);
    expect(ticket().frontmatter.status).toBe('needs_human');
    expect(ticket().frontmatter.pause_reason).toBe('attempts_exhausted');
    // The pause carries the evidence as well as the reason.
    expect(sectionText(ticket().body, SECTION.gateResults)).toContain('exit 1');
  }, 120_000);

  it('a refused commit writes once', async () => {
    await openVault();
    const writes = await driveCounting(
      scriptedAgents({ developer: { structured: developerPayload() } }),
      ONE_PASS,
    );

    // ready→in_progress, developer(refused): two dispatches.
    expectWritesPerDispatch(writes, 2);
    expect(ticket().frontmatter.attempts).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The ticket loop is off without the capability.
// ---------------------------------------------------------------------------

describe('an orchestrator with no git handle', () => {
  it('leaves a ready ticket where it is instead of advancing it into a loop it cannot finish', async () => {
    await openVault();
    const runner = scriptedAgents({ developer: devStep(PASSING_CHANGE) });

    const instance = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage: vault.storage,
      runner,
      events,
      now,
      isAlive: () => true,
    });
    await instance.run({ maxCycles: 2, sleep: async () => undefined });
    await instance.shutdown();

    expect(ticket().frontmatter.status).toBe('ready');
    expect(runner.calls).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A regression the phase's own writers could break.
// ---------------------------------------------------------------------------

describe('the ticket note itself', () => {
  it('keeps a human’s own frontmatter key across the whole loop', async () => {
    await openVault();
    const file = vault.paths.ticketPath(SLUG, TICKET_ID);
    const before = readNoteFile(file);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('type: "ticket"', 'type: "ticket"\nowner: "vishal"'),
      'utf8',
    );
    expect(readNoteFile(file).frontmatter).toHaveProperty('owner', 'vishal');
    expect(before.frontmatter).not.toHaveProperty('owner');

    const runner = scriptedAgents({
      developer: devStep(PASSING_CHANGE),
      code_reviewer: { structured: reviewerPayload('approve') },
      qa: { structured: qaPayload('pass') },
    });
    await drive(runner, 5);

    expect(ticket().frontmatter.status).toBe('merge');
    expect(readNoteFile(file).frontmatter, 'gate results rebuilt the frontmatter').toHaveProperty(
      'owner',
      'vishal',
    );
  }, 120_000);

  it('records the feature’s cost and the ticket’s own', async () => {
    await openVault();
    const runner = scriptedAgents({
      developer: { write: PASSING_CHANGE, structured: developerPayload(), costUsd: 0.4 },
      code_reviewer: { structured: reviewerPayload('approve'), costUsd: 0.2 },
      qa: { structured: qaPayload('pass'), costUsd: 0.1 },
    });

    await drive(runner, 5);

    expect(ticket().frontmatter.cost_usd).toBeCloseTo(0.7, 6);
    expect(readNoteFile(vault.paths.featureNote(SLUG)).frontmatter.id).toBe(FEATURE_ID);
  }, 120_000);
});

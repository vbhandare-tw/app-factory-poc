/**
 * The feature close's decisions (plan Phase 11, `src/orchestrator/featureClose.ts`).
 *
 * ============================================================================
 * WHY A MOCKED `Git` AND A REAL VAULT
 * ============================================================================
 * The same split `merge.test.ts` uses, for the same reasons. Every case here is
 * about a **sequence of git commands** and about what the note says afterwards,
 * and half of them are about a sequence that only happens when something has
 * already gone wrong: a tag that fails after a merge that succeeded, a tag name
 * that already exists, a checkout that refuses. Real git can be made to
 * conflict; it cannot easily be made to fail `git tag` on demand.
 *
 * The mock also lets a test assert a command was **asked for**, and — more
 * important here — that one was **not**. `git reset --hard` on a base branch is
 * the single most destructive thing this system could do, and "the base branch
 * ended up at the right SHA" passes for an implementation that reverted and
 * re-merged. The call log is the evidence.
 *
 * The vault is real because the decisions are only half the phase: what a human
 * finds in `NEEDS_HUMAN.md` after a failed close, and whether a feature can be
 * recorded `done` without a merge, are properties of the note.
 *
 * ============================================================================
 * THE CASE THIS FILE EXISTS FOR
 * ============================================================================
 * `a feature is never recorded as delivered without a delivery`. This is the
 * only code in the system that writes the base branch (plan Section E item 8),
 * `done` is terminal, and until this phase the transition into it checked
 * nothing at all. Every case under that heading refuses.
 */
import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import { sectionText } from '../../../src/domain/markdown.js';
import { GATE_NAMES } from '../../../src/domain/states.js';
import { canTransition, historyLines } from '../../../src/domain/transitions.js';
import type { FeatureFrontmatter } from '../../../src/domain/types.js';
import type { GateResults } from '../../../src/gates/results.js';
import type { GateConfig, GateRunner, GateRunOptions } from '../../../src/gates/runner.js';
import type { Git, MergeResult, StatusEntry } from '../../../src/git/git.js';
import { featureTagName } from '../../../src/git/paths.js';
import { MemoryEventLog } from '../../../src/log/events.js';
import { ActionError, approve, reject } from '../../../src/orchestrator/actions.js';
import type { ActionContext } from '../../../src/orchestrator/actions.js';
import { dispatchItem } from '../../../src/orchestrator/dispatch.js';
import type {
  Actionable,
  DispatchDeps,
  FeatureVerifyRequest,
  Workspace,
} from '../../../src/orchestrator/dispatchTypes.js';
import {
  canCloseFeature,
  closeFeature,
  mergeAndFinish,
  mergeCommitOf,
  renderApprovalSummary,
} from '../../../src/orchestrator/featureClose.js';
import type { CloseFeatureInput } from '../../../src/orchestrator/featureClose.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import { factoryVault, readNoteFile } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const SLUG = 'sample';
const FEATURE_ID = 'FEAT-SAMPLE';
const FEATURE_BRANCH = 'feature/sample';
const BASE = 'main';
const BASE_BEFORE = 'a'.repeat(40);
const BASE_MERGED = 'b'.repeat(40);
const FEATURE_TIP = 'c'.repeat(40);
const NOW = '2026-09-02T10:00:00.000Z';
/**
 * When the parked fixtures below were put in front of a human.
 *
 * Deliberately a **different day** from `NOW`, because the tag date comes from
 * `paused_at` rather than from the approver's clock — that is the whole fix for
 * the promised-name mismatch, and a fixture where the two coincided would not
 * notice it being undone.
 */
const PAUSED_AT = '2026-09-01T09:30:00Z';

/** The tag an approval produces: derived from `paused_at`. */
const TAG = 'factory/sample/2026-09-01';

/**
 * The tag an **auto-close** produces: derived from the dispatch clock, because
 * that path has no pause and no window between the summary and the tag.
 */
const TAG_AUTO = 'factory/sample/2026-09-02';
const T001_MERGE = '1111111111111111111111111111111111111111';
const T002_MERGE = '2222222222222222222222222222222222222222';

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
   * The merge succeeds and leaves the base branch where it was — git's
   * "Already up to date." A re-approve after a close that got as far as the
   * merge and no further looks exactly like this.
   */
  readonly mergeIsNoOp?: boolean;
  /** `mergeNoFf` raises, as `ShellGit` does on a refused `git checkout`. */
  readonly mergeThrows?: string;
  /** `git tag` fails. The merge is already on the base branch by then. */
  readonly tagThrows?: string;
  /** Tags already in the repo, name → commit. */
  readonly existingTags?: Readonly<Record<string, string>>;
  readonly mainStatus?: readonly StatusEntry[];
  readonly branches?: readonly string[];
  readonly startingBranch?: string | null;
  readonly checkoutThrows?: boolean;
}

interface FakeGit extends Git {
  readonly calls: Call[];
  names(): string[];
  baseSha(): string;
  tags(): Record<string, string>;
}

function fakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: Call[] = [];
  const branches = new Set(options.branches ?? [BASE, FEATURE_BRANCH]);
  const tags = new Map<string, string>(Object.entries(options.existingTags ?? {}));
  let base = BASE_BEFORE;
  let head: string | null = options.startingBranch === undefined ? BASE : options.startingBranch;

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const unsupported = (name: string) => (): never => {
    throw new Error(`fakeGit does not implement ${name}`);
  };

  return {
    calls,
    names: (): string[] => calls.map((call) => call.name),
    baseSha: (): string => base,
    tags: (): Record<string, string> => Object.fromEntries(tags),
    repoRoot: '/repo',

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
      if (ref.startsWith('refs/tags/')) {
        return Promise.resolve(tags.get(ref.slice('refs/tags/'.length)) ?? null);
      }
      if (ref === BASE) return Promise.resolve(base);
      if (ref === FEATURE_BRANCH) return Promise.resolve(FEATURE_TIP);
      if (ref === 'HEAD') return Promise.resolve(head === null ? 'd'.repeat(40) : base);
      return Promise.resolve(null);
    },
    currentBranch: (worktree?: string): Promise<string | null> => {
      record('currentBranch', worktree);
      return Promise.resolve(head);
    },
    mergeNoFf: (into: string, from: string): Promise<MergeResult> => {
      record('mergeNoFf', into, from);
      if (options.mergeThrows !== undefined) {
        return Promise.reject(new Error(options.mergeThrows));
      }
      head = into;
      const result = options.merge ?? { ok: true as const };
      if (result.ok && options.mergeIsNoOp !== true) base = BASE_MERGED;
      return Promise.resolve(result);
    },
    tag: (name: string, ref: string): Promise<void> => {
      record('tag', name, ref);
      if (options.tagThrows !== undefined) return Promise.reject(new Error(options.tagThrows));
      tags.set(name, ref);
      return Promise.resolve();
    },
    checkout: (target: string, checkoutOptions?: { readonly detach?: boolean }): Promise<void> => {
      record('checkout', target, checkoutOptions?.detach === true);
      if (options.checkoutThrows === true) {
        return Promise.reject(new Error('git checkout refused'));
      }
      head = checkoutOptions?.detach === true ? null : target;
      return Promise.resolve();
    },

    /**
     * Recorded **and then thrown**, rather than simply unimplemented.
     *
     * The feature close must never rewind the base branch (see the module
     * header). Recording first means a test can name the command in a failure
     * message; throwing means an implementation that reached for it fails here
     * rather than quietly succeeding at the most destructive thing in the
     * system.
     */
    resetBranch: (branch: string, sha: string): Promise<void> => {
      record('resetBranch', branch, sha);
      return Promise.reject(
        new Error(`the feature close must never rewind a branch, and it asked to move ${branch}`),
      );
    },

    createWorktree: unsupported('createWorktree'),
    createDetachedWorktree: unsupported('createDetachedWorktree'),
    removeWorktree: unsupported('removeWorktree'),
    listWorktrees: unsupported('listWorktrees'),
    pruneWorktrees: unsupported('pruneWorktrees'),
    diff: unsupported('diff'),
    ensureBranch: unsupported('ensureBranch'),
    status: unsupported('status'),
    isValidBranchName: unsupported('isValidBranchName'),
    add: unsupported('add'),
    stagedPaths: unsupported('stagedPaths'),
    commit: unsupported('commit'),
    deleteBranch: unsupported('deleteBranch'),
  };
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
      const cwd = `/scratch/${request.label ?? request.ticketId}`;
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

// ---------------------------------------------------------------------------
// The vault.
// ---------------------------------------------------------------------------

let vault: FactoryFixture | undefined;

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

interface VaultOptions {
  readonly finalAcceptance?: boolean;
  /** The feature's state. `awaiting_feature_close` unless a case says otherwise. */
  readonly status?: FeatureFrontmatter['status'];
  readonly featureBranch?: string | null;
  readonly pause?: Partial<FeatureFrontmatter>;
  /** Whether T002's history records the SHA it merged as. */
  readonly secondTicketRecordsMerge?: boolean;
}

/** A vault whose feature has two done tickets, each with a real merge history. */
async function openVault(options: VaultOptions = {}): Promise<FactoryFixture> {
  const fixture = factoryVault({
    config: {
      base_branch: BASE,
      human_checkpoints: {
        after_pm_refinement: true,
        after_ticket_breakdown: true,
        final_acceptance: options.finalAcceptance ?? true,
      },
    },
  });
  vault = fixture;

  mkdirSync(fixture.paths.ticketsDir(SLUG), { recursive: true });

  await fixture.storage.writeNote(
    fixture.paths.featureNote(SLUG),
    makeFeature(
      {
        id: FEATURE_ID,
        slug: SLUG,
        title: 'Add a calculator',
        status: options.status ?? 'awaiting_feature_close',
        feature_branch: options.featureBranch === undefined ? FEATURE_BRANCH : options.featureBranch,
        ...(options.pause ?? {}),
      },
      '## History\n\n- 2026-09-01T09:00:00Z | in_development → awaiting_feature_close | orchestrator\n',
    ),
  );

  await fixture.storage.writeNote(
    fixture.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T001'),
    doneTicket('FEAT-SAMPLE-T001', 'Add a describe helper', 1, T001_MERGE),
  );
  await fixture.storage.writeNote(
    fixture.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T002'),
    doneTicket(
      'FEAT-SAMPLE-T002',
      'Add an explain helper',
      2,
      options.secondTicketRecordsMerge === false ? null : T002_MERGE,
    ),
  );

  return fixture;
}

/**
 * A `done` ticket whose `## History` reads exactly as the ticket merge writes
 * it (`runMerge` in `dispatch.ts`).
 *
 * The wording matters: `mergeCommitOf` reads the merge SHA back out of this
 * line, because the ticket branch is deleted on success and there is nothing
 * left to `rev-parse`. A fixture that invented a different shape would make the
 * summary test prove something about the fixture.
 */
function doneTicket(
  id: string,
  title: string,
  ordinal: number,
  mergeSha: string | null,
): ReturnType<typeof makeTicket> {
  const merged =
    mergeSha === null
      ? `- 2026-09-01T12:00:00Z | merge → done | orchestrator\n`
      : `- 2026-09-01T12:00:00Z | merge → done | orchestrator | merged ${mergeSha.slice(0, 8)} into ${FEATURE_BRANCH}, feat/sample/t00${String(ordinal)} deleted\n`;

  return makeTicket(
    { id, feature: SLUG, title, ordinal, status: 'done' },
    ['## History', '', '- 2026-09-01T10:00:00Z | qa → merge | qa', merged].join('\n'),
  );
}

function feature(): FeatureFrontmatter {
  const fixture = requireVault();
  return readNoteFile(fixture.paths.featureNote(SLUG)).frontmatter as FeatureFrontmatter;
}

function featureBody(): string {
  const fixture = requireVault();
  return readNoteFile(fixture.paths.featureNote(SLUG)).body;
}

function featureTransitions(): string[] {
  return historyLines(featureBody()).map((line) => line.split(' | ')[1] ?? '');
}

function requireVault(): FactoryFixture {
  if (vault === undefined) throw new Error('no vault fixture is open');
  return vault;
}

/**
 * The feature as an `Actionable`, re-derived from **disk**.
 *
 * `dispatchItem` takes `item.stage` from the caller and only refreshes the
 * *note* from its claim read-back, so a stale `Actionable` would keep telling it
 * the feature is still at `awaiting_feature_close`. The loop recomputes the
 * actionable set between dispatches; a multi-pass test has to do the same or it
 * is driving a state the pipeline had already left.
 */
function currentItem(fixture: FactoryFixture): Actionable {
  const note = readNoteFile(fixture.paths.featureNote(SLUG));
  return {
    kind: 'feature',
    id: FEATURE_ID,
    path: fixture.paths.featureNote(SLUG),
    slug: SLUG,
    note: note as never,
    stage: (note.frontmatter as FeatureFrontmatter).status,
  };
}

// ---------------------------------------------------------------------------
// Driving the dispatcher and the actions.
// ---------------------------------------------------------------------------

interface Harness {
  readonly git: FakeGit;
  readonly gates: FakeGates;
  readonly workspace: FakeWorkspace;
  readonly events: MemoryEventLog;
  readonly deps: DispatchDeps;
  readonly actions: ActionContext;
  readonly item: Actionable;
}

/**
 * A `Runner` that throws if it is ever called.
 *
 * ADR-004, asserted structurally rather than by inspection: no agent goes near
 * the feature close, and `awaiting_feature_close` has no row in
 * `FEATURE_STATE_ROLES` precisely so that none can. A runner that returned a
 * plausible payload would let a dispatcher that ran one pass every other case
 * in this file.
 */
function noRunner(): DispatchDeps['runner'] {
  return {
    run: (): never => {
      throw new Error('the feature close invoked an agent (ADR-004)');
    },
  };
}

function harness(
  fixture: FactoryFixture,
  options: FakeGitOptions & { readonly gates?: GateResults | Error } = {},
): Harness {
  const git = fakeGit(options);
  const gates = fakeGates(options.gates ?? results({}));
  const workspace = fakeWorkspace();
  const events = new MemoryEventLog(() => NOW);

  const deps: DispatchDeps = {
    paths: fixture.paths,
    config: fixture.config,
    storage: fixture.storage,
    runner: noRunner(),
    events,
    now: () => NOW,
    ownerId: 'test-owner',
    nextCounter: () => 1,
    git,
    gates,
    featureWorkspace: workspace.provide,
  };

  return {
    git,
    gates,
    workspace,
    events,
    deps,
    actions: {
      paths: fixture.paths,
      storage: fixture.storage,
      config: fixture.config,
      now: () => NOW,
      events,
      git,
    },
    item: {
      kind: 'feature',
      id: FEATURE_ID,
      path: fixture.paths.featureNote(SLUG),
      slug: SLUG,
      note: readNoteFile(fixture.paths.featureNote(SLUG)) as never,
      stage: 'awaiting_feature_close',
    },
  };
}

function closeInput(
  fixture: FactoryFixture,
  git: Git,
  overrides: Partial<CloseFeatureInput> = {},
): CloseFeatureInput {
  return {
    git,
    config: fixture.config,
    featureId: FEATURE_ID,
    featureSlug: SLUG,
    featureBranch: FEATURE_BRANCH,
    tagName: TAG,
    ...overrides,
  };
}

// ===========================================================================
// Capability.
// ===========================================================================

describe('canCloseFeature', () => {
  it('needs git, a gate runner and somewhere to run the feature-branch gates', () => {
    const git = fakeGit();
    const gates = fakeGates(results({}));
    const workspace = fakeWorkspace();

    expect(canCloseFeature({ git, gates, featureWorkspace: workspace.provide })).toBe(true);
    expect(canCloseFeature({ gates, featureWorkspace: workspace.provide })).toBe(false);
    expect(canCloseFeature({ git, featureWorkspace: workspace.provide })).toBe(false);
    // The one that matters: without it the gates would have to run in the
    // operator's own checkout, and a verdict from there is a statement about
    // their machine rather than about the commit a human is approving.
    expect(canCloseFeature({ git, gates })).toBe(false);
  });

  it('leaves the feature waiting rather than closing it without the capability', async () => {
    const fixture = await openVault();
    const h = harness(fixture);
    const { featureWorkspace: _dropped, ...withoutWorkspace } = h.deps;

    const outcome = await dispatchItem(withoutWorkspace, h.item, { tickets: [] });

    expect(outcome.to).toBeNull();
    expect(outcome.paused).toBe(false);
    expect(feature().status).toBe('awaiting_feature_close');
    expect(h.git.names(), 'the base branch was touched with no way to verify it').not.toContain(
      'mergeNoFf',
    );
  });
});

// ===========================================================================
// The gates on the feature branch, and the checkpoint.
// ===========================================================================

describe('the feature-branch gates', () => {
  it('run in a throwaway tree cut from the feature branch tip, never the main checkout', async () => {
    const fixture = await openVault();
    const h = harness(fixture);

    await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(h.gates.cwds, 'the gates did not run').toHaveLength(1);
    expect(h.workspace.requests[0]?.ref, 'the gates ran against something other than the tip').toBe(
      FEATURE_TIP,
    );
    expect(h.workspace.requests[0]?.branch).toBe(FEATURE_BRANCH);
    expect(h.gates.cwds[0]).not.toBe(h.git.repoRoot);
    // And the throwaway tree is destroyed afterwards.
    expect(h.workspace.disposed).toEqual([h.gates.cwds[0]]);
  });

  it('are labelled as a close rather than as a merge verification', async () => {
    // The directory outlives nothing, but it exists while the gates run and a
    // human who finds `FEAT-SAMPLE-merge-verify` there before anything has been
    // merged is being told something untrue.
    const fixture = await openVault();
    const h = harness(fixture);

    await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(h.workspace.requests[0]?.label).toBe(`${FEATURE_ID}-close`);
  });

  /**
   * ==========================================================================
   * A RED BRANCH IS NEVER OFFERED FOR APPROVAL
   * ==========================================================================
   * The checkpoint's whole value is that a human approves something already
   * verified. Offering a red branch asks them to authorise a base-branch merge
   * on evidence that says not to — and their answer would then be the only
   * thing between a red branch and the base branch.
   */
  it('block the checkpoint from ever being offered when they go red', async () => {
    const fixture = await openVault();
    const h = harness(fixture, { gates: results({ tests: 'fail' }) });

    const outcome = await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(outcome.to).toBe('needs_human');
    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.pause_reason, 'a red branch was offered as a checkpoint').not.toBe('checkpoint');
    expect(front.pause_reason).toBe('escalation');
    // Approving must send it back to be verified again, not to `done`.
    expect(front.resume_to, 'approving a red branch would have merged it').toBe(
      'awaiting_feature_close',
    );
    expect(front.reject_to).toBe('in_development');
    expect(front.pause_detail).toContain('tests');
    // Nothing was merged and nothing was tagged.
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('tag');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(front.tag).toBeNull();
    // The evidence is in the note, not only in the log.
    expect(sectionText(featureBody(), SECTION.gateResults)).toContain('Feature-branch gates');
  });

  it('block it when the gate run itself throws, and record a run that never happened', async () => {
    const fixture = await openVault();
    const h = harness(fixture, { gates: new Error('the gate runner exploded') });

    await dispatchItem(h.deps, h.item, { tickets: [] });

    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.pause_reason).toBe('escalation');
    expect(front.pause_detail).toContain('exploded');
    expect(front.resume_to).toBe('awaiting_feature_close');
    expect(h.git.names()).not.toContain('mergeNoFf');
    // `skipped`, never `pass` — a run that did not happen must not read green.
    expect(sectionText(featureBody(), SECTION.gateResults)).toContain('skipped');
  });

  it('are not even attempted when the feature branch is the base branch', async () => {
    // `feature_branch` comes from human-editable frontmatter (ADR-001).
    const fixture = await openVault({ featureBranch: BASE });
    const h = harness(fixture);

    await dispatchItem(h.deps, h.item, { tickets: [] });

    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.pause_detail).toContain('base branch');
    expect(h.gates.cwds, 'a base-branch checkout was gated as if it were a feature').toHaveLength(0);
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('are not attempted when the feature branch does not resolve to a commit', async () => {
    const fixture = await openVault({ featureBranch: 'feature/nowhere' });
    const h = harness(fixture, { branches: [BASE, 'feature/nowhere'] });

    await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(feature().status).toBe('needs_human');
    expect(feature().pause_detail).toContain('feature/nowhere');
    expect(h.gates.cwds).toHaveLength(0);
  });
});

describe('the final_acceptance checkpoint', () => {
  it('parks the feature with an approval summary listing every ticket and its merge commit', async () => {
    const fixture = await openVault();
    const h = harness(fixture);
    const tickets = [
      readNoteFile(fixture.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T001')) as never,
      readNoteFile(fixture.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T002')) as never,
    ];

    const outcome = await dispatchItem(h.deps, h.item, { tickets });

    expect(outcome.to).toBe('needs_human');
    expect(outcome.paused).toBe(true);
    const front = feature();
    expect(front.pause_reason).toBe('checkpoint');
    expect(front.resume_to).toBe('done');
    expect(front.reject_to).toBe('in_development');

    const summary = sectionText(featureBody(), SECTION.notes);
    // Every ticket, by id and title.
    expect(summary).toContain('FEAT-SAMPLE-T001');
    expect(summary).toContain('Add a describe helper');
    expect(summary).toContain('FEAT-SAMPLE-T002');
    expect(summary).toContain('Add an explain helper');
    // And the commit each one merged as — the number a human would otherwise
    // have to go and find in git.
    expect(summary).toContain(T001_MERGE.slice(0, 8));
    expect(summary).toContain(T002_MERGE.slice(0, 8));
    // Plus what approving will actually do.
    expect(summary).toContain(FEATURE_BRANCH);
    expect(summary).toContain(BASE);
    expect(summary).toContain(TAG_AUTO);
    expect(summary).toContain(FEATURE_TIP);

    // Nothing has been merged or tagged yet: the checkpoint is a question.
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('tag');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
  });

  it('says so plainly when a ticket did not record its merge commit', async () => {
    // Better than inventing a plausible SHA: the whole point of the number is
    // that a human can check it.
    const fixture = await openVault({ secondTicketRecordsMerge: false });
    const h = harness(fixture);
    const tickets = [
      readNoteFile(fixture.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T002')) as never,
    ];

    await dispatchItem(h.deps, h.item, { tickets });

    const summary = sectionText(featureBody(), SECTION.notes);
    expect(summary).toContain('FEAT-SAMPLE-T002');
    expect(summary).toContain('merge commit not recorded');
  });

  /**
   * ==========================================================================
   * AN ENABLED CHECKPOINT IS NOT DECORATIVE, AND THE ACTOR LIST IS NOT WHY
   * ==========================================================================
   * Phase 11 permitted the **orchestrator** on `awaiting_feature_close → done`
   * so that an auto-close records a truthful actor. Actor lists are not
   * conditional on config, so that widened the rule for every run — including
   * the ones where `final_acceptance` is on. And the guard does not close the
   * gap either: the guard demands a clean base merge and a tag, and the close is
   * the code that *produces* both, so by the time it asked it could answer.
   *
   * What holds is an **ordering** property: the checkpoint decision is made
   * before any base-branch write, so for a feature that should be waiting on a
   * person the two facts the guard needs are never produced at all. Backed by a
   * second lock — `mergeAndFinish` re-reads the config switch and refuses — for
   * the route a future caller would otherwise open.
   *
   * Asserted on **dispatches driven**, not on the end state: an implementation
   * that closed the feature on the fourth pass would satisfy a single-shot
   * assertion. The item is re-derived from disk before each pass, which is what
   * the loop itself does.
   */
  it('is never advanced past by any number of dispatches while it is enabled', async () => {
    const fixture = await openVault();
    const h = harness(fixture);

    const PASSES = 6;
    const outcomes = [];
    for (let pass = 0; pass < PASSES; pass += 1) {
      outcomes.push(await dispatchItem(h.deps, currentItem(fixture), { tickets: [] }));
    }

    // The passes really happened, and each did something checkable.
    // `toHaveLength(PASSES)` alone was a tautology — a loop of N iterations
    // always produces N entries — so what is asserted is the *shape* of each:
    // the first reaches the checkpoint, and every later one is a no-op, which
    // is what "the feature is not being acted on any more" actually looks like.
    expect(outcomes[0]?.to, 'the first pass did not reach the checkpoint').toBe('needs_human');
    expect(outcomes[0]?.paused).toBe(true);
    expect(
      outcomes.slice(1).map((outcome) => outcome.to),
      'a later pass acted on a feature that was parked for a human',
    ).toEqual(Array.from({ length: PASSES - 1 }, () => null));

    // And after all of them the feature is still waiting for a person.
    const front = feature();
    expect(front.status, `${String(PASSES)} dispatches advanced the feature past the checkpoint`).toBe(
      'needs_human',
    );
    expect(front.pause_reason).toBe('checkpoint');
    expect(front.resume_to).toBe('done');
    expect(front.tag, 'a feature was tagged with nobody having approved it').toBeNull();

    // Nothing was merged and nothing was tagged, on any pass.
    expect(h.git.names(), 'the base branch was written without an approval').not.toContain(
      'mergeNoFf',
    );
    expect(h.git.names()).not.toContain('tag');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(h.git.tags()).toEqual({});
    expect(h.events.ofType('feature_close_started')).toHaveLength(0);
    expect(h.events.ofType('feature_closed')).toHaveLength(0);
    expect(h.events.ofType('feature_tagged')).toHaveLength(0);

    // The control: the machinery was capable the whole time. Only the
    // checkpoint held it, and one approval releases it.
    await approve(h.actions, FEATURE_ID);
    expect(feature().status).toBe('done');
    expect(h.git.baseSha()).toBe(BASE_MERGED);
  });

  it('cannot be resolved by the orchestrator once it has parked', async () => {
    // The table-level half, at the point it applies. The pause is a feature
    // waiting for a person; `needs_human → done` stays human-only, so widening
    // the auto-close route cannot leak into resolving somebody else's approval.
    const fixture = await openVault();
    const h = harness(fixture);
    await dispatchItem(h.deps, h.item, { tickets: [] });
    expect(feature().status).toBe('needs_human');

    const parked = readNoteFile(fixture.paths.featureNote(SLUG)) as never;
    expect(
      canTransition(parked, 'done', 'orchestrator', {
        baseMergeClean: true,
        featureTag: TAG,
      }).ok,
      'the orchestrator could resolve a human’s final-acceptance pause',
    ).toBe(false);
  });

  it('invokes no agent (ADR-004)', async () => {
    // Asserted on the Runner, which throws. A dispatcher that ran an agent and
    // then closed deterministically anyway would satisfy every state assertion
    // in this file.
    const fixture = await openVault();
    const h = harness(fixture);

    await expect(dispatchItem(h.deps, h.item, { tickets: [] })).resolves.toMatchObject({
      ran: null,
    });
  });
});

// ===========================================================================
// THE CASE THIS FILE EXISTS FOR.
// ===========================================================================

/**
 * ============================================================================
 * A FEATURE IS NEVER RECORDED AS DELIVERED WITHOUT A DELIVERY
 * ============================================================================
 * `done` is terminal, and it *means* "merged into the base branch and tagged".
 * Until this phase the transition into it carried no guard, so a `factory
 * approve` marked a feature delivered whatever had happened to the merge.
 */
describe('a feature is never recorded as delivered without a delivery', () => {
  async function parkedAtFinalAcceptance(options: VaultOptions = {}): Promise<FactoryFixture> {
    if (options.pause !== undefined) {
      return await openVault({ ...options, status: 'needs_human' });
    }
    return await openVault({
      ...options,
      status: 'needs_human',
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        // What the pre-approval gates verified. `approve` re-checks it against
        // the branch tip before merging anything, so a fixture that left it
        // null would be refused for staleness and every case below would be
        // asserting about a close that never started. The fake `Git` answers
        // `FEATURE_TIP` for the feature branch, so this is "still current".
        verified_sha: FEATURE_TIP,
      },
    });
  }

  it('refuses to approve at all when this process cannot reach the repo', async () => {
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture);
    const { git: _dropped, ...withoutGit } = h.actions;

    await expect(approve(withoutGit, FEATURE_ID)).rejects.toThrow(ActionError);
    expect(feature().status, 'a feature was marked done with no way to merge it').toBe(
      'needs_human',
    );
    expect(feature().tag).toBeNull();
  });

  it('refuses when the note records no verified commit', async () => {
    // Absent evidence refuses, the same rule as `featureCloseVerified`'s
    // `!== true`. Asserted on the *message*: with the null branch removed the
    // tip comparison below refuses anyway, so a bare "it threw" pinned nothing.
    const fixture = await parkedAtFinalAcceptance({
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        verified_sha: null,
      },
    });
    const h = harness(fixture);

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/records no verified commit/);

    expect(h.git.names(), 'a close with no recorded verdict reached git').not.toContain('mergeNoFf');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(feature().status).toBe('needs_human');
    expect(feature().tag).toBeNull();
    expect(feature().resume_to).toBe('awaiting_feature_close');
  });

  it('refuses when the feature branch has moved since the gates ran', async () => {
    // The unit-level twin of the real-git case. The fake `Git` answers
    // `FEATURE_TIP` for the feature branch, so a fixture recording anything
    // else is a branch that moved.
    const fixture = await parkedAtFinalAcceptance({
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        verified_sha: 'e'.repeat(40),
      },
    });
    const h = harness(fixture);

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/has moved since its gates ran/);

    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.names()).not.toContain('tag');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(feature().pause_detail).toContain('e'.repeat(40));
    expect(feature().pause_detail).toContain(FEATURE_TIP);
    expect(feature().resume_to).toBe('awaiting_feature_close');
  });

  it('leaves the feature parked when the merge into base conflicts, and does not tag', async () => {
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture, {
      merge: { ok: false, conflicts: ['src/calc.ts'], detail: 'git merge exited 1' },
    });

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/does not merge cleanly/);

    const front = feature();
    expect(front.status, 'a conflicted merge produced a done feature').toBe('needs_human');
    expect(front.pause_reason).toBe('merge_conflict');
    expect(front.pause_detail).toContain('src/calc.ts');
    expect(front.pause_detail).toContain('never retried');
    expect(front.tag).toBeNull();
    expect(h.git.names(), 'a conflicted close tagged something').not.toContain('tag');
    expect(h.git.tags()).toEqual({});
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    // Approving again is the documented route, so the resume target stays.
    expect(front.resume_to).toBe('done');
    expect(front.reject_to).toBe('in_development');
    expect(h.events.ofType('feature_close_conflict')).toHaveLength(1);
    expect(h.events.ofType('feature_closed')).toHaveLength(0);
  });

  it('leaves the feature parked when the merge landed and the tag did not', async () => {
    // The one outcome that carries the merge without the tag. Nothing is
    // rewound — see the module header — and the guard refuses `done` because it
    // has no tag to be given, so the feature cannot be recorded as delivered.
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture, { tagThrows: 'fatal: tag write failed' });

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(ActionError);

    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.tag, 'a feature recorded a tag that was never created').toBeNull();
    expect(front.pause_reason).toBe('escalation');
    expect(front.pause_detail).toContain('tag write failed');
    expect(front.pause_detail).toContain(BASE_MERGED);
    expect(front.pause_detail).toContain('Approving again is safe');
    // The merge really is there, and nothing rewound it.
    expect(h.git.baseSha()).toBe(BASE_MERGED);
    expect(
      h.git.names(),
      'the close rewound the base branch — see the module header for why it must not',
    ).not.toContain('resetBranch');
    expect(h.events.ofType('feature_tag_failed')).toHaveLength(1);
    expect(h.events.ofType('feature_closed')).toHaveLength(0);
  });

  it('refuses when the feature branch is the base branch, and touches nothing', async () => {
    const fixture = await parkedAtFinalAcceptance({ featureBranch: BASE });
    const h = harness(fixture);

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/base branch/);

    expect(feature().status).toBe('needs_human');
    expect(h.git.names(), 'the base branch was merged into itself').not.toContain('mergeNoFf');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
  });

  it('refuses when the operator’s checkout carries uncommitted tracked changes', async () => {
    // The close checks the base branch out there. Those edits would end up
    // sitting on top of the base branch after a merge nobody asked for, and git
    // may refuse the checkout outright with a message about neither.
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture, {
      mainStatus: [{ x: ' ', y: 'M', path: 'src/calc.ts', originalPath: null }],
    });

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/uncommitted/);

    expect(feature().status).toBe('needs_human');
    expect(feature().pause_detail).toContain('src/calc.ts');
    expect(h.git.names()).not.toContain('mergeNoFf');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
  });

  it('merges anyway when the only mess is untracked files', async () => {
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture, {
      mainStatus: [{ x: '?', y: '?', path: 'notes.txt', originalPath: null }],
    });

    const result = await approve(h.actions, FEATURE_ID);

    expect(result.to).toBe('done');
  });

  it('reports a refused checkout instead of raising it', async () => {
    // Real git refuses `git checkout <base>` when an untracked file in the main
    // checkout is tracked on the base branch, and `ShellGit.mergeNoFf` raises.
    // Left uncaught that reaches `factory approve` as a stack trace, and on the
    // dispatcher's path it is read as a dispatch failure and retried forever.
    const fixture = await parkedAtFinalAcceptance();
    const h = harness(fixture, {
      mergeThrows: 'The following untracked working tree files would be overwritten: src/x.ts',
    });

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(ActionError);

    expect(feature().status).toBe('needs_human');
    expect(feature().pause_detail, 'git’s own message was dropped').toContain(
      'untracked working tree files',
    );
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(h.git.names()).not.toContain('tag');
  });
});

// ===========================================================================
// The green approval path.
// ===========================================================================

describe('factory approve at final acceptance', () => {
  async function parked(options: VaultOptions = {}): Promise<FactoryFixture> {
    return await openVault({
      ...options,
      status: 'needs_human',
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        // What the pre-approval gates verified. `approve` re-checks it against
        // the branch tip before merging anything, so a fixture that left it
        // null would be refused for staleness and every case below would be
        // asserting about a close that never started. The fake `Git` answers
        // `FEATURE_TIP` for the feature branch, so this is "still current".
        verified_sha: FEATURE_TIP,
      },
    });
  }

  it('merges into base, then tags — in that order', async () => {
    // The order is the property. Tagging first would put a delivery marker on a
    // commit that does not carry the feature, and a conflict would then leave a
    // tag pointing at the wrong thing with nothing to clean it up.
    const fixture = await parked();
    const h = harness(fixture);

    const result = await approve(h.actions, FEATURE_ID);

    expect(result.from).toBe('needs_human');
    expect(result.to).toBe('done');

    const names = h.git.names();
    expect(names).toContain('mergeNoFf');
    expect(names).toContain('tag');
    expect(
      names.indexOf('mergeNoFf'),
      'the close tagged before it merged',
    ).toBeLessThan(names.indexOf('tag'));

    // `--no-ff` into the base branch, from the feature branch, and not the
    // reverse. Asserted on the arguments because the direction is the whole
    // thing that makes this the base-branch write.
    const merge = h.git.calls.find((call) => call.name === 'mergeNoFf');
    expect(merge?.args).toEqual([BASE, FEATURE_BRANCH]);
    // And the tag is on the merge commit, not on the pre-merge tip.
    expect(h.git.calls.find((call) => call.name === 'tag')?.args).toEqual([TAG, BASE_MERGED]);
    expect(h.git.tags()).toEqual({ [TAG]: BASE_MERGED });
  });

  it('records the tag on the feature note and moves it to done', async () => {
    const fixture = await parked();
    const h = harness(fixture);

    await approve(h.actions, FEATURE_ID);

    const front = feature();
    expect(front.status).toBe('done');
    expect(front.tag).toBe(TAG);
    // The pause machinery is cleared, or `NEEDS_HUMAN.md` keeps reporting it.
    expect(front.pause_reason).toBeNull();
    expect(front.resume_to).toBeNull();
    expect(featureTransitions()).toContain('needs_human → done');
    expect(historyLines(featureBody()).join('\n')).toContain(TAG);
    expect(h.events.ofType('feature_closed')[0]?.tag).toBe(TAG);
    expect(h.events.ofType('feature_tagged')[0]?.sha).toBe(BASE_MERGED);
  });

  it('records the human’s note where the next reader will find it', async () => {
    const fixture = await parked();
    const h = harness(fixture);

    await approve(h.actions, FEATURE_ID, 'shipping it, watch the error rate');

    expect(sectionText(featureBody(), SECTION.notes)).toContain('watch the error rate');
    expect(historyLines(featureBody()).join('\n')).toContain('watch the error rate');
  });

  it('never rewinds the base branch on any path', async () => {
    // The single most destructive thing this system could do. `resetBranch`
    // throws in the fixture, so an implementation that reached for it fails
    // here — and the name check reports it as this rather than as a git error.
    for (const options of [
      {},
      { merge: { ok: false as const, conflicts: ['x'], detail: 'conflict' } },
      { tagThrows: 'nope' },
      { mainStatus: [{ x: ' ', y: 'M', path: 'p', originalPath: null }] },
      { mergeThrows: 'refused' },
    ]) {
      const fixture = await parked();
      const h = harness(fixture, options);
      await approve(h.actions, FEATURE_ID).catch(() => undefined);
      expect(h.git.names(), `the close rewound the base branch (${JSON.stringify(options)})`).not.toContain(
        'resetBranch',
      );
      fixture.cleanup();
      vault = undefined;
    }
  });

  it('puts the operator’s checkout back on the branch it was on', async () => {
    // `mergeNoFf` checks the base branch out and leaves the repo there.
    const fixture = await parked();
    const h = harness(fixture, { startingBranch: 'wip/something' });

    await approve(h.actions, FEATURE_ID);

    expect(await h.git.currentBranch('/repo')).toBe('wip/something');
    expect(
      h.git.calls.some((call) => call.name === 'checkout' && call.args[0] === 'wip/something'),
    ).toBe(true);
  });

  it('puts it back even after a conflict, and leaves a detached HEAD detached', async () => {
    const fixture = await parked();
    const conflicted = harness(fixture, {
      startingBranch: 'wip/something',
      merge: { ok: false, conflicts: ['x'], detail: 'conflict' },
    });
    await approve(conflicted.actions, FEATURE_ID).catch(() => undefined);
    expect(await conflicted.git.currentBranch('/repo')).toBe('wip/something');

    const detached = harness(fixture, { startingBranch: null });
    await approve(detached.actions, FEATURE_ID).catch(() => undefined);
    const restores = detached.git.calls.filter((call) => call.name === 'checkout');
    expect(restores, 'nothing put the detached HEAD back').toHaveLength(1);
    expect(restores[0]?.args[1], 'a detached HEAD was restored onto a branch').toBe(true);
  });

  it('is refused when the feature is not paused at all', async () => {
    const fixture = await openVault();
    const h = harness(fixture);
    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(/not needs_human/);
    expect(h.git.names()).not.toContain('mergeNoFf');
  });
});

// ===========================================================================
// THE SECOND LOCK, DRIVEN DIRECTLY.
// ===========================================================================

/**
 * ============================================================================
 * A LOCK NOTHING CAN DRIVE IS A LOCK NOBODY KNOWS WORKS
 * ============================================================================
 * `mergeAndFinish` re-reads the `final_acceptance` switch and refuses, so that
 * the human checkpoint does not depend on a single `if` in a single caller. The
 * review found the branch **unreachable and untested**: removing it left the
 * whole suite green, because no production path calls the function with the
 * checkpoint on and nothing outside the module could call it at all.
 *
 * So it is exported for this case. What is asserted is the property the lock
 * exists for — a caller that asks for the close while the checkpoint is enabled
 * gets a refusal, not a base-branch write — rather than the fact that a
 * particular line of code ran.
 */
describe('the second lock in mergeAndFinish', () => {
  it('refuses a close asked for while the checkpoint is enabled, and merges nothing', async () => {
    // The caller this defends against does not exist yet: a retry path, a
    // resume, an M7 dashboard action. It is driven here as one of those would.
    const fixture = await openVault({ finalAcceptance: true });
    const h = harness(fixture);
    const staged = readNoteFile(fixture.paths.featureNote(SLUG)) as never;

    const outcome = await mergeAndFinish(h.deps, h.item, staged, FEATURE_BRANCH, TAG, 'a future caller');

    expect(outcome.to, 'the close went ahead with the checkpoint enabled').toBe('needs_human');
    expect(outcome.paused).toBe(true);
    expect(h.git.names(), 'the base branch was written without an approval').not.toContain(
      'mergeNoFf',
    );
    expect(h.git.names()).not.toContain('tag');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(h.git.tags()).toEqual({});

    const front = feature();
    expect(front.status).toBe('needs_human');
    expect(front.tag).toBeNull();
    expect(front.pause_reason).toBe('escalation');
    expect(front.pause_detail).toContain('without an approval');
    // Back to be verified, not straight to `done`.
    expect(front.resume_to).toBe('awaiting_feature_close');
  });

  it('lets the close through when the checkpoint is disabled', async () => {
    // The control. Without it, a lock that refused unconditionally would pass
    // the case above and break `final_acceptance: false` entirely.
    const fixture = await openVault({ finalAcceptance: false });
    const h = harness(fixture);
    const staged = readNoteFile(fixture.paths.featureNote(SLUG)) as never;

    const outcome = await mergeAndFinish(h.deps, h.item, staged, FEATURE_BRANCH, TAG, 'the switch is off');

    expect(outcome.to).toBe('done');
    expect(h.git.baseSha()).toBe(BASE_MERGED);
    expect(h.git.tags()).toEqual({ [TAG]: BASE_MERGED });
    expect(feature().tag).toBe(TAG);
  });
});

// ===========================================================================
// A colliding tag name.
// ===========================================================================

/**
 * The tag is required to be deterministic from the slug and the date, so a
 * second close of the same feature on the same day wants the same name. It is
 * never moved (that erases the marker of a delivery that already happened) and
 * never suffixed (that makes the determinism claim false). It refuses.
 */
describe('a tag name that already exists', () => {
  async function parked(): Promise<FactoryFixture> {
    return await openVault({
      status: 'needs_human',
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        // What the pre-approval gates verified. `approve` re-checks it against
        // the branch tip before merging anything, so a fixture that left it
        // null would be refused for staleness and every case below would be
        // asserting about a close that never started. The fake `Git` answers
        // `FEATURE_TIP` for the feature branch, so this is "still current".
        verified_sha: FEATURE_TIP,
      },
    });
  }

  it('refuses before the base branch is touched at all', async () => {
    const fixture = await parked();
    const h = harness(fixture, { existingTags: { [TAG]: 'f'.repeat(40) } });

    await expect(approve(h.actions, FEATURE_ID)).rejects.toThrow(ActionError);

    expect(h.git.names(), 'a colliding tag still let the merge happen').not.toContain('mergeNoFf');
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
    expect(feature().status).toBe('needs_human');
    expect(feature().tag).toBeNull();
  });

  it('is never moved and never suffixed', async () => {
    const fixture = await parked();
    const h = harness(fixture, { existingTags: { [TAG]: 'f'.repeat(40) } });

    await approve(h.actions, FEATURE_ID).catch(() => undefined);

    expect(h.git.names(), 'the existing tag was moved or a second one was made').not.toContain(
      'tag',
    );
    expect(h.git.tags(), 'the tag now points somewhere else').toEqual({ [TAG]: 'f'.repeat(40) });
    expect(feature().pause_detail).toContain('never moved and never given a suffix');
  });

  it('says distinctly when it already points at the base tip — a close that half-finished', async () => {
    const fixture = await parked();
    const h = harness(fixture, { existingTags: { [TAG]: BASE_BEFORE } });

    await approve(h.actions, FEATURE_ID).catch(() => undefined);

    const detail = feature().pause_detail ?? '';
    expect(detail).toContain('already points at the tip');
    // And it tells the human what to do about it rather than leaving them to
    // guess: this is the one collision that means the work may already be there.
    expect(detail).toContain('by hand');
    expect(h.git.names()).not.toContain('mergeNoFf');
  });

  it('says distinctly when it points somewhere else entirely', async () => {
    const fixture = await parked();
    const h = harness(fixture, { existingTags: { [TAG]: 'f'.repeat(40) } });

    await approve(h.actions, FEATURE_ID).catch(() => undefined);

    const detail = feature().pause_detail ?? '';
    expect(detail).toContain('Something else made');
    expect(detail).toContain('Delete it if it was a mistake');
  });
});

// ===========================================================================
// Reject.
// ===========================================================================

describe('factory reject at final acceptance', () => {
  it('returns the feature to in_development with the reason recorded, and merges nothing', async () => {
    const fixture = await openVault({
      status: 'needs_human',
      pause: {
        pause_reason: 'checkpoint',
        pause_detail: 'Approve to merge and tag.',
        resume_to: 'done',
        reject_to: 'in_development',
        paused_at: PAUSED_AT,
        // What the pre-approval gates verified. `approve` re-checks it against
        // the branch tip before merging anything, so a fixture that left it
        // null would be refused for staleness and every case below would be
        // asserting about a close that never started. The fake `Git` answers
        // `FEATURE_TIP` for the feature branch, so this is "still current".
        verified_sha: FEATURE_TIP,
      },
    });
    const h = harness(fixture);

    const result = await reject(h.actions, FEATURE_ID, 'the empty-input case is still missing');

    expect(result.to).toBe('in_development');
    const front = feature();
    expect(front.status).toBe('in_development');
    expect(front.tag, 'a rejected feature was tagged').toBeNull();
    expect(front.pause_reason).toBeNull();

    // The reason reaches both the audit trail and the section the next agent
    // reads, because a rejection nobody can read is a rejection nobody can act
    // on.
    expect(historyLines(featureBody()).join('\n')).toContain('still missing');
    expect(sectionText(featureBody(), SECTION.notes)).toContain('still missing');
    expect(featureTransitions()).toContain('needs_human → in_development');

    // Nothing went near git.
    expect(h.git.names()).toEqual([]);
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
  });

  it('still insists on a reason', async () => {
    const fixture = await openVault({
      status: 'needs_human',
      pause: { resume_to: 'done', reject_to: 'in_development', pause_reason: 'checkpoint' },
    });
    const h = harness(fixture);

    await expect(reject(h.actions, FEATURE_ID, '   ')).rejects.toThrow(/needs a reason/);
    expect(feature().status).toBe('needs_human');
  });
});

// ===========================================================================
// `final_acceptance: false`.
// ===========================================================================

describe('final_acceptance disabled in config', () => {
  it('merges and tags without pausing, in one dispatch', async () => {
    const fixture = await openVault({ finalAcceptance: false });
    const h = harness(fixture);

    const outcome = await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(outcome.paused, 'a disabled checkpoint still paused').toBe(false);
    expect(outcome.to).toBe('done');

    const front = feature();
    expect(front.status).toBe('done');
    expect(front.tag).toBe(TAG_AUTO);
    // Straight through: no `needs_human` in the middle. "Disabled" means the
    // item never stops, not that it is auto-approved after stopping.
    expect(featureTransitions()).toEqual(['in_development → awaiting_feature_close', 'awaiting_feature_close → done']);
    expect(h.git.tags()).toEqual({ [TAG_AUTO]: BASE_MERGED });
  });

  /**
   * ==========================================================================
   * THE ACTOR FIELD TELLS THE TRUTH
   * ==========================================================================
   * This move is made inside a dispatch with no person involved, so it records
   * `orchestrator`. It used to record `human`, because both routes to `done`
   * were human-only in the transition table — which meant the one
   * machine-readable field in a history line said a person approved a feature
   * no person saw. `actor` is what a later query trusts, so the note is where
   * the *reason* goes and the actor stays honest.
   */
  it('records the orchestrator as the actor, and the config switch as the reason', async () => {
    const fixture = await openVault({ finalAcceptance: false });
    const h = harness(fixture);

    await dispatchItem(h.deps, h.item, { tickets: [] });

    const closing = historyLines(featureBody()).find((line) =>
      line.includes('awaiting_feature_close → done'),
    );
    expect(closing, 'the feature never closed').not.toBeUndefined();

    // `timestamp | from → to | actor | note` — the actor is the third field.
    const fields = (closing ?? '').split('|').map((part) => part.trim());
    expect(
      fields[2],
      'an auto-close claims a human approved it, which is a false audit trail',
    ).toBe('orchestrator');

    // And the reason is in the note half, so the record carries both facts.
    const note = fields.slice(3).join(' | ');
    expect(note).toContain('auto-approved');
    expect(note).toContain('final_acceptance checkpoint is disabled in config');

    // No history line anywhere claims a human did something on this feature.
    expect(
      historyLines(featureBody()).filter((line) => line.split('|')[2]?.trim() === 'human'),
    ).toEqual([]);
  });

  it('still refuses to reach done when the merge conflicts', async () => {
    const fixture = await openVault({ finalAcceptance: false });
    const h = harness(fixture, {
      merge: { ok: false, conflicts: ['src/calc.ts'], detail: 'git merge exited 1' },
    });

    const outcome = await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(outcome.to).toBe('needs_human');
    const front = feature();
    expect(front.status, 'a disabled checkpoint bypassed the merge verification').toBe(
      'needs_human',
    );
    expect(front.pause_reason).toBe('merge_conflict');
    expect(front.tag).toBeNull();
    expect(h.git.names()).not.toContain('tag');
    // And approving after a hand fix comes back to the close.
    expect(front.resume_to).toBe('done');
  });

  it('still runs the gates first, and a red branch never reaches the base branch', async () => {
    const fixture = await openVault({ finalAcceptance: false });
    const h = harness(fixture, { gates: results({ build: 'fail' }) });

    await dispatchItem(h.deps, h.item, { tickets: [] });

    expect(feature().status).toBe('needs_human');
    expect(h.git.names(), 'a red feature branch was merged into the base branch').not.toContain(
      'mergeNoFf',
    );
    expect(h.git.baseSha()).toBe(BASE_BEFORE);
  });
});

// ===========================================================================
// `closeFeature` on its own.
// ===========================================================================

describe('closeFeature', () => {
  it('refuses when the base branch does not exist', async () => {
    const fixture = await openVault();
    const git = fakeGit({ branches: [FEATURE_BRANCH] });

    const outcome = await closeFeature(closeInput(fixture, git));

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain(BASE);
    expect(git.names()).not.toContain('mergeNoFf');
  });

  it('refuses when the feature branch does not exist', async () => {
    const fixture = await openVault();
    const git = fakeGit({ branches: [BASE] });

    const outcome = await closeFeature(closeInput(fixture, git));

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.detail).toContain(FEATURE_BRANCH);
    expect(git.names()).not.toContain('mergeNoFf');
  });

  it('refuses when no tag name was derived, rather than merging untagged', async () => {
    const fixture = await openVault();
    const git = fakeGit();

    const outcome = await closeFeature(closeInput(fixture, git, { tagName: '  ' }));

    expect(outcome.kind).toBe('refused');
    expect(git.names(), 'a merge happened with nothing to mark it').not.toContain('mergeNoFf');
  });

  it('reports a merge that git says is already up to date, so a re-run completes the tag', async () => {
    // The recovery path for `tag_failed`: the merge is already on the base
    // branch, git reports success without a new commit, and the close goes
    // straight to the tag.
    const fixture = await openVault();
    const git = fakeGit({ mergeIsNoOp: true });

    const outcome = await closeFeature(closeInput(fixture, git));

    expect(outcome.kind).toBe('closed');
    expect(outcome.kind === 'closed' && outcome.sha).toBe(BASE_BEFORE);
    expect(outcome.kind === 'closed' && outcome.baseBeforeSha).toBe(BASE_BEFORE);
    expect(git.tags()).toEqual({ [TAG]: BASE_BEFORE });
  });

  it('emits a start line carrying the base SHA a human can compare against', async () => {
    const fixture = await openVault();
    const git = fakeGit();
    const events = new MemoryEventLog(() => NOW);

    await closeFeature({ ...closeInput(fixture, git), events });

    const started = events.ofType('feature_close_started');
    expect(started).toHaveLength(1);
    expect(started[0]?.baseBeforeSha).toBe(BASE_BEFORE);
    expect(started[0]?.into).toBe(BASE);
    expect(started[0]?.from).toBe(FEATURE_BRANCH);
  });
});

// ===========================================================================
// The pure helpers.
// ===========================================================================

describe('mergeCommitOf', () => {
  it('reads the SHA out of the merge → done history line the ticket merge writes', () => {
    const ticket = makeTicket(
      { id: 'T1', status: 'done' },
      [
        '## History',
        '',
        '- 2026-09-01T10:00:00Z | qa → merge | qa',
        `- 2026-09-01T12:00:00Z | merge → done | orchestrator | merged ${T001_MERGE.slice(0, 8)} into feature/sample, feat/sample/t001 deleted`,
      ].join('\n'),
    );
    expect(mergeCommitOf(ticket)).toBe(T001_MERGE.slice(0, 8));
  });

  it('returns null rather than guessing when the line carries no SHA', () => {
    const ticket = makeTicket(
      { id: 'T1', status: 'done' },
      '## History\n\n- 2026-09-01T12:00:00Z | merge → done | orchestrator\n',
    );
    expect(mergeCommitOf(ticket)).toBeNull();
  });

  it('ignores SHAs on lines that are not the merge', () => {
    // ======================================================================
    // THE DECOY HAS TO BE ONE ONLY THE `merge ` HALF REJECTS
    // ======================================================================
    // This case used to decoy with `gates → code_review`, which the
    // `endsWith('done')` half already skips — so it survived dropping the
    // `startsWith('merge ')` half entirely and pinned only one of the two
    // conditions. `needs_human → done` ends in `done` and does **not** start
    // with `merge `, so it is rejected by that half alone. It is a reachable
    // line too: the vault is a documented human editing surface (ADR-001), and
    // a hand-resolved ticket leaves exactly this.
    const ticket = makeTicket(
      { id: 'T1', status: 'done' },
      [
        '## History',
        '',
        '- 2026-09-01T11:00:00Z | gates → code_review | orchestrator | gates green at deadbeef1',
        '- 2026-09-01T11:30:00Z | needs_human → done | human | resolved by hand at cafebabe2',
      ].join('\n'),
    );
    expect(
      mergeCommitOf(ticket),
      'a SHA from a line that is not the ticket merge reached the approval summary',
    ).toBeNull();
  });
});

describe('renderApprovalSummary', () => {
  it('orders tickets by ordinal, not by whatever order they were scanned in', () => {
    const summary = renderApprovalSummary({
      featureId: FEATURE_ID,
      featureBranch: FEATURE_BRANCH,
      baseBranch: BASE,
      sha: FEATURE_TIP,
      tagName: TAG,
      tickets: [
        makeTicket({ id: 'T2', ordinal: 2, title: 'second', status: 'done' }),
        makeTicket({ id: 'T1', ordinal: 1, title: 'first', status: 'done' }),
      ],
    });
    expect(summary.indexOf('first')).toBeLessThan(summary.indexOf('second'));
    expect(summary).toContain('2 ticket(s)');
  });

  it('says so when there are no tickets, rather than rendering an empty list', () => {
    const summary = renderApprovalSummary({
      featureId: FEATURE_ID,
      featureBranch: FEATURE_BRANCH,
      baseBranch: BASE,
      sha: FEATURE_TIP,
      tagName: TAG,
      tickets: [],
    });
    expect(summary).toContain('no tickets found');
  });
});

describe('the tag name', () => {
  it('is what the close actually uses, derived from the slug and `paused_at`', async () => {
    // The determinism itself is `test/unit/git/paths.test.ts`. What this pins is
    // that the close does not derive it some other way — a second derivation
    // would be a second answer, and the note would record one while git carried
    // the other.
    //
    // `paused_at` is the authority, **not** the approver's clock: the summary
    // promised a name at checkpoint time and a tag created from `now` would not
    // match it. The fixture's `paused_at` is a different day from `NOW` so that
    // the two derivations cannot be confused for each other.
    const fixture = await openVault({
      status: 'needs_human',
      pause: {
        resume_to: 'done',
        reject_to: 'in_development',
        pause_reason: 'checkpoint',
        paused_at: PAUSED_AT,
        verified_sha: FEATURE_TIP,
      },
    });
    const h = harness(fixture);

    await approve(h.actions, FEATURE_ID);

    const fromPause = featureTagName(SLUG, PAUSED_AT);
    expect(fromPause).toBe(TAG);
    expect(
      featureTagName(SLUG, NOW),
      'the fixture no longer distinguishes the two clocks, so this proves nothing',
    ).not.toBe(fromPause);
    expect(h.git.calls.find((call) => call.name === 'tag')?.args[0]).toBe(fromPause);
    expect(feature().tag).toBe(fromPause);
  });
});

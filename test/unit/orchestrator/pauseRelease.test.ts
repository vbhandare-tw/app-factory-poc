/**
 * A pause is the dispatcher's last write to a note (dashboard plan Phase 8b).
 *
 * `dispatchItem` releases its claim in a `finally`. The old release read the
 * note and wrote all of it back with the lock cleared, so a human `approve` that
 * landed between that read and that write was silently undone: the status went
 * back to `needs_human` and the `## Notes` block and history line were lost.
 *
 * Each case reaches one `needs_human` writer inside a claimed dispatch, plants
 * the real `actions.approve` in that window, and checks three things: the
 * approval survives, the pause write itself dropped the claim, and nothing wrote
 * the note after it. The feature-close writers are covered the same way in
 * `featureClose.test.ts`, which already has the fakes they need.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import { sectionText } from '../../../src/domain/markdown.js';
import { GATE_NAMES } from '../../../src/domain/states.js';
import type { FeatureState, TicketState } from '../../../src/domain/states.js';
import { historyLines } from '../../../src/domain/transitions.js';
import type { TicketFrontmatter } from '../../../src/domain/types.js';
import type { GateResults } from '../../../src/gates/results.js';
import type { GateRunner } from '../../../src/gates/runner.js';
import type { Git } from '../../../src/git/git.js';
import { MemoryEventLog } from '../../../src/log/events.js';
import { approve } from '../../../src/orchestrator/actions.js';
import type { ActionContext } from '../../../src/orchestrator/actions.js';
import { dispatchItem } from '../../../src/orchestrator/dispatch.js';
import type { Actionable, DispatchDeps } from '../../../src/orchestrator/dispatchTypes.js';
import { MockRunner } from '../../../src/runner/mock.js';
import type { MockRunFixture } from '../../../src/runner/mock.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
import {
  dlPayload,
  escalation,
  factoryVault,
  pmPayload,
  readNoteFile,
} from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { expectPauseDropsClaim, releaseWindow } from '../../helpers/releaseWindow.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const SLUG = 'sample';
const FEATURE_ID = 'FEAT-SAMPLE';
const TICKET_ID = 'FEAT-SAMPLE-T001';
const OWNER = 'test-owner';
const NOW = '2026-09-01T10:00:00.000Z';
const HUMAN_NOTE = 'looked at it, carry on';

let vault: FactoryFixture | undefined;

afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

interface Parked {
  readonly fixture: FactoryFixture;
  readonly file: string;
  readonly item: Actionable;
}

async function featureAt(
  status: FeatureState,
  config: Readonly<Record<string, unknown>> = {},
): Promise<Parked> {
  const fixture = factoryVault({ config });
  vault = fixture;
  mkdirSync(fixture.paths.featureDir(SLUG), { recursive: true });
  const file = fixture.paths.featureNote(SLUG);
  await fixture.storage.writeNote(
    file,
    makeFeature(
      { id: FEATURE_ID, slug: SLUG, status },
      `## History\n\n- 2026-09-01T09:00:00Z | intake → refining | orchestrator\n`,
    ),
  );
  return { fixture, file, item: itemOf('feature', file) };
}

async function ticketAt(status: TicketState, overrides: Partial<TicketFrontmatter> = {}): Promise<Parked> {
  const fixture = factoryVault();
  vault = fixture;
  mkdirSync(fixture.paths.ticketsDir(SLUG), { recursive: true });
  await fixture.storage.writeNote(
    fixture.paths.featureNote(SLUG),
    makeFeature(
      { id: FEATURE_ID, slug: SLUG, status: 'in_development', feature_branch: 'feature/sample' },
      '## History\n',
    ),
  );
  const file = fixture.paths.ticketPath(SLUG, TICKET_ID);
  await fixture.storage.writeNote(
    file,
    makeTicket(
      { id: TICKET_ID, feature: SLUG, title: 'Add subtract', status, ...overrides },
      '## History\n',
    ),
  );
  return { fixture, file, item: itemOf('ticket', file) };
}

function itemOf(kind: Actionable['kind'], file: string): Actionable {
  const note = readNoteFile(file);
  return { kind, id: note.frontmatter.id, path: file, slug: SLUG, note, stage: note.frontmatter.status };
}

/** The CLI's and the dashboard's side: the real storage, never the dispatcher's. */
function human(fixture: FactoryFixture): ActionContext {
  return { paths: fixture.paths, storage: fixture.storage, config: fixture.config, now: () => NOW };
}

function deps(
  fixture: FactoryFixture,
  window: ReturnType<typeof releaseWindow>,
  extra: Partial<DispatchDeps> = {},
): DispatchDeps {
  let counter = 0;
  return {
    paths: fixture.paths,
    config: fixture.config,
    storage: window.storage,
    runner: new MockRunner({ fixtures: {} }),
    events: new MemoryEventLog(() => NOW),
    now: () => NOW,
    ownerId: OWNER,
    nextCounter: () => (counter += 1),
    hooks: window.hooks,
    ...extra,
  };
}

function runner(fixtures: Readonly<Record<string, MockRunFixture>>): MockRunner {
  return new MockRunner({ fixtures });
}

/** Every gate at one status. */
function gateResults(status: 'pass' | 'fail'): GateResults {
  return Object.fromEntries(
    GATE_NAMES.map((gate) => [
      gate,
      {
        status,
        exitCode: status === 'pass' ? 0 : 1,
        durationMs: 1,
        output: `${gate} ${status}`,
        logPath: '',
        command: `npm run ${gate}`,
      },
    ]),
  ) as GateResults;
}

function fakeGates(results: GateResults): GateRunner {
  return { run: () => Promise.resolve(results) };
}

/** `revParse` answers; anything else the case did not expect to reach throws. */
function fakeGit(root: string): Git {
  const known: Partial<Git> = {
    repoRoot: root,
    revParse: () => Promise.resolve('f'.repeat(40)),
  };
  return new Proxy(known, {
    get(target, property): unknown {
      if (property in target) return target[property as keyof Git];
      if (typeof property !== 'string' || property === 'then') return undefined;
      return () => {
        throw new Error(`this case did not expect git.${property}`);
      };
    },
  }) as Git;
}

/** Only for the capability check: no case here reaches a merge verification. */
const unusedFeatureWorkspace: DispatchDeps['featureWorkspace'] = () =>
  Promise.reject(new Error('this case did not expect a feature workspace'));

/** The human's approval is on disk, whole: status, pause cleared, `## Notes`, history. */
function expectApproved(file: string, to: string): void {
  const after = readNoteFile(file);
  expect(after.frontmatter as unknown as Record<string, unknown>, 'the release erased the approval').toMatchObject({
    status: to,
    pause_reason: null,
    resume_to: null,
    locked_by: null,
    locked_at: null,
  });
  expect(sectionText(after.body, SECTION.notes)).toContain(HUMAN_NOTE);
  expect(historyLines(after.body).at(-1)).toContain(`needs_human → ${to} | human`);
}

// ---------------------------------------------------------------------------
// The cases, one per `needs_human` writer reachable from `dispatchItem`.
// ---------------------------------------------------------------------------

describe('an approve that lands while the dispatcher releases its claim', () => {
  it('survives the after_pm_refinement checkpoint (applyRoleOutput)', async () => {
    const { fixture, file, item } = await featureAt('refining');
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), FEATURE_ID, HUMAN_NOTE));

    const outcome = await dispatchItem(
      deps(fixture, window, { runner: runner({ pm: { structured: pmPayload() } }) }),
      item,
      { tickets: [] },
    );

    expect(outcome).toMatchObject({ to: 'needs_human', paused: true });
    expect(window.planted()).toBe(true);
    expectApproved(file, 'planning');
    expectPauseDropsClaim(window.writes, file);
  });

  it('survives the after_ticket_breakdown checkpoint (applyRoleOutput, after the ticket notes)', async () => {
    const { fixture, file, item } = await featureAt('ticketing');
    writeFileSync(fixture.paths.techPlan(SLUG), '# Tech plan\n\nOne pure function.\n', 'utf8');
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), FEATURE_ID, HUMAN_NOTE));

    await dispatchItem(deps(fixture, window, { runner: runner({ dl: { structured: dlPayload() } }) }), item, {
      tickets: [],
    });

    expect(window.planted()).toBe(true);
    expectApproved(file, 'in_development');
    expectPauseDropsClaim(window.writes, file);
  });

  it('survives an agent escalation (applyRoleOutput)', async () => {
    const { fixture, file, item } = await featureAt('refining');
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), FEATURE_ID, HUMAN_NOTE));

    await dispatchItem(
      deps(fixture, window, { runner: runner({ pm: { structured: escalation('the ask is ambiguous') } }) }),
      item,
      { tickets: [] },
    );

    expect(window.planted()).toBe(true);
    expectApproved(file, 'refining');
    expectPauseDropsClaim(window.writes, file);
  });

  it.each([
    ['crash', { failure: 'crash' }, 'attempts_exhausted'],
    ['timeout', { failure: 'timeout' }, 'timeout'],
    // Invalid twice: the first schema failure is forgiven and re-run in place.
    ['malformed output', { structured: { outcome: 'ok' } }, 'malformed_output'],
  ] as const)(
    'survives an exhausted attempt budget: %s (recordFailure)',
    async (_label, fixtureRun: MockRunFixture, pauseReason) => {
      const { fixture, file, item } = await featureAt('refining', { max_attempts: 1 });
      const pauses: unknown[] = [];
      const window = releaseWindow(fixture.storage, file, async () => {
        pauses.push(readNoteFile(file).frontmatter.pause_reason);
        await approve(human(fixture), FEATURE_ID, HUMAN_NOTE);
      });

      await dispatchItem(deps(fixture, window, { runner: runner({ pm: fixtureRun }) }), item, { tickets: [] });

      expect(window.planted()).toBe(true);
      expect(pauses).toEqual([pauseReason]);
      expectApproved(file, 'refining');
      expectPauseDropsClaim(window.writes, file);
    },
  );

  it('survives a refused role: the hard gate on a ticket with no green gates (refuseEffect)', async () => {
    const { fixture, file, item } = await ticketAt('code_review');
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), TICKET_ID, HUMAN_NOTE));

    const outcome = await dispatchItem(
      deps(fixture, window, { git: fakeGit(fixture.repo.path), gates: fakeGates(gateResults('pass')) }),
      item,
      { tickets: [] },
    );

    expect(outcome.reason).toContain('refusing to run the code_reviewer agent');
    expect(window.planted()).toBe(true);
    expectApproved(file, 'code_review');
    expectPauseDropsClaim(window.writes, file);
  });

  it('survives a refused ticket merge (pauseAtMerge)', async () => {
    // A ticket branch naming the base branch is refused before git is touched.
    const { fixture, file, item } = await ticketAt('merge', { branch: 'main' });
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), TICKET_ID, HUMAN_NOTE));

    const outcome = await dispatchItem(
      deps(fixture, window, {
        git: fakeGit(fixture.repo.path),
        gates: fakeGates(gateResults('pass')),
        featureWorkspace: unusedFeatureWorkspace,
      }),
      item,
      { tickets: [] },
    );

    expect(outcome.reason).toContain('refusing to merge');
    expect(window.planted()).toBe(true);
    expectApproved(file, 'merge');
    expectPauseDropsClaim(window.writes, file);
  });

  it('survives a red gate run that exhausts the attempt budget (applyBounce)', async () => {
    const { fixture, file, item } = await ticketAt('gates', { max_attempts: 1 });
    const window = releaseWindow(fixture.storage, file, () => approve(human(fixture), TICKET_ID, HUMAN_NOTE));

    const outcome = await dispatchItem(
      deps(fixture, window, { git: fakeGit(fixture.repo.path), gates: fakeGates(gateResults('fail')) }),
      item,
      { tickets: [] },
    );

    expect(outcome).toMatchObject({ to: 'needs_human', paused: true });
    expect(window.planted()).toBe(true);
    expectApproved(file, 'in_progress');
    expectPauseDropsClaim(window.writes, file);
  });
});

describe('a dispatch that does not pause', () => {
  it('still releases its claim with a write of its own', async () => {
    // The control. A release that stopped writing altogether would pass every
    // case above and strand each unpaused item behind a live claim.
    const { fixture, file, item } = await featureAt('refining', {
      human_checkpoints: { after_pm_refinement: false, after_ticket_breakdown: true, final_acceptance: true },
    });
    const window = releaseWindow(fixture.storage, file);

    const outcome = await dispatchItem(
      deps(fixture, window, { runner: runner({ pm: { structured: pmPayload() } }) }),
      item,
      { tickets: [] },
    );

    expect(outcome.to).toBe('planning');
    const toNote = window.writes.filter((write) => write.file === file);
    expect(toNote.map((write) => [write.frontmatter['status'], write.frontmatter['locked_by']])).toEqual([
      ['refining', OWNER],
      ['planning', OWNER],
      ['planning', null],
    ]);
  });
});

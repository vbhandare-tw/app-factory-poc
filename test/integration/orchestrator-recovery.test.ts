/**
 * Crash recovery (spec §9.1, plan Phase 7a).
 *
 * > Crash recovery correctness rests on every write being atomic and every
 * > transition being idempotent — those are the two properties the recovery
 * > tests target.
 *
 * Atomicity is Phase 3's, proved with a real SIGKILL in `vault.test.ts`.
 * **Idempotence is this file's**, and it is proved the same way: a real child
 * process is killed mid-dispatch and a fresh orchestrator picks up whatever it
 * left on disk.
 *
 * The kill lands at two deliberately awkward points, not at a convenient
 * boundary:
 *
 *  - `after_run` — the agent has returned and **nothing has been written**. The
 *    role must run again, and its output must land exactly once. This is where
 *    a dispatcher that appended sections and history with separate writes would
 *    duplicate both.
 *  - `after_persist` — the note has been written and the views regenerated, but
 *    **the claim has not been released**. This is the state a naive recovery
 *    misreads: the item is fully advanced and looks busy.
 *
 * The failure this guards against is quiet. A note whose `## History` shows one
 * transition twice reads as a real double-transition to everything downstream —
 * the human debugging a stuck ticket, and the context recipes that feed history
 * to agents.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import type { Storage } from '../../src/vault/storage.js';
import { sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { readInstanceLock } from '../../src/orchestrator/lock.js';
import { Orchestrator } from '../../src/orchestrator/loop.js';
import { makeFeature } from '../helpers/notes.js';
import { MockRunner } from '../../src/runner/mock.js';
import {
  dlPayload,
  escalation,
  factoryVault,
  pipelineRunner,
  pmPayload,
  readFrontmatter,
  readNoteFile,
  tlPayload,
} from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
} from '../helpers/toyRepo.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CRASH_SCRIPT = path.join(PROJECT_ROOT, 'test', 'helpers', 'crashDuringDispatch.mjs');

let vault: FactoryFixture;
let scratch: string;
let events: MemoryEventLog;
let clockMs: number;

function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

beforeAll(() => {
  // The crash child imports `dist/` (built once by test/globalSetup.ts), because
  // Node's type stripping cannot resolve the `.js` specifiers the sources use.
  const build = inject('distBuild');
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
}, 120_000);

beforeEach(() => {
  vault = factoryVault();
  scratch = scratchDir('crash-');
  events = new MemoryEventLog(() => '2026-09-01T00:00:00.000Z');
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
});

afterEach(() => {
  vault.cleanup();
  removeScratchDir(scratch);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

/** A feature already in `refining`, so the very first dispatch runs the PM. */
async function refiningFeature(fixture: FactoryFixture): Promise<string> {
  const slug = 'sample';
  mkdirSync(fixture.paths.featureDir(slug), { recursive: true });
  const file = fixture.paths.featureNote(slug);
  await fixture.storage.writeNote(
    file,
    makeFeature(
      { id: 'FEAT-SAMPLE', slug, status: 'refining', created_at: now(), updated_at: now() },
      '## History\n\n- 2026-09-01T09:00:00Z | intake → refining | orchestrator\n',
    ),
  );
  return file;
}

type CrashPoint = 'after_run' | 'after_side_files' | 'after_persist';

/** Run one cycle in a child that SIGKILLs itself at `crashPoint`. */
function crashAt(crashPoint: CrashPoint, root = vault.root): { signal: string | null; out: string } {
  const fixtures = path.join(scratch, 'fixtures.json');
  writeFileSync(
    fixtures,
    JSON.stringify({
      pm: { structured: pmPayload(), costUsd: 0.25 },
      tl_plan: { structured: tlPayload(), costUsd: 0.6 },
      dl: { structured: dlPayload(), costUsd: 0.4 },
    }),
    'utf8',
  );

  const result = spawnSync(
    process.execPath,
    [CRASH_SCRIPT, root, crashPoint, fixtures],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT_ROOT },
  );

  // Exit 98 means the crash point never fired; 99 means SIGKILL did not kill.
  // Both are broken tests rather than passing ones, so they are named here.
  expect(result.status, `child exited ${result.status}: ${result.stdout}\n${result.stderr}`).toBeNull();
  expect(result.signal).toBe('SIGKILL');
  return { signal: result.signal, out: result.stdout ?? '' };
}

/** Every transition in the note's history, in order. */
function transitions(file: string): string[] {
  return historyLines(readNoteFile(file).body).map((line) => line.split(' | ')[1] ?? '');
}

/** How many times `needle` appears in the note body. */
function occurrences(file: string, needle: string): number {
  return readNoteFile(file).body.split(needle).length - 1;
}

describe('a crash after the agent returned, before anything was written', () => {
  it('re-runs the role and writes its output exactly once, with no duplicate history', async () => {
    const file = await refiningFeature(vault);
    const before = transitions(file);
    expect(before).toEqual(['intake → refining']);

    crashAt('after_run');

    // The kill landed where it was supposed to: nothing advanced, and the note
    // is still claimed by a process that no longer exists.
    let front = readFrontmatter(file);
    expect(front['status']).toBe('refining');
    expect(typeof front['locked_by']).toBe('string');
    expect(transitions(file)).toEqual(before);
    // The crashed instance's lock is still on disk too.
    expect((await readInstanceLock(vault.paths.instanceLock())).present).toBe(true);

    // Restart. Real liveness, so the dead child's pid is what makes the lock
    // and the claim reclaimable.
    const restarted = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage: vault.storage,
      runner: pipelineRunner(),
      events,
      now,
    });
    await restarted.run({ maxCycles: 1, sleep: async () => undefined });
    await restarted.shutdown();

    front = readFrontmatter(file);
    // The item was unclaimed, and it re-ran.
    expect(front['locked_by']).toBeNull();
    expect(front['status']).toBe('needs_human');
    expect(events.ofType('claim_expired').map((event) => event.itemId)).toContain('FEAT-SAMPLE');

    // **No duplicate history lines.** Two transitions, each exactly once.
    expect(transitions(file)).toEqual(['intake → refining', 'refining → needs_human']);

    // And the agent's output landed once, not twice. A dispatcher that wrote
    // body sections in a separate write from the transition would have written
    // them before the crash and again on the re-run.
    expect(occurrences(file, 'subtract(a, b)')).toBe(1);
    expect(occurrences(file, SECTION.refinedRequirement)).toBe(1);
    expect(occurrences(file, SECTION.acceptanceCriteria)).toBe(1);
    expect(sectionText(readNoteFile(file).body, SECTION.acceptanceCriteria)).toBe(
      '- subtract(3, 1) returns 2\n- subtract(1, 3) returns -2',
    );

    // The cost of the crashed run is not double-counted either: only the run
    // that actually completed is charged.
    expect(front['cost_usd']).toBeCloseTo(0.25, 6);
  });
});

describe('a crash after the note was written, before the claim was released', () => {
  it('leaves the item claimed by a dead instance, and the restart frees it and carries on', async () => {
    // The checkpoint is off for this one so the PM's persist advances the
    // feature to `planning` — a state the restart can act on. With the
    // checkpoint on, the item would be parked and "re-run" would be untestable.
    const open = factoryVault({
      config: {
        human_checkpoints: {
          after_pm_refinement: false,
          after_ticket_breakdown: true,
          final_acceptance: true,
        },
      },
    });
    const saved = vault;
    vault = open;

    try {
      const file = await refiningFeature(open);

      crashAt('after_persist');

      // The awkward point: fully advanced on disk, still claimed.
      let front = readFrontmatter(file);
      expect(front['status']).toBe('planning');
      expect(typeof front['locked_by']).toBe('string');
      expect(transitions(file)).toEqual(['intake → refining', 'refining → planning']);

      const restarted = await Orchestrator.start({
        paths: open.paths,
        config: open.config,
        storage: open.storage,
        runner: pipelineRunner(),
        events,
        now,
      });
      await restarted.run({ maxCycles: 1, sleep: async () => undefined });
      await restarted.shutdown();

      front = readFrontmatter(file);
      expect(front['locked_by']).toBeNull();

      // The pipeline carried on from where the crash left it — the Tech Lead
      // ran — and the transition that was already applied was **not** applied
      // again.
      expect(transitions(file)).toEqual([
        'intake → refining',
        'refining → planning',
        'planning → ticketing',
        // The cycle kept going all the way to the next enabled checkpoint.
        'ticketing → needs_human',
      ]);
      expect(occurrences(file, 'subtract(a, b)')).toBe(1);
    } finally {
      vault = saved;
      open.cleanup();
    }
  });
});

describe('a stale instance lock', () => {
  it('is reclaimed on restart rather than blocking it', async () => {
    await refiningFeature(vault);
    crashAt('after_run');

    const stale = await readInstanceLock(vault.paths.instanceLock());
    expect(stale.record).not.toBeNull();

    const restarted = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage: vault.storage,
      runner: pipelineRunner(),
      events,
      now,
    });
    try {
      const reclaimed = events.ofType('lock_reclaimed');
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.previousPid).toBe(stale.record?.pid);
      expect(reclaimed[0]?.reason).toMatch(/no longer running/);
      expect((await readInstanceLock(vault.paths.instanceLock())).record?.pid).toBe(process.pid);
    } finally {
      await restarted.shutdown();
    }
  });
});

describe('a crash between the DL\'s ticket notes and the feature note', () => {
  it('the restart re-runs the DL and there are still exactly four tickets', async () => {
    // The one genuinely multi-file window in a dispatch: the DL writes four
    // ticket notes, then the feature note. A crash in between leaves four
    // tickets under a feature that still says `ticketing`.
    //
    // This is why ticket ids are allocated from the payload — ordinal 1..n for
    // *this* breakdown — rather than continuing from the highest ordinal
    // already on disk. Continuing would make the re-run write T005–T008 next to
    // the four the crashed run left, and the feature would end up with eight
    // tickets, half of them duplicates with different ids. Nothing would throw.
    const open = factoryVault({
      config: {
        human_checkpoints: {
          after_pm_refinement: false,
          after_ticket_breakdown: false,
          final_acceptance: true,
        },
      },
    });

    try {
      const slug = 'sample';
      mkdirSync(open.paths.featureDir(slug), { recursive: true });
      const file = open.paths.featureNote(slug);
      await open.storage.writeNote(
        file,
        makeFeature(
          { id: 'FEAT-SAMPLE', slug, status: 'ticketing', created_at: now(), updated_at: now() },
          '## History\n\n- 2026-09-01T09:00:00Z | planning → ticketing | orchestrator\n',
        ),
      );
      // The DL's context needs `tech-plan.md`, which the Tech Lead would have
      // written on the way here.
      writeFileSync(open.paths.techPlan(slug), '# Tech plan\n\nOne pure function.\n', 'utf8');

      crashAt('after_side_files', open.root);

      // Mid-state: the tickets exist, the feature does not know yet.
      expect(readFrontmatter(file)['status']).toBe('ticketing');
      expect((await open.storage.listTickets(slug)).map((t) => t.frontmatter.id)).toEqual([
        'FEAT-SAMPLE-T001',
        'FEAT-SAMPLE-T002',
        'FEAT-SAMPLE-T003',
        'FEAT-SAMPLE-T004',
      ]);

      const restarted = await Orchestrator.start({
        paths: open.paths,
        config: open.config,
        storage: open.storage,
        runner: pipelineRunner(),
        events,
        now,
      });
      await restarted.run({ maxCycles: 1, sleep: async () => undefined });
      await restarted.shutdown();

      // Four. Not eight.
      const tickets = await open.storage.listTickets(slug);
      expect(tickets.map((t) => t.frontmatter.id)).toEqual([
        'FEAT-SAMPLE-T001',
        'FEAT-SAMPLE-T002',
        'FEAT-SAMPLE-T003',
        'FEAT-SAMPLE-T004',
      ]);
      expect(tickets.map((t) => t.frontmatter.ordinal)).toEqual([1, 2, 3, 4]);
      // And their dependencies still resolve to ids that exist.
      const ids = new Set(tickets.map((t) => t.frontmatter.id));
      for (const ticket of tickets) {
        for (const dependency of ticket.frontmatter.depends_on) {
          expect(ids, `${ticket.frontmatter.id} depends on a ticket that is gone`).toContain(
            dependency,
          );
        }
      }

      expect(readFrontmatter(file)['status']).toBe('in_development');
      expect(transitions(file)).toEqual(['planning → ticketing', 'ticketing → in_development']);

      // The DL's own body section landed once. A dispatcher that appended body
      // sections in a separate write from the transition would have written
      // this before the crash and again on the re-run — one note, two copies of
      // the same paragraph, nothing red anywhere else.
      expect(occurrences(file, 'Four tickets. Two of them have no dependency')).toBe(1);
    } finally {
      open.cleanup();
    }
  });
});

describe('one atomic write per transition', () => {
  /**
   * A `Storage` that records every write, so this measures the dispatcher
   * rather than a stand-in for it.
   *
   * `appendSection` and `appendHistory` are recorded as well as `writeNote`,
   * because the naive implementation this guards against reaches for exactly
   * those two.
   */
  function counting(fixture: FactoryFixture): { storage: Storage; writes: string[] } {
    const writes: string[] = [];
    const storage = new Proxy(fixture.storage, {
      get(target, property, receiver): unknown {
        const value = Reflect.get(target, property, receiver);
        if (
          property === 'writeNote' ||
          property === 'appendSection' ||
          property === 'appendHistory'
        ) {
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

  /**
   * The three writes a dispatch is allowed to make to one note: claim,
   * transition, release. The claim and the release are bookkeeping either side
   * of the single write that carries the whole transition.
   */
  function expectOneTransitionWrite(writes: readonly string[], file: string): void {
    expect(writes.filter((entry) => entry.endsWith(file))).toEqual([
      `writeNote ${file}`,
      `writeNote ${file}`,
      `writeNote ${file}`,
    ]);
    // And the incremental helpers are never used: neither can be part of an
    // atomic transition, because each is its own read-modify-write.
    expect(writes.filter((entry) => entry.startsWith('appendSection'))).toEqual([]);
    expect(writes.filter((entry) => entry.startsWith('appendHistory'))).toEqual([]);
  }

  /** Claim, then the pause: the pause drops the claim itself, so no release write follows (Phase 8b). */
  function expectOnePauseWrite(writes: readonly string[], file: string): void {
    expect(writes.filter((entry) => entry.endsWith(file))).toEqual([
      `writeNote ${file}`,
      `writeNote ${file}`,
    ]);
    expect(writes.filter((entry) => entry.startsWith('appendSection'))).toEqual([]);
    expect(writes.filter((entry) => entry.startsWith('appendHistory'))).toEqual([]);
  }

  async function driveOneCycle(
    fixture: FactoryFixture,
    runner: MockRunner,
  ): Promise<string[]> {
    const { storage, writes } = counting(fixture);
    const instance = await Orchestrator.start({
      paths: fixture.paths,
      config: fixture.config,
      storage,
      runner,
      events,
      now,
      isAlive: () => true,
    });
    await instance.run({ maxCycles: 1, sleep: async () => undefined });
    await instance.shutdown();
    return writes;
  }

  it('the checkpoint pause path writes the note exactly once', async () => {
    const file = await refiningFeature(vault);
    const writes = await driveOneCycle(vault, pipelineRunner());

    expect(readFrontmatter(file)['status']).toBe('needs_human');
    expectOnePauseWrite(writes, file);
  });

  it('the ordinary transition path — through `persist` — writes the note exactly once', async () => {
    // The checkpoint pause above bypasses `persist` entirely. Without this
    // case, a second `writeNote` added inside `persist` passes the whole suite:
    // every crash point brackets that single write rather than landing inside
    // it, so only a write count can see a second one appear.
    const open = factoryVault({
      config: {
        human_checkpoints: {
          after_pm_refinement: false,
          after_ticket_breakdown: true,
          final_acceptance: true,
        },
      },
    });

    try {
      const file = await refiningFeature(open);
      const writes = await driveOneCycle(open, pipelineRunner());

      // `refining → planning` and `planning → ticketing` both went through
      // `persist`, and `ticketing → needs_human` through the pause path.
      expect(transitions(file)).toEqual([
        'intake → refining',
        'refining → planning',
        'planning → ticketing',
        'ticketing → needs_human',
      ]);

      const toFeature = writes.filter((entry) => entry.endsWith(file));
      // Claim, transition, release for the two moves; claim and pause for the third.
      expect(toFeature).toHaveLength(8);
      expect(toFeature.every((entry) => entry.startsWith('writeNote'))).toBe(true);
      expect(writes.filter((entry) => entry.startsWith('appendSection'))).toEqual([]);
      expect(writes.filter((entry) => entry.startsWith('appendHistory'))).toEqual([]);
    } finally {
      open.cleanup();
    }
  });

  it('the orchestrator-only transition — no agent at all — writes the note exactly once', async () => {
    // `intake → refining` has no agent behind it and takes its own path
    // through `plainTransition`. The runner has no `pm` fixture, so the cycle
    // stops after that one move and the count is unambiguous.
    const slug = 'sample';
    mkdirSync(vault.paths.featureDir(slug), { recursive: true });
    const file = vault.paths.featureNote(slug);
    await vault.storage.writeNote(
      file,
      makeFeature({ id: 'FEAT-SAMPLE', slug, status: 'intake' }, '## History\n'),
    );

    const writes = await driveOneCycle(
      vault,
      new MockRunner({ fixtures: { pm: { failure: 'aborted' } } }),
    );

    expect(transitions(file)).toEqual(['intake → refining']);

    // Five writes, and the arithmetic is the assertion:
    //   `intake → refining` — claim, transition, release   = 3
    //   `refining`, aborted — claim, release               = 2
    // An abort writes no note at all (Phase 7a's attempt policy), so its
    // dispatch contributes only the two bookkeeping writes.
    const toFeature = writes.filter((entry) => entry.endsWith(file));
    expect(toFeature).toHaveLength(5);
    expect(toFeature.every((entry) => entry.startsWith('writeNote'))).toBe(true);
    expect(writes.filter((entry) => entry.startsWith('appendSection'))).toEqual([]);
    expect(writes.filter((entry) => entry.startsWith('appendHistory'))).toEqual([]);
  });

  it('the escalation path writes the note exactly once', async () => {
    const file = await refiningFeature(vault);
    const writes = await driveOneCycle(
      vault,
      new MockRunner({ fixtures: { pm: { structured: escalation('stuck on the ask') } } }),
    );

    expect(readFrontmatter(file)['pause_reason']).toBe('escalation');
    expectOnePauseWrite(writes, file);
  });

  it('a failed attempt that does not exhaust the budget writes the note exactly once', async () => {
    const file = await refiningFeature(vault);
    const writes = await driveOneCycle(
      vault,
      new MockRunner({ fixtures: { pm: { failure: 'crash' } } }),
    );

    expect(readFrontmatter(file)['attempts']).toBe(1);
    expect(readFrontmatter(file)['status']).toBe('refining');
    expectOneTransitionWrite(writes, file);
  });

  it('the attempts-exhausted pause writes the note exactly once', async () => {
    const spent = factoryVault({ config: { max_attempts: 1 } });
    try {
      const file = await refiningFeature(spent);
      const writes = await driveOneCycle(
        spent,
        new MockRunner({ fixtures: { pm: { failure: 'timeout' } } }),
      );

      expect(readFrontmatter(file)['pause_reason']).toBe('timeout');
      expectOnePauseWrite(writes, file);
    } finally {
      spent.cleanup();
    }
  });
});

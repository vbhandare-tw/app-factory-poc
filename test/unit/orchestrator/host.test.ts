/**
 * `startOrchestrator` is `factory start` from validation up to and including
 * `Orchestrator.start` (plan Phase 1). No runner exists until validation and
 * the worktree check have both passed (plan Section E item 4).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import type { FactoryConfig } from '../../../src/config/schema.js';
import { describeFailures } from '../../../src/config/validate.js';
import { fencedBlock } from '../../../src/domain/markdown.js';
import type { ReconcileReport } from '../../../src/git/reconcile.js';
import { EventLog } from '../../../src/log/events.js';
import type { EventSink } from '../../../src/log/events.js';
import {
  noWorktreesMessage,
  startOrchestrator,
  StartupRefused,
} from '../../../src/orchestrator/host.js';
import type { OrchestratorHostDeps, WorktreeCapability } from '../../../src/orchestrator/host.js';
import {
  InstanceLock,
  InstanceLockHeldError,
  readInstanceLock,
} from '../../../src/orchestrator/lock.js';
import type { Runner } from '../../../src/runner/types.js';
import { appendToSection } from '../../../src/vault/storage.js';
import { makeFeature } from '../../helpers/notes.js';
import { factoryVault, pipelineRunner } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const vaults: FactoryFixture[] = [];

function vault(config: Readonly<Record<string, unknown>> = {}): FactoryFixture {
  const fixture = factoryVault({ config });
  vaults.push(fixture);
  return fixture;
}

function deps(overrides: Partial<OrchestratorHostDeps> = {}): OrchestratorHostDeps {
  return {
    env: { PATH: process.env['PATH'] ?? '' },
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

/** A runner factory that fails the test if startup ever calls it. */
function forbiddenRunner(): { factory: (config: FactoryConfig) => Runner; built: () => number } {
  let built = 0;
  return {
    factory: () => {
      built += 1;
      throw new Error('a Runner was constructed before startup was allowed to proceed');
    },
    built: () => built,
  };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected startOrchestrator to refuse, but it started');
    },
    (error: unknown) => error as Error,
  );
}

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of vaults.splice(0)) fixture.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('startOrchestrator', () => {
  it('refuses a failed validation as StartupRefused with the failures, and never builds a runner', async () => {
    const broken = vault();
    broken.repo.cleanup();
    const runner = forbiddenRunner();

    const error = await refusal(
      startOrchestrator({
        vaultPath: broken.root,
        config: broken.config,
        deps: deps({ runner: runner.factory }),
      }),
    );

    expect(error).toBeInstanceOf(StartupRefused);
    const failures = (error as StartupRefused).failures;
    expect(failures.map((failure) => failure.code)).toEqual(['target_repo_missing']);
    expect(error.message).toBe(describeFailures(failures));
    expect(runner.built()).toBe(0);
    expect(existsSync(broken.paths.instanceLock())).toBe(false);
    expect(existsSync(broken.paths.eventLog())).toBe(false);
  });

  it('refuses a real runner that has no way to make worktrees, before any runner exists', async () => {
    const real = vault({ runner: 'claude-code' });
    const runner = forbiddenRunner();

    const error = await refusal(
      startOrchestrator({
        vaultPath: real.root,
        config: real.config,
        deps: deps({ runner: runner.factory }),
      }),
    );

    expect(error).toBeInstanceOf(StartupRefused);
    expect(error.message).toBe(noWorktreesMessage(real.root, real.config));
    expect((error as StartupRefused).failures).toEqual([]);
    expect(runner.built()).toBe(0);
    expect(existsSync(real.paths.instanceLock())).toBe(false);
    expect(existsSync(real.paths.eventLog())).toBe(false);
  });

  it('holds the instance lock once started, and shutdown() releases it', async () => {
    const fixture = vault();

    const handle = await startOrchestrator({
      vaultPath: fixture.root,
      config: fixture.config,
      deps: deps({ runner: pipelineRunner() }),
    });

    expect((await readInstanceLock(fixture.paths.instanceLock())).record?.pid).toBe(process.pid);
    expect(handle.events).toBeInstanceOf(EventLog);
    expect(handle.stopRequested).toBe(false);

    await handle.shutdown();

    expect(existsSync(fixture.paths.instanceLock())).toBe(false);
    await expect(handle.events.emit({ type: 'cycle_started', cycle: 99 })).rejects.toThrow(
      /already closed/,
    );
  });

  it('runs cycles with the caller’s sleep, and stops when asked', async () => {
    const fixture = vault();
    const handle = await startOrchestrator({
      vaultPath: fixture.root,
      config: fixture.config,
      deps: deps({ runner: pipelineRunner() }),
    });

    const reports = await handle.run({
      maxCycles: 5,
      sleep: async () => {
        handle.requestStop();
      },
    });
    await handle.shutdown();

    expect(reports).toHaveLength(1);
    expect(handle.stopRequested).toBe(true);
  });

  it('reports a lock held by a live PID as InstanceLockHeldError', async () => {
    const fixture = vault();
    const holder = await InstanceLock.acquire(fixture.paths, {
      pollIntervalSec: fixture.config.poll_interval,
      pid: process.pid,
      host: 'another-terminal',
    });

    try {
      const error = await refusal(
        startOrchestrator({
          vaultPath: fixture.root,
          config: fixture.config,
          deps: deps({ runner: pipelineRunner() }),
        }),
      );
      expect(error).toBeInstanceOf(InstanceLockHeldError);
      expect((await readInstanceLock(fixture.paths.instanceLock())).record?.host).toBe(
        'another-terminal',
      );
    } finally {
      await holder.release();
    }
  });

  it('clears the heartbeat timer and releases the lock when shut down after run() throws', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fixture = vault();
    rmSync(fixture.paths.indexFile(), { force: true });
    mkdirSync(fixture.paths.indexFile());

    const handle = await startOrchestrator({
      vaultPath: fixture.root,
      config: fixture.config,
      deps: deps({ runner: pipelineRunner() }),
    });
    expect(vi.getTimerCount()).toBe(1);

    await expect(handle.run({ maxCycles: 1 })).rejects.toThrow(/EISDIR/);
    await handle.shutdown();

    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(fixture.paths.instanceLock())).toBe(false);
  });
});

describe('eventSinkWrapper (plan Phase 5): one wrapper, handed to every consumer', () => {
  interface Recorder {
    readonly wrap: (inner: EventSink) => EventSink;
    readonly seen: string[];
    readonly inner: () => EventSink | undefined;
    readonly wrapped: () => EventSink | undefined;
    readonly closed: () => boolean;
  }

  /** Writes through to the log exactly as it was given, remembering each type on the way. */
  function recorder(): Recorder {
    const seen: string[] = [];
    let inner: EventSink | undefined;
    let wrapped: EventSink | undefined;
    let closed = false;
    return {
      seen,
      inner: () => inner,
      wrapped: () => wrapped,
      closed: () => closed,
      wrap: (log) => {
        if (inner !== undefined) throw new Error('the wrapper was called twice');
        inner = log;
        wrapped = {
          emit: async (event) => {
            seen.push(event.type);
            await log.emit(event);
          },
          close: async () => {
            closed = true;
            await log.close();
          },
        };
        return wrapped;
      },
    };
  }

  const EMPTY_RECONCILE: ReconcileReport = {
    kept: [],
    created: [],
    removed: [],
    unaccounted: [],
    retainedDirty: [],
    scratchRemoved: [],
    failed: [],
  };

  function fileTypes(fixture: FactoryFixture): string[] {
    return readFileSync(fixture.paths.eventLog(), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type);
  }

  async function plantFeature(fixture: FactoryFixture): Promise<void> {
    mkdirSync(fixture.paths.featureDir('alpha'), { recursive: true });
    await fixture.storage.writeNote(
      fixture.paths.featureNote('alpha'),
      makeFeature(
        { id: 'FEAT-ALPHA', slug: 'alpha', title: 'alpha' },
        appendToSection('', SECTION.rawRequirement, fencedBlock('# Add subtract\n', 'markdown')),
      ),
    );
  }

  it('wraps the event log before the workspace factory and the orchestrator get it; the handle carries the wrapper', async () => {
    const fixture = vault();
    const rec = recorder();
    const factoryGot: (EventSink | undefined)[] = [];

    const handle = await startOrchestrator({
      vaultPath: fixture.root,
      config: fixture.config,
      deps: deps({
        runner: pipelineRunner(),
        workspaceFactory: (input) => {
          factoryGot.push(input.events);
          return {
            workspace: {} as unknown as WorktreeCapability['workspace'],
            reconcile: async () => EMPTY_RECONCILE,
            git: {} as unknown as WorktreeCapability['git'],
            featureWorkspace: {} as unknown as WorktreeCapability['featureWorkspace'],
          };
        },
      }),
      eventSinkWrapper: rec.wrap,
    });

    expect(rec.inner()).toBeInstanceOf(EventLog);
    expect(factoryGot).toHaveLength(1);
    expect(factoryGot[0]).toBe(rec.wrapped());
    expect(handle.events).toBe(rec.wrapped());
    expect(rec.seen).toEqual(expect.arrayContaining(['lock_acquired', 'worktrees_reconciled']));

    await handle.shutdown();
    expect(rec.closed()).toBe(true);
    expect(fileTypes(fixture)).toEqual(rec.seen);
  });

  it('hands the wrapper to the runner it builds from config, so run_started and run_finished go through it', async () => {
    const fixture = vault();
    await plantFeature(fixture);
    const rec = recorder();

    // No `deps.runner`: `runner: mock` in the vault's config builds the MockRunner.
    const handle = await startOrchestrator({
      vaultPath: fixture.root,
      config: fixture.config,
      deps: deps(),
      eventSinkWrapper: rec.wrap,
    });
    await handle.run({ maxCycles: 1, sleep: async () => undefined });
    await handle.shutdown();

    expect(rec.seen).toEqual(expect.arrayContaining(['run_started', 'run_finished']));
    expect(fileTypes(fixture)).toEqual(rec.seen);
  });

  it('closes the wrapper, not just the log, when the orchestrator refuses to start', async () => {
    const fixture = vault();
    const holder = await InstanceLock.acquire(fixture.paths, {
      pollIntervalSec: fixture.config.poll_interval,
      pid: process.pid,
      host: 'another-terminal',
    });
    const rec = recorder();

    try {
      const error = await refusal(
        startOrchestrator({
          vaultPath: fixture.root,
          config: fixture.config,
          deps: deps({ runner: pipelineRunner() }),
          eventSinkWrapper: rec.wrap,
        }),
      );
      expect(error).toBeInstanceOf(InstanceLockHeldError);
      expect(rec.closed()).toBe(true);
    } finally {
      await holder.release();
    }
  });

  it('is never called when startup is refused before the event log opens', async () => {
    const broken = vault();
    broken.repo.cleanup();
    const real = vault({ runner: 'claude-code' });

    for (const fixture of [broken, real]) {
      const rec = recorder();
      const error = await refusal(
        startOrchestrator({
          vaultPath: fixture.root,
          config: fixture.config,
          deps: deps(),
          eventSinkWrapper: rec.wrap,
        }),
      );
      expect(error).toBeInstanceOf(StartupRefused);
      expect(rec.inner()).toBeUndefined();
    }
  });
});

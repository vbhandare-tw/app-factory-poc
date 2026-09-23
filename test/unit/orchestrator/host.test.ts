/**
 * `startOrchestrator` is `factory start` from validation up to and including
 * `Orchestrator.start` (plan Phase 1). No runner exists until validation and
 * the worktree check have both passed (plan Section E item 4).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { FactoryConfig } from '../../../src/config/schema.js';
import { describeFailures } from '../../../src/config/validate.js';
import { EventLog } from '../../../src/log/events.js';
import {
  noWorktreesMessage,
  startOrchestrator,
  StartupRefused,
} from '../../../src/orchestrator/host.js';
import type { OrchestratorHostDeps } from '../../../src/orchestrator/host.js';
import {
  InstanceLock,
  InstanceLockHeldError,
  readInstanceLock,
} from '../../../src/orchestrator/lock.js';
import type { Runner } from '../../../src/runner/types.js';
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

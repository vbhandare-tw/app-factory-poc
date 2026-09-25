/**
 * `DashboardHost` (tech spec §4.1, plan Phase 4): which mode the vault is in,
 * and the lifecycle of an orchestrator hosted inside the dashboard process.
 * `startOrchestrator` is a scripted fake; the lock file is real.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeMessage } from '../../../src/dashboard/changeBus.js';
import { WATCH_DEBOUNCE_MS } from '../../../src/dashboard/constants.js';
import { DashboardHost, HostStateError } from '../../../src/dashboard/host.js';
import type { DashboardHostOptions } from '../../../src/dashboard/host.js';
import { RunIndex } from '../../../src/dashboard/runIndex.js';
import type { StartupFailure } from '../../../src/config/validate.js';
import { StartupRefused } from '../../../src/orchestrator/host.js';
import {
  abortOf,
  deferred,
  delay,
  fakeOrchestrator,
  scopeFor,
  settlesWithin,
  writeLockRecord,
} from '../../helpers/dashboardFixtures.js';
import type { FakeOrchestrator } from '../../helpers/dashboardFixtures.js';
import { factoryVault, pipelineRunner } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const LIVE_PID = 4_242_421;
const DEAD_PID = 4_242_422;

let vault: FactoryFixture;
let fake: FakeOrchestrator;
let hosts: DashboardHost[];
let logs: string[];

function host(overrides: Partial<DashboardHostOptions> = {}): DashboardHost {
  const created = new DashboardHost({
    scope: scopeFor(vault),
    deps: { env: { PATH: process.env['PATH'] ?? '' }, now: () => new Date().toISOString() },
    startOrchestrator: fake.start,
    isAlive: (pid) => pid === LIVE_PID || pid === process.pid,
    log: (line) => logs.push(line),
    ...overrides,
  });
  hosts.push(created);
  return created;
}

beforeEach(() => {
  vault = factoryVault();
  fake = fakeOrchestrator();
  hosts = [];
  logs = [];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hosts) {
    await h.forceStop();
    await h.unwatch();
  }
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('mode', () => {
  it('is stopped with no lock file', async () => {
    expect(await host().mode()).toBe('stopped');
  });

  it('is hosted while this host holds an orchestrator', async () => {
    const h = host();
    await h.start();
    expect(await h.mode()).toBe('hosted');
    expect((await h.lockView()).mode).toBe('hosted');
  });

  it('is external when another live process holds the lock', async () => {
    writeLockRecord(vault, { pid: LIVE_PID });
    const view = await host().lockView();
    expect(view).toMatchObject({ mode: 'external', pid: LIVE_PID });
  });

  it('is stopped when the lock owner is dead', async () => {
    writeLockRecord(vault, { pid: DEAD_PID });
    expect(await host().lockView()).toMatchObject({ mode: 'stopped', pid: DEAD_PID });
  });

  it('is stopped, not hosted, for a lock carrying this pid that this host does not hold', async () => {
    writeLockRecord(vault, { pid: process.pid });
    expect(await host().mode()).toBe('stopped');
  });

  it('stays external for a live pid whose heartbeat is 10 minutes old, and Start stays refused (A8)', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeLockRecord(vault, { pid: LIVE_PID, heartbeatAt: tenMinutesAgo });
    const h = host();

    expect(await h.lockView()).toEqual({ mode: 'external', pid: LIVE_PID, heartbeatAt: tenMinutesAgo });
    const refusal = await h.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(HostStateError);
    expect((refusal as HostStateError).code).toBe('external');
    expect((refusal as HostStateError).message).toContain(String(LIVE_PID));
    expect(fake.inputs).toHaveLength(0);
    expect(await h.mode()).toBe('external');
  });
});

describe('start', () => {
  it('in stopped mode hands startOrchestrator the vault, the deps and an abort signal, and becomes hosted', async () => {
    const h = host();
    await h.start();

    expect(fake.inputs).toHaveLength(1);
    const input = fake.inputs[0]!;
    expect(input.vaultPath).toBe(vault.root);
    expect(input.config).toEqual(vault.config);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.signal?.aborted).toBe(false);
    expect(h.hosting).toBe(true);
    expect(await h.mode()).toBe('hosted');
  });

  it('in external mode is refused and never calls startOrchestrator', async () => {
    writeLockRecord(vault, { pid: LIVE_PID });
    await expect(host().start()).rejects.toMatchObject({ code: 'external' });
    expect(fake.inputs).toHaveLength(0);
  });

  it('refuses a second start while the first is still starting or running', async () => {
    const h = host();
    const first = h.start();
    const second = h.start();

    await expect(second).rejects.toMatchObject({ code: 'already_hosted' });
    await first;
    await expect(h.start()).rejects.toMatchObject({ code: 'already_hosted' });
    expect(fake.inputs).toHaveLength(1);
  });

  it('StartupRefused → startupFailures and lastError populated, mode stopped', async () => {
    const failures: StartupFailure[] = [
      { code: 'target_repo_missing', key: 'target_repo', message: 'target_repo /gone does not exist.' },
    ];
    fake.behaviour.refuse = new StartupRefused('startup validation failed (1 problem)', failures);
    const h = host();

    await expect(h.start()).rejects.toBeInstanceOf(StartupRefused);

    expect(h.status()).toEqual({
      lastError: 'startup validation failed (1 problem)',
      startupFailures: failures,
      stopping: false,
    });
    expect(h.hosting).toBe(false);
    expect(await h.mode()).toBe('stopped');

    // A later successful start clears both.
    fake.behaviour.refuse = undefined;
    await h.start();
    expect(h.status()).toEqual({ lastError: null, startupFailures: [], stopping: false });
  });
});

describe('the hosted run', () => {
  it('rejecting leaves mode stopped, lastError set, the handle shut down, and the host usable', async () => {
    fake.behaviour.run = async () => {
      throw new Error('the loop blew up');
    };
    const h = host();

    await h.start();
    await h.idle();

    expect(await h.mode()).toBe('stopped');
    expect(h.hosting).toBe(false);
    expect(h.status().lastError).toBe('the loop blew up');
    expect(fake.log).toEqual(['start', 'run', 'shutdown']);
    expect(logs.join('\n')).toContain('the loop blew up');

    fake.behaviour.run = undefined;
    await h.start();
    expect(await h.mode()).toBe('hosted');
    expect(h.status().lastError).toBeNull();
  });

  it('a shutdown that throws after the run still leaves the host stopped and usable', async () => {
    const h = host({
      startOrchestrator: async (input) => {
        const handle = await fake.start(input);
        return {
          ...handle,
          run: handle.run,
          requestStop: handle.requestStop,
          get stopRequested(): boolean {
            return handle.stopRequested;
          },
          shutdown: async () => {
            throw new Error('could not remove the lock');
          },
        };
      },
    });
    fake.behaviour.run = async () => undefined;

    await h.start();
    await h.idle();

    expect(h.hosting).toBe(false);
    expect(h.status().lastError).toBe('could not remove the lock');

    fake.behaviour.run = undefined;
    await h.start();
    expect(h.hosting).toBe(true);
  });
});

describe('stop', () => {
  it('resolves only after run() settles, and shuts the handle down after it', async () => {
    const release = deferred();
    fake.behaviour.run = async ({ log }) => {
      await release.promise;
      log.push('run settled');
    };
    const h = host();
    await h.start();

    let stopped = false;
    const stopping = h.stop().then(() => {
      stopped = true;
    });
    await delay(50);

    expect(stopped).toBe(false);
    expect(fake.log).toContain('requestStop');
    expect(fake.log).not.toContain('shutdown');
    expect(h.status().stopping).toBe(true);
    expect(await h.mode()).toBe('hosted');

    release.resolve();
    await stopping;

    expect(fake.log.slice(-2)).toEqual(['run settled', 'shutdown']);
    expect(await h.mode()).toBe('stopped');
    expect(h.status().stopping).toBe(false);
  });

  it('ends a pending sleep, so the loop exits without waiting out poll_interval', async () => {
    const h = host();
    await h.start();
    await delay(20);
    expect(fake.log).toEqual(['start', 'run', 'cycle']);

    expect(await settlesWithin(h.stop(), 1_000)).toBe(true);
    expect(fake.log).toEqual(['start', 'run', 'cycle', 'requestStop', 'shutdown']);
  });

  it('with nothing hosted is a no-op, and requestStop() says why it cannot', async () => {
    const h = host();
    await h.stop();
    await h.forceStop();
    expect(() => h.requestStop()).toThrow(HostStateError);
    try {
      h.requestStop();
    } catch (error) {
      expect((error as HostStateError).code).toBe('not_hosted');
    }
    expect(fake.inputs).toHaveLength(0);
  });

  it('waits for a start that is still in flight, then stops it', async () => {
    const h = host();
    const starting = h.start();
    await h.stop();
    await starting;
    expect(fake.log).toContain('requestStop');
    expect(fake.log.at(-1)).toBe('shutdown');
    expect(h.hosting).toBe(false);
  });
});

describe('forceStop', () => {
  it('aborts the signal passed to startOrchestrator, then shuts down', async () => {
    fake.behaviour.run = async ({ input, log }) => {
      // A long agent run: finishing the item ignores requestStop, only an abort ends it.
      await abortOf(input.signal);
      log.push('run settled');
    };
    const h = host();
    await h.start();

    await h.forceStop();

    expect(fake.inputs[0]!.signal?.aborted).toBe(true);
    expect(fake.log).toEqual(['start', 'run', 'requestStop', 'aborted', 'run settled', 'shutdown']);
    expect(h.hosting).toBe(false);
    expect(await h.mode()).toBe('stopped');
  });

  it('after a drain is already waiting, aborts the same run and both calls resolve', async () => {
    fake.behaviour.run = async ({ input }) => {
      await abortOf(input.signal);
    };
    const h = host();
    await h.start();

    const drain = h.stop();
    expect(await settlesWithin(drain, 100)).toBe(false);

    await h.forceStop();
    expect(await settlesWithin(drain, 1_000)).toBe(true);
    expect(fake.log.filter((entry) => entry === 'shutdown')).toHaveLength(1);
  });
});

describe('wake', () => {
  it('during the injected sleep resolves it at once', async () => {
    fake.behaviour.run = ({ input }) => abortOf(input.signal);
    const h = host();
    await h.start();

    const sleeping = fake.sleep()(15_000);
    h.wake();

    expect(await settlesWithin(sleeping, 500)).toBe(true);
  });

  it('with nothing hosted is a no-op: it throws nothing, starts nothing, and shortens no later sleep', async () => {
    fake.behaviour.run = ({ input }) => abortOf(input.signal);
    const h = host();

    expect(() => h.wake()).not.toThrow();
    expect(fake.inputs).toHaveLength(0);

    await h.start();
    expect(await settlesWithin(fake.sleep()(300), 100)).toBe(false);
  });

  it('during a cycle starts no second cycle, and makes the next sleep return at once', async () => {
    const cycleOne = deferred();
    let cycles = 0;
    const second = deferred();
    fake.behaviour.run = async ({ options }) => {
      cycles += 1;
      await cycleOne.promise;
      await options.sleep!(15_000);
      cycles += 1;
      second.resolve();
    };
    const h = host();
    await h.start();

    h.wake();
    h.wake();
    await delay(20);
    expect(cycles).toBe(1);

    cycleOne.resolve();
    expect(await settlesWithin(second.promise, 1_000)).toBe(true);
    expect(cycles).toBe(2);
  });

  it('does not throw after the hosted run has ended', async () => {
    fake.behaviour.run = async () => undefined;
    const h = host();
    await h.start();
    await h.idle();
    expect(() => h.wake()).not.toThrow();
  });
});

describe('with the real startOrchestrator', () => {
  const realDeps = (): DashboardHostOptions['deps'] => ({
    env: { PATH: process.env['PATH'] ?? '' },
    now: () => new Date().toISOString(),
    runner: pipelineRunner(),
  });

  it('holds the instance lock under this pid while hosted, and stop() releases it', async () => {
    const h = host({ startOrchestrator: undefined, deps: realDeps() });

    await h.start();
    expect(await h.lockView()).toMatchObject({ mode: 'hosted', pid: process.pid });

    await h.stop();
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
    expect(await h.mode()).toBe('stopped');
    expect(h.status().lastError).toBeNull();
  });


  it('a run() that throws leaves no lock, no heartbeat timer, mode stopped and lastError set', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Regenerating index.md at the end of the first cycle now fails, so run() rejects.
    rmSync(vault.paths.indexFile(), { force: true });
    mkdirSync(vault.paths.indexFile());
    const h = host({ startOrchestrator: undefined, deps: realDeps() });

    await h.start();
    await h.idle();

    expect(h.status().lastError).toMatch(/EISDIR/);
    expect(await h.mode()).toBe('stopped');
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(logs.join('\n')).toMatch(/the orchestrator stopped on an error: .*EISDIR/);
  });
});

describe('live updates (plan Phase 5)', () => {
  /** Long enough for a debounce window to close and FSEvents' start-up replay to arrive. */
  const SETTLE_MS = WATCH_DEBOUNCE_MS + 400;

  async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await delay(10);
    }
  }

  /** A line as another writer of `orchestrator.jsonl` would append it. */
  function appendCycle(cycle: number): void {
    appendFileSync(
      vault.paths.eventLog(),
      `${JSON.stringify({ ts: '2026-09-24T10:00:00.000Z', type: 'cycle_started', cycle })}\n`,
    );
  }

  function cyclesHeard(h: DashboardHost): number[] {
    const cycles: number[] = [];
    h.bus.subscribe((message) => {
      if (message.kind === 'event' && message.event.type === 'cycle_started') cycles.push(message.event['cycle'] as number);
    });
    return cycles;
  }

  it('tees the hosted orchestrator’s events onto the bus; events() is that sink while hosted, undefined after', async () => {
    const h = host();
    const heard: ChangeMessage[] = [];
    h.bus.subscribe((message) => heard.push(message));
    expect(h.events()).toBeUndefined();

    await h.start();
    const sink = h.events();
    expect(sink).toBeDefined();
    await sink!.emit({ type: 'cycle_started', cycle: 7 });

    expect(fake.logs[0]!.events.map((event) => event.type)).toEqual(['cycle_started']);
    expect(heard).toMatchObject([{ kind: 'event', event: { type: 'cycle_started', cycle: 7 } }]);

    await h.stop();
    expect(h.events()).toBeUndefined();
  });

  it('follows the event log only while nothing is hosted: off from start until the hosted run has shut down', async () => {
    const h = host();
    const cycles = cyclesHeard(h);
    h.watch(0);
    appendCycle(1);
    await waitFor(() => cycles.length === 1, 5_000, 'the line appended while stopped');

    const release = deferred();
    fake.behaviour.run = ({ input }) => Promise.race([release.promise, abortOf(input.signal)]);
    await h.start();
    // What the hosted orchestrator writes; the tee has already published it.
    appendCycle(2);
    await delay(SETTLE_MS);
    expect(cycles).toEqual([1]);

    release.resolve();
    await h.idle();
    appendCycle(3);
    await waitFor(() => cycles.length === 2, 5_000, 'the line appended after the hosted run');
    await delay(SETTLE_MS);
    expect(cycles).toEqual([1, 3]);
  });

  it('delivers a line written just before start once, from the tail, before the tail stops', async () => {
    const h = host();
    const cycles = cyclesHeard(h);
    h.watch(0);
    appendCycle(1);

    await h.start();
    expect(cycles).toEqual([1]);
  });

  it('a malformed line of a known type does not stop the lines after it in the same chunk reaching the bus and the run index', async () => {
    const h = host();
    const runIndex = new RunIndex();
    h.bus.subscribe((message) => {
      if (message.kind === 'event') runIndex.apply(message.event);
    });
    const heard: string[] = [];
    h.bus.subscribe((message) => {
      if (message.kind === 'event') heard.push(message.event.type);
    });
    const runStarted = {
      ts: '2026-09-24T10:00:01.000Z',
      type: 'run_started',
      runId: 'run-7',
      role: 'developer',
      itemId: 'FEAT-X-T001',
      attempt: 1,
      model: 'sonnet',
      pid: 123,
      logPath: 'logs/run-7.jsonl',
    };
    appendFileSync(
      vault.paths.eventLog(),
      `${JSON.stringify({ ts: '2026-09-24T10:00:00.000Z', type: 'commit_created', itemId: 'FEAT-X-T001' })}\n` +
        `${JSON.stringify(runStarted)}\n`,
    );

    h.watch(0);
    await waitFor(() => heard.includes('run_started'), 5_000, 'the run_started after the malformed line');
    expect(runIndex.run('run-7')).toMatchObject({ itemId: 'FEAT-X-T001', role: 'developer' });
  });

  it('turns the tail back on when a start fails', async () => {
    fake.behaviour.refuse = new StartupRefused('startup validation failed (1 problem)', []);
    const h = host();
    const cycles = cyclesHeard(h);
    h.watch(0);

    await expect(h.start()).rejects.toBeInstanceOf(StartupRefused);
    appendCycle(5);
    await waitFor(() => cycles.length === 1, 5_000, 'the line appended after the failed start');
    expect(cycles).toEqual([5]);
  });

  it('watch() while hosted leaves the tail off until the run ends', async () => {
    const release = deferred();
    fake.behaviour.run = ({ input }) => Promise.race([release.promise, abortOf(input.signal)]);
    const h = host();
    const cycles = cyclesHeard(h);
    await h.start();
    h.watch(0);

    appendCycle(1);
    await delay(SETTLE_MS);
    expect(cycles).toEqual([]);

    release.resolve();
    await h.idle();
    appendCycle(2);
    await waitFor(() => cycles.length === 1, 5_000, 'the line appended after the run');
    expect(cycles).toEqual([2]);
  });

  it('tells the page when a hosted run starts and when it ends', async () => {
    const h = host();
    const changes: ChangeMessage[] = [];
    h.bus.subscribe((message) => {
      if (message.kind === 'state_changed') changes.push(message);
    });
    h.watch(0);
    await delay(SETTLE_MS);
    changes.length = 0;

    const release = deferred();
    fake.behaviour.run = ({ input }) => Promise.race([release.promise, abortOf(input.signal)]);
    await h.start();
    await waitFor(() => changes.length >= 1, 5_000, 'state_changed for the start');
    await delay(SETTLE_MS);
    expect(changes).toHaveLength(1);

    release.resolve();
    await h.idle();
    await waitFor(() => changes.length >= 2, 5_000, 'state_changed for the end of the run');
    await delay(SETTLE_MS);
    expect(changes).toHaveLength(2);
  });

  it('shuts the hosted run down only once no write holds the mutex, so an approval never emits into a closed log', async () => {
    const release = deferred();
    fake.behaviour.run = ({ input }) => Promise.race([release.promise, abortOf(input.signal)]);
    const h = host();
    await h.start();

    const inWrite = deferred();
    const write = h.mutex.run(() => inWrite.promise);
    release.resolve();
    await delay(100);
    expect(fake.log).not.toContain('shutdown');
    expect(h.events()).toBeDefined();

    inWrite.resolve();
    await write;
    await h.idle();
    expect(fake.log).toContain('shutdown');
    expect(h.events()).toBeUndefined();
  });

  describe('the mode re-check (plan Phase 5 review, ruling h)', () => {
    /** Longer than the debounce window, so a repeated announcement would show as a second message. */
    const TICK_MS = WATCH_DEBOUNCE_MS + 150;

    function stateChanges(h: DashboardHost): ChangeMessage[] {
      const changes: ChangeMessage[] = [];
      h.bus.subscribe((message) => {
        if (message.kind === 'state_changed') changes.push(message);
      });
      return changes;
    }

    it('tells the page within one interval when a foreign factory’s pid dies, and says nothing while the mode is steady', async () => {
      const alive = new Set([LIVE_PID]);
      writeLockRecord(vault, { pid: LIVE_PID });
      const h = host({ isAlive: (pid) => alive.has(pid), modeCheckMs: TICK_MS });
      const changes = stateChanges(h);
      h.watch(0);
      await delay(SETTLE_MS);
      changes.length = 0;

      await delay(TICK_MS * 4);
      expect(changes).toEqual([]);
      expect(await h.mode()).toBe('external');

      // The lock file does not change when its owner dies, so no watcher can see this.
      alive.delete(LIVE_PID);
      const diedAt = Date.now();
      await waitFor(() => changes.length >= 1, 5_000, 'state_changed for the dead pid');
      expect(Date.now() - diedAt).toBeLessThan(TICK_MS + WATCH_DEBOUNCE_MS + 1_000);
      await delay(SETTLE_MS + TICK_MS * 2);
      expect(changes).toHaveLength(1);
      expect(await h.mode()).toBe('stopped');
    });

    it('does not announce again a change the page was already sent: this host’s own start and stop', async () => {
      // Only the interval is fake, so each mode tick lands exactly when the test says: after the page was told.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const h = host({ modeCheckMs: TICK_MS });
      const changes = stateChanges(h);
      h.watch(0);
      await delay(SETTLE_MS);
      changes.length = 0;

      const release = deferred();
      fake.behaviour.run = ({ input }) => Promise.race([release.promise, abortOf(input.signal)]);
      await h.start();
      await waitFor(() => changes.length >= 1, 5_000, 'state_changed for the start');
      await delay(SETTLE_MS);
      await vi.advanceTimersByTimeAsync(TICK_MS);
      await delay(SETTLE_MS);
      expect(changes).toHaveLength(1);

      release.resolve();
      await h.idle();
      await waitFor(() => changes.length >= 2, 5_000, 'state_changed for the end of the run');
      await delay(SETTLE_MS);
      await vi.advanceTimersByTimeAsync(TICK_MS);
      await delay(SETTLE_MS);
      expect(changes).toHaveLength(2);
      await h.unwatch();
    });

    it('stops when unwatch() is called', async () => {
      const h = host({ modeCheckMs: TICK_MS });
      h.watch(0);
      await delay(TICK_MS * 2);
      await h.unwatch();
      const lockView = vi.spyOn(h, 'lockView');

      await delay(TICK_MS * 4);
      expect(lockView).not.toHaveBeenCalled();
    });
  });

  it('unwatch() closes the tail and the vault watcher; nothing is delivered after it', async () => {
    const h = host();
    const heard: ChangeMessage[] = [];
    h.bus.subscribe((message) => heard.push(message));
    h.watch(0);
    await delay(SETTLE_MS);
    heard.length = 0;

    await h.unwatch();
    await h.unwatch();
    appendCycle(1);
    mkdirSync(vault.paths.featureDir('alpha'), { recursive: true });
    await delay(SETTLE_MS + 300);
    expect(heard).toEqual([]);
  });
});

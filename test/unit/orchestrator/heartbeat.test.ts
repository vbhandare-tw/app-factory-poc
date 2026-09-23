/**
 * The instance-lock heartbeat runs on a timer for as long as the lock is held
 * (plan Phase 1, resolution A8), not only at loop step 2.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryEventLog } from '../../../src/log/events.js';
import type { RunSink } from '../../../src/log/runs.js';
import { evaluateLock, InstanceLock, readInstanceLock } from '../../../src/orchestrator/lock.js';
import type { InstanceLockRecord, StalenessInput } from '../../../src/orchestrator/lock.js';
import { Orchestrator } from '../../../src/orchestrator/loop.js';
import type { OrchestratorOptions } from '../../../src/orchestrator/loop.js';
import type { Runner } from '../../../src/runner/types.js';
import { makeFeature } from '../../helpers/notes.js';
import { factoryVault, pipelineRunner } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const POLL = 15;
const TICK_MS = POLL * 1000;

let vault: FactoryFixture;
let events: MemoryEventLog;
let clockMs: number;

/** Moves only when a test says so, in step with the fake interval. */
function now(): string {
  return new Date(clockMs).toISOString();
}

function advanceClock(ms: number): void {
  clockMs += ms;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real time: lets fs callbacks and microtasks run. Only intervals are faked. */
function settle(ms = 50): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function liveAt(nowIso: string): StalenessInput {
  return { nowMs: Date.parse(nowIso), pollIntervalSec: POLL, isAlive: () => true };
}

async function lockRecord(): Promise<InstanceLockRecord | null> {
  return (await readInstanceLock(vault.paths.instanceLock())).record;
}

async function start(
  runner: Runner = pipelineRunner(),
  extra: Partial<OrchestratorOptions> = {},
): Promise<Orchestrator> {
  return await Orchestrator.start({
    paths: vault.paths,
    config: vault.config,
    storage: vault.storage,
    runner,
    events,
    now,
    isAlive: () => true,
    ...extra,
  });
}

async function intakeFeature(): Promise<void> {
  mkdirSync(vault.paths.featureDir('sample'), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.featureNote('sample'),
    makeFeature(
      { id: 'FEAT-SAMPLE', slug: 'sample', status: 'intake' },
      '## Raw Requirement\n\n```markdown\n# Add subtract\n```\n',
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vault = factoryVault({ config: { poll_interval: POLL } });
  events = new MemoryEventLog(() => '2026-09-01T00:00:00.000Z');
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
});

afterEach(() => {
  vi.useRealTimers();
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('the lock heartbeat timer', () => {
  it('keeps a live lock fresh through an agent run five poll intervals long', async () => {
    await intakeFeature();
    const inRun = deferred();
    const finishRun = deferred();
    const mock = pipelineRunner();
    const slow: Runner = {
      async run(spec, signal) {
        inRun.resolve();
        await finishRun.promise;
        return await mock.run(spec, signal);
      },
    };

    const orchestrator = await start(slow);
    const cycle = orchestrator.run({ maxCycles: 1 });
    await inRun.promise;

    const cycleBeat = (await lockRecord())?.heartbeatAt;
    expect(cycleBeat).toBe(now());
    const beats = vi.spyOn(orchestrator.lock, 'heartbeat');

    for (let interval = 1; interval <= 5; interval += 1) {
      advanceClock(TICK_MS);
      expect(evaluateLock(await lockRecord(), liveAt(now())).stale, `before tick ${interval}`).toBe(
        false,
      );
      await vi.advanceTimersByTimeAsync(TICK_MS);
      await beats.mock.results[interval - 1]?.value;
      expect((await lockRecord())?.heartbeatAt, `after tick ${interval}`).toBe(now());
    }
    expect(beats).toHaveBeenCalledTimes(5);

    // The failure A8 describes: the cycle's own heartbeat alone is stale by now.
    const record = await lockRecord();
    expect(record).not.toBeNull();
    expect(evaluateLock({ ...record!, heartbeatAt: cycleBeat! }, liveAt(now())).stale).toBe(true);

    finishRun.resolve();
    await cycle;
    await orchestrator.shutdown();
  });

  it('is cleared by shutdown(): nothing ticks afterwards and the lock file stays gone', async () => {
    const orchestrator = await start();
    expect(vi.getTimerCount()).toBe(1);
    const beats = vi.spyOn(orchestrator.lock, 'heartbeat');

    await orchestrator.shutdown();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    expect(beats).not.toHaveBeenCalled();
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  });

  it('makes shutdown() wait for a tick already in flight, so the release is never undone', async () => {
    const orchestrator = await start();
    const gate = deferred();
    const realBeat = orchestrator.lock.heartbeat.bind(orchestrator.lock);
    vi.spyOn(orchestrator.lock, 'heartbeat').mockImplementationOnce(async () => {
      await gate.promise;
      await realBeat();
    });
    await vi.advanceTimersByTimeAsync(TICK_MS);

    let finished = false;
    const stopping = orchestrator.shutdown().then(() => {
      finished = true;
    });
    await settle();
    expect(finished, 'shutdown() returned while a heartbeat was still being written').toBe(false);

    gate.resolve();
    await stopping;
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
    expect(events.ofType('lock_heartbeat_failed')).toEqual([]);
  });

  it('stops itself once the lock has been released some other way', async () => {
    const orchestrator = await start();
    expect(vi.getTimerCount()).toBe(1);
    await orchestrator.lock.release();
    const beats = vi.spyOn(orchestrator.lock, 'heartbeat');

    await vi.advanceTimersByTimeAsync(3 * TICK_MS);

    expect(beats).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(events.ofType('lock_heartbeat_failed')).toEqual([]);
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
    await orchestrator.shutdown();
  });

  it('logs a tick whose write fails, and neither the timer nor the loop stops', async () => {
    const orchestrator = await start();
    const beats = vi.spyOn(orchestrator.lock, 'heartbeat');
    beats.mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }));

    await vi.advanceTimersByTimeAsync(TICK_MS);
    await settle();

    expect(events.ofType('lock_heartbeat_failed')).toEqual([
      expect.objectContaining({
        type: 'lock_heartbeat_failed',
        file: vault.paths.instanceLock(),
        error: 'EIO: i/o error, write',
      }),
    ]);

    const [report] = await orchestrator.run({ maxCycles: 1, sleep: async () => undefined });
    expect(report?.errors).toEqual([]);

    const callsBefore = beats.mock.calls.length;
    advanceClock(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(beats).toHaveBeenCalledTimes(callsBefore + 1);
    await beats.mock.results[callsBefore]?.value;
    expect((await lockRecord())?.heartbeatAt).toBe(now());

    await orchestrator.shutdown();
  });

  it('leaves no timer behind when Orchestrator.start fails after taking the lock', async () => {
    const healthy = await start();
    expect(vi.getTimerCount()).toBe(1);
    await healthy.shutdown();
    expect(vi.getTimerCount()).toBe(0);

    const runs: RunSink & { sweep(): Promise<never> } = {
      register: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      sweep: () => Promise.reject(new Error('the .runs sweep failed')),
    };
    await expect(start(pipelineRunner(), { runs })).rejects.toThrow('the .runs sweep failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('regression: a dead PID is still stale at once, however fresh its heartbeat', async () => {
    const orchestrator = await start(pipelineRunner(), { pid: 4242 });
    const beats = vi.spyOn(orchestrator.lock, 'heartbeat');
    advanceClock(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await beats.mock.results[0]?.value;

    const record = await lockRecord();
    expect(record?.heartbeatAt).toBe(now());
    expect(
      evaluateLock(record, {
        nowMs: Date.parse(now()),
        pollIntervalSec: POLL,
        isAlive: (pid) => pid !== 4242,
      }),
    ).toEqual({ stale: true, reason: 'pid 4242 is no longer running' });

    const successor = await InstanceLock.acquire(vault.paths, {
      pollIntervalSec: POLL,
      now,
      pid: 5555,
      host: 'b',
      isAlive: (pid) => pid !== 4242,
      events,
    });
    expect(successor.current().pid).toBe(5555);
    expect(events.ofType('lock_reclaimed').map((event) => event.previousPid)).toEqual([4242]);

    await orchestrator.shutdown();
    expect((await lockRecord())?.pid).toBe(5555);
    await successor.release();
  });

  it('does not replace the per-cycle heartbeat at loop step 2', async () => {
    const orchestrator = await start();
    advanceClock(4 * TICK_MS);

    await orchestrator.run({ maxCycles: 1, sleep: async () => undefined });

    expect((await lockRecord())?.heartbeatAt).toBe(now());
    await orchestrator.shutdown();
  });
});

describe('InstanceLock.release', () => {
  it('waits for a heartbeat write already in flight, so the lock file is not recreated', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const lock = await InstanceLock.acquire(vault.paths, {
        pollIntervalSec: POLL,
        now,
        pid: 1,
        host: 'a',
      });
      const beat = lock.heartbeat();
      await lock.release();
      await beat;
      expect(existsSync(vault.paths.instanceLock()), `attempt ${attempt}`).toBe(false);
    }
  });
});

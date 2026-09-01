/**
 * The instance lock (spec §7.4, plan Phase 7a).
 *
 * The four cases the plan names, plus the ones that make them mean something:
 * that reclaiming is *logged* rather than silent, and that a released lock does
 * not take a successor's file with it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryEventLog } from '../../../src/log/events.js';
import {
  evaluateLock,
  InstanceLock,
  InstanceLockHeldError,
  ownerIdFor,
  ownerPid,
  readInstanceLock,
  STALE_HEARTBEAT_MULTIPLIER,
} from '../../../src/orchestrator/lock.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

const POLL = 15;

let root: string;
let paths: VaultPaths;
let events: MemoryEventLog;

/** A clock the test drives by hand, so no case waits out a real 45 seconds. */
function clockFrom(startIso: string): { now: () => string; advance: (ms: number) => void } {
  let ms = Date.parse(startIso);
  return {
    now: (): string => new Date(ms).toISOString(),
    advance: (delta: number): void => {
      ms += delta;
    },
  };
}

beforeEach(() => {
  root = scratchDir('lock-');
  paths = new VaultPaths(root);
  events = new MemoryEventLog(() => '2026-09-01T00:00:00.000Z');
});

afterEach(() => {
  removeScratchDir(root);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('taking the lock', () => {
  it('writes the record spec §7.4 specifies and reports it acquired', async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 4242,
      host: 'test-host',
      events,
    });

    const onDisk = await readInstanceLock(paths.instanceLock());
    expect(onDisk.record).toEqual({
      pid: 4242,
      host: 'test-host',
      startedAt: '2026-09-01T10:00:00.000Z',
      heartbeatAt: '2026-09-01T10:00:00.000Z',
    });
    expect(lock.ownerId).toBe('test-host/4242/2026-09-01T10:00:00.000Z');
    expect(events.ofType('lock_acquired')).toHaveLength(1);
  });

  it('a live lock with a fresh heartbeat is refused to a second instance', async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 4242,
      host: 'a',
      // The holder is alive as far as the second instance can tell.
      isAlive: () => true,
    });

    clock.advance(1000);

    await expect(
      InstanceLock.acquire(paths, {
        pollIntervalSec: POLL,
        now: clock.now,
        pid: 5555,
        host: 'b',
        isAlive: () => true,
        events,
      }),
    ).rejects.toBeInstanceOf(InstanceLockHeldError);

    // Refused, and the incumbent's record is untouched.
    const onDisk = await readInstanceLock(paths.instanceLock());
    expect(onDisk.record?.pid).toBe(4242);
    expect(events.ofType('lock_reclaimed')).toEqual([]);
  });

  it('a lock whose PID is dead is reclaimed, with a warning event naming it', async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 4242,
      host: 'a',
      isAlive: () => true,
    });

    // Heartbeat is fresh; only the process is gone.
    clock.advance(1000);
    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 5555,
      host: 'b',
      isAlive: (pid) => pid !== 4242,
      events,
    });

    expect(lock.current().pid).toBe(5555);
    const reclaimed = events.ofType('lock_reclaimed');
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.previousPid).toBe(4242);
    expect(reclaimed[0]?.reason).toContain('4242');
  });

  it(`a lock whose heartbeat is older than ${STALE_HEARTBEAT_MULTIPLIER} × poll_interval is reclaimed`, async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 4242,
      host: 'a',
      isAlive: () => true,
    });

    // Just inside the limit: still held.
    clock.advance(STALE_HEARTBEAT_MULTIPLIER * POLL * 1000 - 1);
    await expect(
      InstanceLock.acquire(paths, {
        pollIntervalSec: POLL,
        now: clock.now,
        pid: 5555,
        host: 'b',
        isAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(InstanceLockHeldError);

    // One millisecond past it: reclaimable. The boundary is asserted from both
    // sides so an off-by-one cannot pass by being generous in one direction.
    clock.advance(2);
    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 5555,
      host: 'b',
      isAlive: () => true,
      events,
    });
    expect(lock.current().pid).toBe(5555);
    expect(events.ofType('lock_reclaimed')[0]?.reason).toMatch(/heartbeat/);
  });

  it('a lock file containing malformed JSON is treated as stale, not fatal', async () => {
    writeFileSync(paths.instanceLock(), '{ this is not json', 'utf8');

    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 7777,
      host: 'b',
      isAlive: () => true,
      events,
    });

    expect(lock.current().pid).toBe(7777);
    expect(events.ofType('lock_reclaimed')[0]?.previousPid).toBeNull();
  });

  it('a lock file with the right JSON but the wrong shape is also stale', async () => {
    // A truncated write that happens to be valid JSON is the case a naive
    // `JSON.parse` guard misses.
    writeFileSync(paths.instanceLock(), '{"pid": "not a number"}', 'utf8');

    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clockFrom('2026-09-01T10:00:00.000Z').now,
      pid: 7777,
      host: 'b',
      isAlive: () => true,
    });
    expect(lock.current().pid).toBe(7777);
  });
});

describe('heartbeat and release', () => {
  it('the heartbeat moves forward and keeps the lock live', async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    const lock = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 4242,
      host: 'a',
    });

    clock.advance(STALE_HEARTBEAT_MULTIPLIER * POLL * 1000 + 5000);
    await lock.heartbeat();

    const onDisk = await readInstanceLock(paths.instanceLock());
    expect(onDisk.record?.heartbeatAt).toBe(clock.now());
    expect(onDisk.record?.startedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(
      evaluateLock(onDisk.record, {
        nowMs: Date.parse(clock.now()),
        pollIntervalSec: POLL,
        isAlive: () => true,
      }).stale,
    ).toBe(false);
  });

  it('a heartbeat leaves no orphan .tmp behind', async () => {
    const lock = await InstanceLock.acquire(paths, { pollIntervalSec: POLL, pid: 1, host: 'a' });
    await lock.heartbeat();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('release removes the file, and is idempotent', async () => {
    const lock = await InstanceLock.acquire(paths, { pollIntervalSec: POLL, pid: 1, host: 'a' });
    await lock.release();
    expect(existsSync(paths.instanceLock())).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('release refuses to delete a successor instance\'s lock', async () => {
    const clock = clockFrom('2026-09-01T10:00:00.000Z');
    const first = await InstanceLock.acquire(paths, {
      pollIntervalSec: POLL,
      now: clock.now,
      pid: 1,
      host: 'a',
    });

    // The successor takes over while the first instance is still shutting down.
    clock.advance(1000);
    writeFileSync(
      paths.instanceLock(),
      JSON.stringify({ pid: 2, host: 'b', startedAt: clock.now(), heartbeatAt: clock.now() }),
      'utf8',
    );

    await first.release();
    expect(JSON.parse(readFileSync(paths.instanceLock(), 'utf8')).pid).toBe(2);
  });

  it('heartbeating a released lock throws rather than recreating the file', async () => {
    const lock = await InstanceLock.acquire(paths, { pollIntervalSec: POLL, pid: 1, host: 'a' });
    await lock.release();
    await expect(lock.heartbeat()).rejects.toThrow(/already been released/);
    expect(existsSync(paths.instanceLock())).toBe(false);
  });
});

describe('owner ids', () => {
  it('round-trip the pid, which is what makes dead-owner claim recovery possible', () => {
    const id = ownerIdFor({
      pid: 4242,
      host: 'host',
      startedAt: '2026-09-01T10:00:00.000Z',
      heartbeatAt: '2026-09-01T10:00:00.000Z',
    });
    expect(ownerPid(id)).toBe(4242);
  });

  it('an owner id we did not write yields no pid, rather than a wrong one', () => {
    expect(ownerPid('something-else')).toBeNull();
    expect(ownerPid('a/not-a-number/c')).toBeNull();
  });
});

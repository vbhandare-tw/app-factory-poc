/**
 * The dashboard's POST mutex (plan Phase 4): one task at a time, in call order,
 * and a failed task never wedges the ones queued behind it.
 */
import { describe, expect, it } from 'vitest';

import { Mutex } from '../../../src/dashboard/mutex.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Mutex', () => {
  it('runs tasks one at a time, in the order they were queued', async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    const gate = deferred();

    const first = mutex.run(async () => {
      log.push('first:start');
      await gate.promise;
      log.push('first:end');
      return 1;
    });
    const second = mutex.run(() => {
      log.push('second');
      return 2;
    });

    await new Promise((done) => setTimeout(done, 20));
    expect(log).toEqual(['first:start']);

    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(['first:start', 'first:end', 'second']);
  });

  it('hands a failure to its own caller and still runs the next task', async () => {
    const mutex = new Mutex();

    const failing = mutex.run(async () => {
      throw new Error('boom');
    });
    const next = mutex.run(async () => 'ran');

    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ran');
  });

  it('a task that throws synchronously is a rejection, not a crash', async () => {
    const mutex = new Mutex();
    const failing = mutex.run(() => {
      throw new Error('sync boom');
    });
    await expect(failing).rejects.toThrow('sync boom');
    expect(await mutex.run(() => 'after')).toBe('after');
  });
});

/**
 * The page's store and its pure merge rules (plan Phase 7, and the Phase 5
 * ledger notes: never dedupe the feed by `ts`; a live transcript chunk may
 * overlap the page it follows).
 */
import { describe, expect, it, vi } from 'vitest';

import { createRefresher, createStore, mergeActivity, planChunk, selectWaitingCount } from '../../../dashboard-ui/store.js';
import type { ActivityEvent } from '../../../dashboard-ui/store.js';

describe('createStore', () => {
  it('notifies every subscriber on set, with the new state and the changed keys', () => {
    const store = createStore({ a: 1, b: 'x' });
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    store.set({ a: 2 });

    expect(store.get()).toEqual({ a: 2, b: 'x' });
    expect(first).toHaveBeenCalledWith({ a: 2, b: 'x' }, ['a']);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never mutates a state object a subscriber already holds', () => {
    const store = createStore({ a: 1 });
    const before = store.get();
    store.set({ a: 2 });
    expect(before).toEqual({ a: 1 });
    expect(store.get()).not.toBe(before);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set({ a: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not stop the others', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createStore({ a: 1 });
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(after);
    expect(() => store.set({ a: 2 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('dashboard: a store subscriber failed', expect.any(Error));
    logged.mockRestore();
  });
});

describe('selectWaitingCount', () => {
  it('counts the needs_human items in the status report', () => {
    expect(
      selectWaitingCount({
        status: {
          needs_human: [
            { id: 'F1', status: 'needs_human' },
            { id: 'T1', status: 'needs_human' },
          ],
        },
      }),
    ).toBe(2);
  });

  it('ignores an entry that is not needs_human, and is 0 before the first load', () => {
    expect(selectWaitingCount({ status: { needs_human: [{ id: 'F1', status: 'done' }] } })).toBe(0);
    expect(selectWaitingCount({ status: null })).toBe(0);
    expect(selectWaitingCount({})).toBe(0);
  });
});

describe('mergeActivity', () => {
  const ev = (type: string, ts: string, extra: Record<string, unknown> = {}): ActivityEvent => ({
    type,
    ts,
    summary: `${type} ${JSON.stringify(extra)}`,
    ...extra,
  });

  it('drops a live event that is already in the fetched page even though its ts differs', () => {
    const fetched = [ev('claim_won', '2026-09-24T10:00:00.100Z', { itemId: 'T1' })];
    const pending = [ev('claim_won', '2026-09-24T10:00:00.900Z', { itemId: 'T1' })];
    expect(mergeActivity(fetched, pending, 100)).toEqual(fetched);
  });

  it('never merges two different events that share a ts', () => {
    const ts = '2026-09-24T10:00:00.000Z';
    const fetched = [ev('claim_won', ts, { itemId: 'T1' })];
    const pending = [ev('claim_won', ts, { itemId: 'T2' })];
    expect(mergeActivity(fetched, pending, 100).map((e) => e['itemId'])).toEqual(['T2', 'T1']);
  });

  it('puts new live events first, newest first, and caps the list', () => {
    const fetched = [ev('b', '2', { n: 2 }), ev('a', '1', { n: 1 })];
    const pending = [ev('c', '3', { n: 3 }), ev('d', '4', { n: 4 })];
    expect(mergeActivity(fetched, pending, 3).map((e) => e.type)).toEqual(['d', 'c', 'b']);
  });

  it('keeps two identical live events: the bus sends each event once', () => {
    const one = ev('kill_switch', '1');
    expect(mergeActivity([], [one, { ...one, ts: '2' }], 10)).toHaveLength(2);
  });

  it('does not drop a live event that only matches an older fetched event', () => {
    const fetched = [ev('b', '2', { n: 2 }), ev('kill_switch', '1')];
    expect(mergeActivity(fetched, [ev('kill_switch', '3')], 10).map((e) => e.type)).toEqual([
      'kill_switch',
      'b',
      'kill_switch',
    ]);
  });
});

describe('planChunk', () => {
  it('a chunk that starts exactly where the page ended is appended, then the view follows live', () => {
    const first = planChunk({ mode: 'page', lastLine: 40 }, 40);
    expect(first).toEqual({ action: 'append', next: { mode: 'live', lastFirst: 40 } });
    if (first.action !== 'append') throw new Error('expected append');
    expect(planChunk(first.next, 43)).toEqual({ action: 'append', next: { mode: 'live', lastFirst: 43 } });
  });

  it.each([
    ['overlaps the page', 38],
    ['leaves a gap after the page', 45],
  ])('a first chunk that %s asks for a resync ending at the chunk', (_label, firstLine) => {
    expect(planChunk({ mode: 'page', lastLine: 40 }, firstLine)).toEqual({
      action: 'resync',
      before: firstLine,
    });
  });

  it('a live chunk that goes backwards (the log was replaced, or a repeat) asks for a resync', () => {
    expect(planChunk({ mode: 'live', lastFirst: 43 }, 43)).toEqual({ action: 'resync', before: 43 });
    expect(planChunk({ mode: 'live', lastFirst: 43 }, 0)).toEqual({ action: 'resync', before: 0 });
  });

  it('after a resync to the chunk start, the same chunk is appended', () => {
    const resync = planChunk({ mode: 'page', lastLine: 40 }, 38);
    expect(resync.action).toBe('resync');
    const before = resync.action === 'resync' ? resync.before : -1;
    expect(planChunk({ mode: 'page', lastLine: before }, 38).action).toBe('append');
  });
});

describe('createRefresher', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('runs at once, with no timer, so a throttled background tab still refreshes', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const apply = vi.fn();
    const refresh = createRefresher(() => Promise.resolve('state'), apply);
    await refresh();
    expect(apply).toHaveBeenCalledWith('state', null);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('requests during a load run exactly one more load, after it, never in parallel', async () => {
    const loads = [deferred<string>(), deferred<string>()];
    let calls = 0;
    const applied: string[] = [];
    const refresh = createRefresher(
      () => loads[calls++]!.promise,
      (value: string | null) => {
        if (value !== null) applied.push(value);
      },
    );
    const first = refresh();
    void refresh();
    void refresh();
    expect(calls).toBe(1);
    loads[0]!.resolve('old runs');
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    loads[1]!.resolve('new runs');
    await first;
    expect(applied).toEqual(['old runs', 'new runs']);
  });

  it('a failed load is applied as an error and does not wedge later refreshes', async () => {
    const apply = vi.fn();
    let n = 0;
    const refresh = createRefresher(() => (n++ === 0 ? Promise.reject(new Error('down')) : Promise.resolve('ok')), apply);
    await refresh();
    await refresh();
    expect(apply).toHaveBeenNthCalledWith(1, null, expect.any(Error));
    expect(apply).toHaveBeenNthCalledWith(2, 'ok', null);
  });
});

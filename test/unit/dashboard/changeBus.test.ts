/**
 * `ChangeBus` (plan Phase 5): the one fan-out point between the change sources
 * (the tee, the event-log tail, the vault watcher, transcript tails) and every
 * SSE client.
 */
import { describe, expect, it } from 'vitest';

import { ChangeBus } from '../../../src/dashboard/changeBus.js';
import type { ChangeMessage } from '../../../src/dashboard/changeBus.js';

const CHANGED: ChangeMessage = { kind: 'state_changed', itemIds: ['FEAT-ALPHA'] };

describe('ChangeBus', () => {
  it('fans a message out to every subscriber; an unsubscribed one receives nothing', () => {
    const bus = new ChangeBus();
    const a: ChangeMessage[] = [];
    const b: ChangeMessage[] = [];
    const c: ChangeMessage[] = [];
    bus.subscribe((message) => a.push(message));
    const leaveB = bus.subscribe((message) => b.push(message));
    bus.subscribe((message) => c.push(message));
    expect(bus.subscriberCount).toBe(3);

    leaveB();
    leaveB();
    expect(bus.subscriberCount).toBe(2);

    bus.emit(CHANGED);
    expect(a).toEqual([CHANGED]);
    expect(b).toEqual([]);
    expect(c).toEqual([CHANGED]);
  });

  it('delivers in subscription order, so the run index hears about a run before any client does', () => {
    const bus = new ChangeBus();
    const order: string[] = [];
    bus.subscribe(() => order.push('run index'));
    bus.subscribe(() => order.push('client 1'));
    bus.subscribe(() => order.push('client 2'));

    bus.emit(CHANGED);
    expect(order).toEqual(['run index', 'client 1', 'client 2']);
  });

  it('a throwing subscriber does not stop the others, and its error is reported', () => {
    const errors: unknown[] = [];
    const bus = new ChangeBus({ onError: (error) => errors.push(error) });
    const got: string[] = [];
    bus.subscribe(() => got.push('first'));
    bus.subscribe(() => {
      throw new Error('subscriber down');
    });
    bus.subscribe(() => got.push('third'));

    expect(() => bus.emit(CHANGED)).not.toThrow();
    expect(got).toEqual(['first', 'third']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('subscriber down');
  });

  it('a subscriber removed while a message is being delivered does not receive it', () => {
    const bus = new ChangeBus();
    const got: string[] = [];
    let leaveSecond = (): void => undefined;
    bus.subscribe(() => {
      got.push('first');
      leaveSecond();
    });
    leaveSecond = bus.subscribe(() => got.push('second'));

    bus.emit(CHANGED);
    bus.emit(CHANGED);
    expect(got).toEqual(['first', 'first']);
    expect(bus.subscriberCount).toBe(1);
  });

  it('the same listener subscribed twice is two subscriptions, each removed on its own', () => {
    const bus = new ChangeBus();
    const got: ChangeMessage[] = [];
    const listener = (message: ChangeMessage): void => {
      got.push(message);
    };
    const leaveFirst = bus.subscribe(listener);
    bus.subscribe(listener);

    leaveFirst();
    bus.emit(CHANGED);
    expect(got).toEqual([CHANGED]);
    expect(bus.subscriberCount).toBe(1);
  });
});

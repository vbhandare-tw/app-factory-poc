/**
 * `TeeEventSink` (plan Phase 5): every event the hosted orchestrator emits is
 * written to `orchestrator.jsonl` first and only then published on the bus, and
 * nothing on the bus side can fail or change the file write (Section E item 6).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChangeBus } from '../../../src/dashboard/changeBus.js';
import type { ChangeMessage } from '../../../src/dashboard/changeBus.js';
import { summariseEvent } from '../../../src/dashboard/labels.js';
import { TeeEventSink } from '../../../src/dashboard/teeEvents.js';
import { EventLog } from '../../../src/log/events.js';
import type { FactoryEvent } from '../../../src/log/events.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

let dir: string;
let file: string;

const EVENTS: readonly FactoryEvent[] = [
  { type: 'cycle_started', cycle: 1 },
  { type: 'claim_won', itemId: 'FEAT-ALPHA', ownerId: 'host/1/2026-09-24T10:00:00.000Z' },
  { type: 'item_transitioned', itemId: 'FEAT-ALPHA', from: 'intake', to: 'refining', actor: 'orchestrator' },
];

function onDisk(): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function withoutTs(record: Record<string, unknown>): Record<string, unknown> {
  const { ts: _ts, ...rest } = record;
  return rest;
}

function eventOf(message: ChangeMessage): Record<string, unknown> {
  if (message.kind !== 'event') throw new Error(`expected an event message, got ${message.kind}`);
  return message.event as Record<string, unknown>;
}

beforeEach(() => {
  dir = scratchDir('dash-tee-');
  file = path.join(dir, 'logs', 'orchestrator.jsonl');
});

afterEach(() => {
  removeScratchDir(dir);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('TeeEventSink', () => {
  it('every event reaches the file and then the bus, in order, with its summary', async () => {
    let tick = 0;
    const log = await EventLog.open(file, { now: () => `2026-09-24T10:00:0${tick++}.000Z` });
    const bus = new ChangeBus();
    const heard: { message: ChangeMessage; linesOnDisk: number }[] = [];
    bus.subscribe((message) => heard.push({ message, linesOnDisk: onDisk().length }));
    const tee = new TeeEventSink(log, bus);

    for (const event of EVENTS) await tee.emit(event);
    await tee.close();

    expect(onDisk().map(withoutTs)).toEqual(EVENTS);
    expect(onDisk().map((line) => line['ts'])).toEqual([
      '2026-09-24T10:00:00.000Z',
      '2026-09-24T10:00:01.000Z',
      '2026-09-24T10:00:02.000Z',
    ]);
    // File first: when the bus heard about event n, n lines were already written.
    expect(heard.map((entry) => entry.linesOnDisk)).toEqual([1, 2, 3]);
    expect(heard.map((entry) => withoutTs(eventOf(entry.message)))).toEqual(EVENTS);
    for (const { message } of heard) {
      const event = eventOf(message);
      expect(typeof event['ts']).toBe('string');
      expect(message).toMatchObject({ summary: summariseEvent(event as { type: string } & Record<string, unknown>) });
    }
  });

  it('never calls the log’s clock itself, so the file’s timestamps are the ones it would have had', async () => {
    let calls = 0;
    const log = await EventLog.open(file, {
      now: () => {
        calls += 1;
        return '2026-09-24T10:00:00.000Z';
      },
    });
    const tee = new TeeEventSink(log, new ChangeBus());

    for (const event of EVENTS) await tee.emit(event);
    await tee.close();

    expect(calls).toBe(EVENTS.length);
  });

  it('a bus that throws never fails the write, and later events still reach the file', async () => {
    const log = await EventLog.open(file);
    const broken = {
      emit: (): void => {
        throw new Error('bus down');
      },
    };
    const tee = new TeeEventSink(log, broken);

    await expect(tee.emit({ type: 'cycle_started', cycle: 1 })).resolves.toBeUndefined();
    await expect(tee.emit({ type: 'cycle_started', cycle: 2 })).resolves.toBeUndefined();
    await tee.close();

    expect(onDisk().map((line) => line['cycle'])).toEqual([1, 2]);
  });

  it('a subscriber that throws does not fail the write or starve the next subscriber', async () => {
    const log = await EventLog.open(file);
    const bus = new ChangeBus({ onError: () => undefined });
    const got: ChangeMessage[] = [];
    bus.subscribe(() => {
      throw new Error('subscriber down');
    });
    bus.subscribe((message) => got.push(message));
    const tee = new TeeEventSink(log, bus);

    await expect(tee.emit({ type: 'cycle_started', cycle: 1 })).resolves.toBeUndefined();
    await tee.close();

    expect(onDisk()).toHaveLength(1);
    expect(got).toHaveLength(1);
  });

  it('a write the log refuses is not published, and the tee rejects exactly as the log does', async () => {
    const log = await EventLog.open(file);
    await log.close();
    const bus = new ChangeBus();
    const got: ChangeMessage[] = [];
    bus.subscribe((message) => got.push(message));
    const tee = new TeeEventSink(log, bus);

    await expect(tee.emit({ type: 'cycle_started', cycle: 1 })).rejects.toThrow(/already closed/);
    expect(got).toEqual([]);
  });

  it('counts the lines it wrote; a refused write does not count (plan Phase 5 review, fix 1)', async () => {
    const log = await EventLog.open(file);
    const tee = new TeeEventSink(log, new ChangeBus());
    expect(tee.written).toBe(0);

    await tee.emit({ type: 'cycle_started', cycle: 1 });
    await tee.emit({ type: 'cycle_started', cycle: 2 });
    expect(tee.written).toBe(2);

    await tee.close();
    await expect(tee.emit({ type: 'cycle_started', cycle: 3 })).rejects.toThrow(/already closed/);
    expect(tee.written).toBe(2);
  });

  it('close() closes the log it wraps', async () => {
    const log = await EventLog.open(file);
    const tee = new TeeEventSink(log, new ChangeBus());

    await tee.close();
    await expect(log.emit({ type: 'cycle_started', cycle: 1 })).rejects.toThrow(/already closed/);
  });
});

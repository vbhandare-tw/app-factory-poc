/**
 * The live-update sources (plan Phase 5) on real files in scratch directories:
 * the JSONL tail behind the activity feed in `external` / `stopped` mode, the
 * debounced vault watcher behind `state_changed`, and the ref-counted
 * transcript follower behind `/api/stream?run=`.
 */
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WATCH_DEBOUNCE_MS } from '../../../src/dashboard/constants.js';
import type { TranscriptStep } from '../../../src/dashboard/transcriptView.js';
import { tailJsonl, TranscriptFollower, watchVault } from '../../../src/dashboard/watchers.js';
import type { JsonlTail, VaultWatch } from '../../../src/dashboard/watchers.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { delay } from '../../helpers/dashboardFixtures.js';
import { cleanupAllScratchDirs, removeScratchDir, scratchDir } from '../../helpers/toyRepo.js';

/** Long enough for a debounce window to close and FSEvents' start-up replay to arrive. */
const SETTLE_MS = WATCH_DEBOUNCE_MS + 400;

let dir: string;
let closers: (() => void)[];
let errors: unknown[];

async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(10);
  }
}

function tail(file: string, fromOffset: number, onLine: (line: string) => void): JsonlTail {
  const opened = tailJsonl(file, fromOffset, onLine, { onError: (error) => errors.push(error) });
  closers.push(() => opened.close());
  return opened;
}

function vaultAt(root: string): VaultPaths {
  const paths = new VaultPaths(root);
  mkdirSync(paths.ticketsDir('alpha'), { recursive: true });
  mkdirSync(paths.logsDir(), { recursive: true });
  return paths;
}

function watch(paths: VaultPaths, onChange: (itemIds: readonly string[]) => void): VaultWatch {
  const opened = watchVault(paths, onChange, { onError: (error) => errors.push(error) });
  closers.push(() => opened.close());
  return opened;
}

function say(text: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
}

function delivery(id: string): string {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'StructuredOutput', input: {} }] } })}\n`;
}

function echo(id: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Structured output provided successfully' }] },
  })}\n`;
}

function lock(paths: VaultPaths, pid: number, heartbeatAt: string): void {
  writeFileSync(
    paths.instanceLock(),
    `${JSON.stringify({ pid, host: 'h', startedAt: '2026-09-24T10:00:00.000Z', heartbeatAt }, null, 2)}\n`,
  );
}

beforeEach(() => {
  dir = scratchDir('dash-watch-');
  closers = [];
  errors = [];
});

afterEach(() => {
  for (const close of closers) close();
  removeScratchDir(dir);
  expect(errors).toEqual([]);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('tailJsonl', () => {
  it('emits only complete lines; a partial line waits for its newline', async () => {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '');
    const got: string[] = [];
    const t = tail(file, 0, (line) => got.push(line));

    appendFileSync(file, '{"n":1}\n{"n":2');
    await waitFor(() => got.length === 1, 5_000, 'the first line');
    await t.drain();
    expect(got).toEqual(['{"n":1}']);

    appendFileSync(file, '}\n');
    await waitFor(() => got.length === 2, 5_000, 'the completed second line');
    expect(got).toEqual(['{"n":1}', '{"n":2}']);
    expect(t.offset).toBe(Buffer.byteLength('{"n":1}\n{"n":2}\n'));
  });

  it('starts at fromOffset: nothing before it is delivered', async () => {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const got: string[] = [];
    const t = tail(file, Buffer.byteLength('{"n":1}\n'), (line) => got.push(line));

    await t.drain();
    expect(got).toEqual(['{"n":2}']);
  });

  it('picks up a file created after the tail started', async () => {
    const file = path.join(dir, 'logs', 'events.jsonl');
    mkdirSync(path.dirname(file));
    const got: string[] = [];
    const t = tail(file, 0, (line) => got.push(line));
    await t.drain();
    expect(got).toEqual([]);

    writeFileSync(file, '{"n":1}\n');
    await waitFor(() => got.length === 1, 5_000, 'the line in the new file');
    expect(got).toEqual(['{"n":1}']);
  });

  it('picks up a file whose directory did not exist when the tail started', async () => {
    const file = path.join(dir, 'logs', 'alpha', 'events.jsonl');
    mkdirSync(path.join(dir, 'logs'));
    const got: string[] = [];
    tail(file, 0, (line) => got.push(line));

    mkdirSync(path.dirname(file));
    writeFileSync(file, '{"n":1}\n');
    await waitFor(() => got.length === 1, 5_000, 'the line in the new directory');
    expect(got).toEqual(['{"n":1}']);
  });

  it('a truncated file resets the offset: no crash, nothing replayed, new lines delivered', async () => {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const got: string[] = [];
    const t = tail(file, 0, (line) => got.push(line));
    await t.drain();
    expect(got).toHaveLength(3);

    truncateSync(file, 0);
    await t.drain();
    expect(t.offset).toBe(0);

    appendFileSync(file, '{"n":9}\n');
    await waitFor(() => got.length === 4, 5_000, 'the line written after the truncation');
    expect(got).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":9}']);
  });

  it('delivers nothing after close()', async () => {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '');
    const got: string[] = [];
    const t = tail(file, 0, (line) => got.push(line));
    await t.drain();

    t.close();
    t.close();
    appendFileSync(file, '{"n":1}\n');
    await t.drain();
    await delay(SETTLE_MS);
    expect(got).toEqual([]);
  });

  it('a line whose handler throws is reported, and the lines after it in the same chunk are still delivered', async () => {
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const got: string[] = [];
    const t = tail(file, 0, (line) => {
      if (line === '{"n":2}') throw new Error('bad line');
      got.push(line);
    });

    await t.drain();
    expect(got).toEqual(['{"n":1}', '{"n":3}']);
    expect(errors).toMatchObject([{ message: 'bad line' }]);
    errors = [];
  });
});

describe('watchVault', () => {
  it('debounces a burst of 3 writes into 1 state_changed with the itemIds they touch', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    writeFileSync(paths.featureNote('alpha'), 'one');
    writeFileSync(paths.ticketPath('alpha', 'FEAT-ALPHA-T001'), 'two');
    writeFileSync(paths.techPlan('alpha'), 'three');

    await waitFor(() => changes.length > 0, 5_000, 'a state_changed');
    await delay(SETTLE_MS);
    expect(changes).toEqual([['FEAT-ALPHA', 'FEAT-ALPHA-T001']]);
  });

  it('maps an atomic write’s temp file to the note it replaces', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    writeFileSync(`${paths.ticketPath('alpha', 'FEAT-ALPHA-T002')}.4242.7.tmp`, 'x');

    await waitFor(() => changes.length > 0, 5_000, 'a state_changed');
    expect(changes).toEqual([['FEAT-ALPHA-T002']]);
  });

  it('ignores the event log, transcripts and the regenerated root views', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    appendFileSync(paths.eventLog(), '{"type":"cycle_started","cycle":1}\n');
    mkdirSync(path.join(paths.logsDir(), 'alpha'), { recursive: true });
    appendFileSync(path.join(paths.logsDir(), 'alpha', 'FEAT-ALPHA-1-pm.log'), say('hello'));
    writeFileSync(paths.indexFile(), '# index\n');
    writeFileSync(paths.needsHumanFile(), '# waiting\n');

    await delay(SETTLE_MS + 300);
    expect(changes).toEqual([]);
  });

  it('counts .kill and .runs/ changes, and a lock only when its owner changes — not every heartbeat', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    writeFileSync(paths.killFile(), 'stop\n');
    await waitFor(() => changes.length === 1, 5_000, 'the kill switch');

    mkdirSync(paths.runsDir(), { recursive: true });
    writeFileSync(path.join(paths.runsDir(), 'FEAT-ALPHA-pm-a1-1.json'), '{}\n');
    await waitFor(() => changes.length === 2, 5_000, 'the run registry');

    lock(paths, 111, '2026-09-24T10:00:00.000Z');
    await waitFor(() => changes.length === 3, 5_000, 'the lock being taken');

    lock(paths, 111, '2026-09-24T10:00:15.000Z');
    await delay(SETTLE_MS + 300);
    expect(changes).toHaveLength(3);

    lock(paths, 222, '2026-09-24T10:00:30.000Z');
    await waitFor(() => changes.length === 4, 5_000, 'the lock changing hands');

    rmSync(paths.instanceLock());
    await waitFor(() => changes.length === 5, 5_000, 'the lock being released');
    expect(changes).toEqual([[], [], [], [], []]);
  });

  it('touch() joins the current window instead of adding a message', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    w.touch();
    writeFileSync(paths.featureNote('alpha'), 'x');
    await waitFor(() => changes.length > 0, 5_000, 'a state_changed');
    await delay(SETTLE_MS);
    expect(changes).toEqual([['FEAT-ALPHA']]);

    w.touch(['FEAT-BRAVO']);
    await waitFor(() => changes.length === 2, 5_000, 'the touched window');
    expect(changes[1]).toEqual(['FEAT-BRAVO']);
  });

  it('delivers nothing after close(), not even a window that was already open', async () => {
    const paths = vaultAt(dir);
    const changes: (readonly string[])[] = [];
    const w = watch(paths, (itemIds) => changes.push(itemIds));
    await w.ready;
    await delay(SETTLE_MS);
    changes.length = 0;

    w.touch();
    w.close();
    writeFileSync(paths.featureNote('alpha'), 'x');
    await delay(SETTLE_MS + 300);
    expect(changes).toEqual([]);
  });
});

describe('TranscriptFollower', () => {
  interface Heard {
    readonly runId: string;
    readonly firstLine: number;
    readonly steps: readonly TranscriptStep[];
  }

  function follower(paths: VaultPaths, heard: Heard[]): TranscriptFollower {
    const created = new TranscriptFollower({
      logsDir: paths.logsDir(),
      onSteps: (runId, chunk) => heard.push({ runId, ...chunk }),
      onError: (error) => errors.push(error),
    });
    closers.push(() => created.closeAll());
    return created;
  }

  function transcript(paths: VaultPaths, text: string): string {
    const file = path.join(paths.logsDir(), 'alpha', 'FEAT-ALPHA-1-pm.log');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  }

  it('follows from the end of the file, numbering lines from its start; a partial line waits', async () => {
    const paths = vaultAt(dir);
    const file = transcript(paths, say('one') + say('two'));
    const heard: Heard[] = [];
    const f = follower(paths, heard);

    await f.follow('R1', file).ready;
    appendFileSync(file, say('three'));
    await waitFor(() => heard.length === 1, 5_000, 'the third line');
    expect(heard[0]).toEqual({ runId: 'R1', firstLine: 2, steps: [{ kind: 'say', text: 'three' }] });

    const four = say('four');
    appendFileSync(file, four.slice(0, 10));
    await delay(SETTLE_MS);
    expect(heard).toHaveLength(1);
    appendFileSync(file, four.slice(10));
    await waitFor(() => heard.length === 2, 5_000, 'the completed fourth line');
    expect(heard[1]).toEqual({ runId: 'R1', firstLine: 3, steps: [{ kind: 'say', text: 'four' }] });
  });

  it('numbers deliveries on from the transcript so far, and hides the echo of a delivery split across chunks (review fix 2)', async () => {
    const paths = vaultAt(dir);
    const file = transcript(paths, delivery('toolu_A') + echo('toolu_A'));
    const heard: Heard[] = [];
    const f = follower(paths, heard);

    await f.follow('R1', file).ready;
    appendFileSync(file, delivery('toolu_B'));
    await waitFor(() => heard.length === 1, 5_000, 'the second delivery');
    expect(heard[0]).toEqual({ runId: 'R1', firstLine: 2, steps: [{ kind: 'deliver', attempt: 2 }] });

    appendFileSync(file, echo('toolu_B'));
    await delay(SETTLE_MS);
    appendFileSync(file, say('done'));
    await waitFor(() => heard.flatMap((entry) => entry.steps).length === 2, 5_000, 'the line after the echo');
    await delay(SETTLE_MS);
    expect(heard.flatMap((entry) => entry.steps)).toEqual([
      { kind: 'deliver', attempt: 2 },
      { kind: 'say', text: 'done' },
    ]);
  });

  it('shares one tail between subscribers and closes it when the last one leaves', async () => {
    const paths = vaultAt(dir);
    const file = transcript(paths, say('one'));
    const heard: Heard[] = [];
    const f = follower(paths, heard);

    const first = f.follow('R1', file);
    const second = f.follow('R1', file);
    await Promise.all([first.ready, second.ready]);
    expect(f.openTails).toBe(1);
    expect(f.isFollowing('R1')).toBe(true);

    first.release();
    first.release();
    expect(f.isFollowing('R1')).toBe(true);
    appendFileSync(file, say('two'));
    await waitFor(() => heard.length === 1, 5_000, 'the line while one subscriber is left');

    second.release();
    expect(f.isFollowing('R1')).toBe(false);
    expect(f.openTails).toBe(0);
    appendFileSync(file, say('three'));
    await delay(SETTLE_MS + 300);
    expect(heard.map((entry) => entry.steps)).toEqual([[{ kind: 'say', text: 'two' }]]);
  });

  it('a release before the tail finished starting still closes it', async () => {
    const paths = vaultAt(dir);
    const file = transcript(paths, say('one'));
    const heard: Heard[] = [];
    const f = follower(paths, heard);

    const following = f.follow('R1', file);
    following.release();
    await following.ready;
    expect(f.openTails).toBe(0);

    appendFileSync(file, say('two'));
    await delay(SETTLE_MS + 300);
    expect(heard).toEqual([]);
  });

  it('never reads a transcript that is a symlink out of logs/', async () => {
    const paths = vaultAt(dir);
    const outside = path.join(dir, 'outside.log');
    writeFileSync(outside, say('secret one'));
    const file = path.join(paths.logsDir(), 'alpha', 'FEAT-ALPHA-1-pm.log');
    mkdirSync(path.dirname(file), { recursive: true });
    symlinkSync(outside, file);
    const heard: Heard[] = [];
    const f = follower(paths, heard);

    await f.follow('R1', file).ready;
    appendFileSync(outside, say('secret two'));
    await delay(SETTLE_MS + 300);
    expect(heard).toEqual([]);
  });
});

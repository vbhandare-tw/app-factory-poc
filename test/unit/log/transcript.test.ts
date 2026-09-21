/**
 * Transcripts and the `.runs` registry (spec §12).
 *
 * The live-readability test is the one that matters. M7's dashboard tails these
 * files, and a runner that buffered to completion would satisfy every other
 * assertion in this file while making live tailing impossible — the kind of
 * design mistake that is free to avoid now and expensive to fix in M7.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { EventLog, MemoryEventLog } from '../../../src/log/events.js';
import { RunRegistry } from '../../../src/log/runs.js';
import type { RunEntry } from '../../../src/log/runs.js';
import { MemoryTranscript, TranscriptWriter } from '../../../src/log/transcript.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

afterAll(() => cleanupAllScratchDirs());

function entry(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    runId: 'FEAT-DEMO-T001-developer-a1-0',
    role: 'developer',
    ticket: 'FEAT-DEMO-T001',
    feature: 'demo',
    attempt: 1,
    pid: process.pid,
    startedAt: '2026-09-01T10:00:00.000Z',
    logPath: 'logs/demo/FEAT-DEMO-T001-1-developer.log',
    ...overrides,
  };
}

describe('TranscriptWriter', () => {
  it('lines are readable from disk while the run is still open', async () => {
    const vault = new VaultPaths(scratchDir('transcript-'));
    const file = vault.logPath('demo', 'FEAT-DEMO-T001', 1, 'developer');

    const writer = await TranscriptWriter.open(file);
    await writer.writeLine(JSON.stringify({ type: 'system', subtype: 'init' }));
    await writer.writeLine(JSON.stringify({ type: 'assistant', n: 1 }));

    // Deliberately BEFORE close(). This is the M7 tailing guarantee.
    const midRun = readFileSync(file, 'utf8');
    expect(midRun.split('\n').filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(midRun.split('\n')[0] ?? '')).toEqual({ type: 'system', subtype: 'init' });

    await writer.writeLine(JSON.stringify({ type: 'result', subtype: 'success' }));
    await writer.close();

    const final = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(final).toHaveLength(3);
    // Every line is valid JSON, so a tailing reader never special-cases.
    for (const line of final) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('creates the feature log directory, appends rather than truncating, and preserves order', async () => {
    const vault = new VaultPaths(scratchDir('transcript-'));
    const file = vault.logPath('demo', 'FEAT-DEMO-T002', 2, 'qa');
    expect(existsSync(path.dirname(file))).toBe(false);

    const first = await TranscriptWriter.open(file);
    // Interleave without awaiting: writes must still land in call order.
    const pending = [first.writeLine('a'), first.writeLine('b'), first.writeLine('c')];
    await Promise.all(pending);
    await first.close();

    const second = await TranscriptWriter.open(file);
    await second.writeLine('d');
    await second.close();

    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toEqual(['a', 'b', 'c', 'd']);
    await expect(second.writeLine('e')).rejects.toThrow(/already closed/);
  });

  it('MemoryTranscript records the same lines without a disk', async () => {
    const memory = new MemoryTranscript();
    await memory.writeLine('one\n');
    await memory.writeLine('two');
    await memory.close();
    expect(memory.lines).toEqual(['one', 'two']);
    expect(memory.closed).toBe(true);
  });
});

describe('RunRegistry — .runs/<id>.json', () => {
  it('exists during the run and is gone after', async () => {
    const vault = new VaultPaths(scratchDir('runs-'));
    const registry = new RunRegistry(vault);
    const run = entry();

    await registry.register(run);
    expect(existsSync(vault.runFile(run.runId))).toBe(true);
    expect(JSON.parse(readFileSync(vault.runFile(run.runId), 'utf8'))).toEqual(run);
    expect(await registry.list()).toEqual([run]);

    await registry.complete(run.runId);
    expect(existsSync(vault.runFile(run.runId))).toBe(false);
    expect(await registry.list()).toEqual([]);

    // A second completion must not throw — the runner's finally block can run
    // twice on an error path.
    await expect(registry.complete(run.runId)).resolves.toBeUndefined();
  });

  it('sweeps entries whose process is dead and keeps the ones still running', async () => {
    const vault = new VaultPaths(scratchDir('runs-'));
    const dead = entry({ runId: 'FEAT-DEMO-T001-developer-a1-0', pid: 999_001 });
    const alive = entry({ runId: 'FEAT-DEMO-T002-qa-a1-1', pid: 999_002 });

    const registry = new RunRegistry(vault, { isAlive: (pid) => pid === 999_002 });
    await registry.register(dead);
    await registry.register(alive);

    const swept = await registry.sweep();
    expect(swept.map((e) => e.runId)).toEqual([dead.runId]);
    expect(existsSync(vault.runFile(dead.runId))).toBe(false);
    expect(existsSync(vault.runFile(alive.runId))).toBe(true);
  });

  it('treats a malformed .runs entry as stale rather than refusing to start', async () => {
    const vault = new VaultPaths(scratchDir('runs-'));
    const registry = new RunRegistry(vault, { isAlive: () => true });
    await registry.register(entry());
    await writeFile(vault.runFile('FEAT-DEMO-T009-qa-a1-3'), '{ not json', 'utf8');

    const swept = await registry.sweep();
    expect(swept.map((e) => e.runId)).toEqual(['FEAT-DEMO-T009-qa-a1-3']);
    expect(existsSync(vault.runFile('FEAT-DEMO-T009-qa-a1-3'))).toBe(false);
  });

  it('an absent .runs directory lists empty instead of throwing', async () => {
    const vault = new VaultPaths(scratchDir('runs-'));
    expect(await new RunRegistry(vault).list()).toEqual([]);
  });
});

describe('EventLog', () => {
  it('writes one JSONL line per event, readable while open', async () => {
    const vault = new VaultPaths(scratchDir('events-'));
    let tick = 0;
    const log = await EventLog.open(vault.eventLog(), {
      now: () => `2026-09-01T10:00:0${tick++}.000Z`,
    });

    await log.emit({
      type: 'run_started',
      runId: 'r1',
      role: 'developer',
      itemId: 'FEAT-DEMO-T001',
      attempt: 1,
      model: 'sonnet',
      pid: 4242,
      logPath: 'logs/demo/x.log',
    });

    const midRun = readFileSync(vault.eventLog(), 'utf8').split('\n').filter(Boolean);
    expect(midRun).toHaveLength(1);
    expect(JSON.parse(midRun[0] ?? '')).toMatchObject({
      ts: '2026-09-01T10:00:00.000Z',
      type: 'run_started',
      runId: 'r1',
      pid: 4242,
    });

    await log.emit({
      type: 'run_finished',
      runId: 'r1',
      role: 'developer',
      ok: false,
      failure: 'timeout',
      costUsd: 0.02,
      numTurns: 3,
      durationMs: 900,
      terminalReason: 'timeout',
      structuredOutputCalls: 0,
    });
    await log.close();

    const lines = readFileSync(vault.eventLog(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ type: 'run_finished', failure: 'timeout' });
    expect(vault.eventLog().endsWith(path.join('logs', 'orchestrator.jsonl'))).toBe(true);
    await expect(
      log.emit({ type: 'run_swept', runId: 'r1', pid: null }),
    ).rejects.toThrow(/already closed/);
  });

  it('MemoryEventLog captures the same events for assertions', async () => {
    const memory = new MemoryEventLog(() => '2026-09-01T00:00:00.000Z');
    await memory.emit({ type: 'run_swept', runId: 'r1', pid: 7 });
    await memory.emit({ type: 'run_stream_malformed', runId: 'r1', line: 'oops' });
    expect(memory.ofType('run_swept')).toHaveLength(1);
    expect(memory.events[0]).toEqual({ ts: '2026-09-01T00:00:00.000Z', type: 'run_swept', runId: 'r1', pid: 7 });
  });
});

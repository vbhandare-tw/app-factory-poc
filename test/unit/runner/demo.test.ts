/**
 * `DemoRunner` (dashboard plan Phase 6): the free runner behind `factory demo`.
 * It writes real files and a real transcript, and its result comes from the
 * same stream parser the real runner uses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { validateAgentOutput } from '../../../src/agents/schemas.js';
import { toSteps } from '../../../src/dashboard/transcriptView.js';
import type { TranscriptStep } from '../../../src/dashboard/transcriptView.js';
import type { Role } from '../../../src/domain/roles.js';
import { MemoryEventLog } from '../../../src/log/events.js';
import type { EventSink, FactoryEvent } from '../../../src/log/events.js';
import { MemoryRunRegistry, RunRegistry } from '../../../src/log/runs.js';
import { DemoRunner } from '../../../src/runner/demo.js';
import { DEMO_FEATURE_ID, DEMO_SCRIPT } from '../../../src/runner/demoScript.js';
import type { DemoStep } from '../../../src/runner/demoScript.js';
import type { AgentRunSpec } from '../../../src/runner/types.js';
import { VaultPaths } from '../../../src/vault/paths.js';
import { testProfile, testSpec } from '../../helpers/runnerFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

afterAll(() => cleanupAllScratchDirs());

const PAYLOAD = { outcome: 'ok', escalate_reason: null, notes_markdown: 'done' };

const WRITING_STEP: DemoStep = {
  say: ['Writing src/answer.ts.', 'Wrote it.'],
  read: ['CLAUDE.md', 'src/missing.ts'],
  write: { 'src/answer.ts': 'export const answer = 42;\n' },
  structured: PAYLOAD,
};

interface Scene {
  readonly vault: VaultPaths;
  readonly cwd: string;
  spec(overrides?: Partial<Pick<AgentRunSpec, 'role' | 'itemId' | 'validateStructured'>>): AgentRunSpec;
}

function scene(prefix: string): Scene {
  const root = scratchDir(prefix);
  const vault = new VaultPaths(path.join(root, 'vault'));
  const cwd = path.join(root, 'worktree');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, 'CLAUDE.md'), '# toy-app conventions\n', 'utf8');
  return {
    vault,
    cwd,
    spec: (overrides = {}) => {
      const role = overrides.role ?? 'developer';
      const itemId = overrides.itemId ?? 'FEAT-DEMO-T001';
      return testSpec({
        role,
        itemId,
        cwd,
        profile: testProfile({ role }),
        transcriptPath: vault.logPath('demo', itemId, 1, role),
        ...(overrides.validateStructured === undefined ? {} : { validateStructured: overrides.validateStructured }),
      });
    },
  };
}

function transcriptLines(spec: AgentRunSpec): string[] {
  return readFileSync(spec.transcriptPath, 'utf8').split('\n').filter((line) => line !== '');
}

function kinds(steps: readonly TranscriptStep[]): string[] {
  return steps.map((step) => (step.kind === 'tool' ? `tool:${step.name}` : step.kind));
}

const neverAborted = (): AbortSignal => new AbortController().signal;

describe('step lookup', () => {
  it('an unknown <role>:<itemId> and role throws naming both keys, before anything is registered or written', async () => {
    const s = scene('demo-runner-unknown-');
    const runs = new MemoryRunRegistry();
    const events = new MemoryEventLog();
    const runner = new DemoRunner({ script: { pm: WRITING_STEP }, stepDelayMs: 0, runs, events });

    const spec = s.spec({ role: 'qa', itemId: 'FEAT-DEMO-T009' });
    await expect(runner.run(spec, neverAborted())).rejects.toThrow(/qa:FEAT-DEMO-T009, qa\b/);
    expect(runs.registered).toEqual([]);
    expect(events.events).toEqual([]);
    expect(existsSync(spec.transcriptPath)).toBe(false);
  });

  it('prefers <role>:<itemId> over <role>', async () => {
    const s = scene('demo-runner-keys-');
    const general: DemoStep = { say: ['general'], structured: { ...PAYLOAD, notes_markdown: 'general' } };
    const specific: DemoStep = { say: ['specific'], structured: { ...PAYLOAD, notes_markdown: 'specific' } };
    const runner = new DemoRunner({ script: { qa: general, 'qa:FEAT-DEMO-T002': specific }, stepDelayMs: 0 });

    const one = await runner.run(s.spec({ role: 'qa', itemId: 'FEAT-DEMO-T001' }), neverAborted());
    const two = await runner.run(s.spec({ role: 'qa', itemId: 'FEAT-DEMO-T002' }), neverAborted());
    expect(one.structured).toMatchObject({ notes_markdown: 'general' });
    expect(two.structured).toMatchObject({ notes_markdown: 'specific' });
  });
});

describe('a run', () => {
  it('writes the step’s files into cwd, and a transcript that toSteps renders with no unknown steps', async () => {
    const s = scene('demo-runner-writes-');
    const runner = new DemoRunner({ script: { developer: WRITING_STEP }, stepDelayMs: 0 });
    const spec = s.spec();

    await runner.run(spec, neverAborted());

    expect(readFileSync(path.join(s.cwd, 'src', 'answer.ts'), 'utf8')).toBe('export const answer = 42;\n');
    const steps = toSteps(transcriptLines(spec));
    expect(steps.filter((step) => step.kind === 'unknown')).toEqual([]);
    expect(kinds(steps)).toEqual([
      'start',
      'say',
      'tool:Read',
      'tool_result',
      'tool:Read',
      'tool_result',
      'tool:Write',
      'tool_result',
      'say',
      'deliver',
      'end',
    ]);
    expect(steps[0]).toEqual({ kind: 'start', model: 'demo', tools: [...spec.profile.tools] });
    expect(steps.filter((step) => step.kind === 'tool_result').map((step) => step.ok)).toEqual([true, false, true]);
    expect(steps.at(-1)).toMatchObject({ kind: 'end', ok: true, costUsd: 0 });
  });

  it('returns the payload at no cost, counted by the real stream parser, with run_started and run_finished', async () => {
    const s = scene('demo-runner-result-');
    const events = new MemoryEventLog();
    const runner = new DemoRunner({ script: { developer: WRITING_STEP }, stepDelayMs: 0, events });
    const spec = s.spec();

    const result = await runner.run(spec, neverAborted());

    expect(result).toMatchObject({
      ok: true,
      structured: PAYLOAD,
      rawStructured: PAYLOAD,
      costUsd: 0,
      structuredOutputCalls: 1,
      terminalReason: 'completed',
      sessionId: `demo-${spec.runId}`,
    });
    expect(result.failure).toBeUndefined();
    expect(result.numTurns).toBeGreaterThan(0);
    expect(events.ofType('run_started')).toEqual([
      expect.objectContaining({
        runId: spec.runId,
        role: 'developer',
        itemId: spec.itemId,
        attempt: 1,
        model: 'demo',
        pid: process.pid,
        logPath: spec.transcriptPath,
      }),
    ]);
    expect(events.ofType('run_finished')).toEqual([
      expect.objectContaining({ runId: spec.runId, ok: true, costUsd: 0, structuredOutputCalls: 1 }),
    ]);
  });

  it('registers its .runs/ entry before the run starts and removes it once the run has finished', async () => {
    const s = scene('demo-runner-runs-');
    const runs = new RunRegistry(s.vault);
    const spec = s.spec();
    const seen: Record<string, boolean> = {};
    const events: EventSink = {
      emit: (event: FactoryEvent) => {
        seen[event.type] = existsSync(s.vault.runFile(spec.runId));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const runner = new DemoRunner({ script: { developer: WRITING_STEP }, stepDelayMs: 0, runs, events });

    await runner.run(spec, neverAborted());

    expect(seen).toEqual({ run_started: true, run_finished: true });
    expect(existsSync(s.vault.runFile(spec.runId))).toBe(false);
    expect(await runs.list()).toEqual([]);
  });

  it('checks the payload with the spec’s validator, as the real runner does: a bad one is a schema failure', async () => {
    const s = scene('demo-runner-schema-');
    const runner = new DemoRunner({ script: { pm: WRITING_STEP }, stepDelayMs: 0 });
    const spec = s.spec({ role: 'pm', validateStructured: (value) => validateAgentOutput('pm', value) });

    const result = await runner.run(spec, neverAborted());

    expect(result).toMatchObject({
      ok: false,
      failure: 'schema',
      structured: null,
      rawStructured: PAYLOAD,
      costUsd: 0,
    });
    expect(result.schemaIssues?.join('; ')).toContain('refined_requirement');
  });
});

describe('an abort', () => {
  it('during the delay returns the aborted failure and writes nothing further', async () => {
    const s = scene('demo-runner-abort-');
    const runs = new MemoryRunRegistry();
    const events = new MemoryEventLog();
    const runner = new DemoRunner({ script: { developer: WRITING_STEP }, stepDelayMs: 60_000, runs, events });
    const spec = s.spec();
    const controller = new AbortController();

    const startedAt = Date.now();
    const running = runner.run(spec, controller.signal);
    await waitUntil(() => existsSync(spec.transcriptPath) && transcriptLines(spec).length >= 6);
    controller.abort();
    const result = await running;

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result).toMatchObject({
      ok: false,
      failure: 'aborted',
      structured: null,
      terminalReason: 'aborted by caller',
    });
    expect(existsSync(path.join(s.cwd, 'src', 'answer.ts'))).toBe(false);
    expect(kinds(toSteps(transcriptLines(spec)))).toEqual([
      'start',
      'say',
      'tool:Read',
      'tool_result',
      'tool:Read',
      'tool_result',
    ]);
    expect(events.ofType('run_finished')).toEqual([expect.objectContaining({ ok: false, failure: 'aborted' })]);
    expect(runs.completed).toEqual([spec.runId]);
    expect(runs.live.size).toBe(0);
  });

  it('that came before the run does not wait at all', async () => {
    const s = scene('demo-runner-preabort-');
    const runner = new DemoRunner({ script: { developer: WRITING_STEP }, stepDelayMs: 60_000 });
    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    const result = await runner.run(s.spec(), controller.signal);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.failure).toBe('aborted');
    expect(existsSync(path.join(s.cwd, 'src', 'answer.ts'))).toBe(false);
  });
});

describe('the demo feature, step by step', () => {
  it('every step renders with no unknown steps and delivers a payload its role accepts', async () => {
    const runner = new DemoRunner({ stepDelayMs: 0 });
    for (const key of Object.keys(DEMO_SCRIPT)) {
      const [role, itemId] = key.split(':') as [Role, string | undefined];
      const s = scene(`demo-runner-${role}-`);
      const spec = s.spec({
        role,
        itemId: itemId ?? DEMO_FEATURE_ID,
        validateStructured: (value) => validateAgentOutput(role, value),
      });

      const result = await runner.run(spec, neverAborted());

      expect(result, `${key}: ${(result.schemaIssues ?? []).join('; ')}`).toMatchObject({ ok: true, costUsd: 0 });
      const steps = toSteps(transcriptLines(spec));
      expect(steps.filter((entry) => entry.kind === 'unknown'), key).toEqual([]);
      expect(steps.filter((entry) => entry.kind === 'deliver'), key).toHaveLength(1);
      expect(steps.at(-1), key).toMatchObject({ kind: 'end', ok: true, costUsd: 0 });
    }
  });
});

async function waitUntil(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

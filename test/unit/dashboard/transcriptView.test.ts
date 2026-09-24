/**
 * Stream-json → plain-language steps, fed real recorded transcripts
 * (`test/fixtures/transcripts/`, plan Phase 2, tech spec §5).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOL_RESULT_PREVIEW_CHARS } from '../../../src/dashboard/constants.js';
import { pageLines, summariseTool, toSteps } from '../../../src/dashboard/transcriptView.js';
import type { TranscriptStep } from '../../../src/dashboard/transcriptView.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'transcripts');

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function toolSteps(steps: readonly TranscriptStep[]): Extract<TranscriptStep, { kind: 'tool' }>[] {
  return steps.filter((s): s is Extract<TranscriptStep, { kind: 'tool' }> => s.kind === 'tool');
}

function resultSteps(steps: readonly TranscriptStep[]): Extract<TranscriptStep, { kind: 'tool_result' }>[] {
  return steps.filter((s): s is Extract<TranscriptStep, { kind: 'tool_result' }> => s.kind === 'tool_result');
}

describe('toSteps: real developer transcript', () => {
  const steps = toSteps(fixtureLines('developer.jsonl'));

  it('first step is start, with the model and its tools', () => {
    const first = steps[0];
    expect(first?.kind).toBe('start');
    if (first?.kind !== 'start') throw new Error('unreachable');
    expect(first.model).toBe('claude-sonnet-5');
    expect(first.tools).toContain('Bash');
    expect(first.tools).toContain('StructuredOutput');
  });

  it('last step is end, with cost and duration', () => {
    const last = steps.at(-1);
    expect(last?.kind).toBe('end');
    if (last?.kind !== 'end') throw new Error('unreachable');
    expect(last.ok).toBe(true);
    expect(last.costUsd).toBeGreaterThan(0);
    expect(last.durationMs).toBeGreaterThan(0);
  });

  it('produces no unknown steps', () => {
    expect(steps.filter((s) => s.kind === 'unknown')).toEqual([]);
  });

  it('tool_use becomes a tool step carrying a one-line summary', () => {
    const tools = toolSteps(steps);
    expect(tools.length).toBe(5); // 6 tool_use calls, 1 of them StructuredOutput
    const bash = tools.find((t) => t.name === 'Bash');
    expect(bash?.summary).toMatch(/^Ran /);
  });

  it('tool_result is paired to its tool_use by id, and a long one is truncated', () => {
    const results = resultSteps(steps);
    const tools = toolSteps(steps);
    expect(results.length).toBe(5); // the StructuredOutput call's own result is not one of these
    for (const result of results) {
      expect(tools.some((t) => t.id === result.id)).toBe(true);
    }
    const truncated = results.find((r) => r.truncated);
    expect(truncated).toBeDefined();
    expect(truncated?.preview.length).toBe(TOOL_RESULT_PREVIEW_CHARS);
    expect(results.some((r) => !r.truncated)).toBe(true);
  });

  it('the StructuredOutput call becomes a numbered deliver step', () => {
    const delivers = steps.filter((s): s is Extract<TranscriptStep, { kind: 'deliver' }> => s.kind === 'deliver');
    expect(delivers.length).toBe(1);
    expect(delivers[0]?.attempt).toBe(1);
  });

  it('a thinking block becomes a think step', () => {
    expect(steps.some((s) => s.kind === 'think')).toBe(true);
  });
});

describe('toSteps: summariseTool one-line summaries', () => {
  it('Read', () => {
    expect(summariseTool('Read', { file_path: 'src/calc.ts' })).toBe('Read src/calc.ts');
  });
  it('Bash', () => {
    expect(summariseTool('Bash', { command: 'npm test' })).toBe('Ran npm test');
  });
  it('Edit', () => {
    expect(summariseTool('Edit', { file_path: 'src/calc.ts' })).toBe('Edited src/calc.ts');
  });
  it('Write', () => {
    expect(summariseTool('Write', { file_path: 'src/new.ts' })).toBe('Edited src/new.ts');
  });
  it('Grep', () => {
    expect(summariseTool('Grep', { pattern: 'TODO' })).toBe('Searched TODO');
  });
  it('Glob', () => {
    expect(summariseTool('Glob', { pattern: '**/*.ts' })).toBe('Searched **/*.ts');
  });
});

describe('toSteps: retries and multi-role transcripts', () => {
  it('the qa transcript has more than one deliver step (a schema retry) and no unknown steps', () => {
    const steps = toSteps(fixtureLines('qa.jsonl'));
    const delivers = steps.filter((s) => s.kind === 'deliver');
    expect(delivers.length).toBeGreaterThan(1);
    expect(steps.filter((s) => s.kind === 'unknown')).toEqual([]);
  });

  it('the pm transcript (long, with a mangled StructuredOutput call) produces no unknown steps', () => {
    const steps = toSteps(fixtureLines('pm.jsonl'));
    expect(steps.filter((s) => s.kind === 'unknown')).toEqual([]);
    expect(steps.at(-1)?.kind).toBe('end');
  });
});

describe('toSteps: malformed input', () => {
  it('a malformed JSON line becomes an unknown step, not a throw', () => {
    expect(() => toSteps(['not json at all'])).not.toThrow();
    expect(toSteps(['not json at all'])).toEqual([{ kind: 'unknown', raw: 'not json at all' }]);
  });

  it('an unrecognised top-level event type becomes an unknown step, not a throw', () => {
    const line = '{"type":"a_future_event_type","itemId":"FEAT-X"}';
    expect(() => toSteps([line])).not.toThrow();
    expect(toSteps([line])).toEqual([{ kind: 'unknown', raw: line }]);
  });

  it('empty input produces no steps', () => {
    expect(toSteps([])).toEqual([]);
  });

  it('blank lines are skipped, not treated as unknown', () => {
    expect(toSteps(['', '   '])).toEqual([]);
  });
});

describe('pageLines', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);

  it('returns the last N lines when no cursor is given', () => {
    expect(pageLines(lines, undefined, 3)).toEqual(['line-7', 'line-8', 'line-9']);
  });

  it('returns the N lines before a given line', () => {
    expect(pageLines(lines, 7, 3)).toEqual(['line-4', 'line-5', 'line-6']);
  });

  it('clamps at the start of the array', () => {
    expect(pageLines(lines, 2, 5)).toEqual(['line-0', 'line-1']);
  });

  it('before:0 returns nothing', () => {
    expect(pageLines(lines, 0, 5)).toEqual([]);
  });

  it('before past the end clamps to the last N lines', () => {
    expect(pageLines(lines, 100, 3)).toEqual(['line-7', 'line-8', 'line-9']);
  });
});

describe('toSteps: ok from is_error', () => {
  it('a result event with is_error:true becomes an end step with ok:false and the terminal reason', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_max_structured_output_retries',
      terminal_reason: 'structured_output_retry_exhausted',
      total_cost_usd: 0.5,
      duration_ms: 1000,
      num_turns: 3,
    });
    expect(toSteps([line])).toEqual([
      { kind: 'end', ok: false, costUsd: 0.5, durationMs: 1000, turns: 3, reason: 'structured_output_retry_exhausted' },
    ]);
  });

  it('a tool_result with is_error:true and array content becomes ok:false with the text parts joined', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: [{ type: 'text', text: 'boom' }, { type: 'image' }],
          },
        ],
      },
    });
    expect(toSteps([line])).toEqual([{ kind: 'tool_result', id: 'toolu_1', ok: false, preview: 'boom', truncated: false }]);
  });
});

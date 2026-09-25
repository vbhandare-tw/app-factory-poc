/**
 * `factory demo`'s runner: scripted steps that write real files and a real transcript, at no cost.
 * It spawns no process, so no sandbox fences it (ADR-003); it writes only inside the run's cwd.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import { TranscriptWriter } from '../log/transcript.js';
import { DEMO_SCRIPT } from './demoScript.js';

/** The pause between scripted steps, so a watcher can see the run move. */
export const DEMO_STEP_DELAY_MS = 3_000;
import type { DemoStep } from './demoScript.js';
import { STRUCTURED_OUTPUT_TOOL, StreamCollector, interpretRun } from './streamParse.js';
import type { StreamObservation } from './streamParse.js';
import type { AgentRunResult, AgentRunSpec, Runner } from './types.js';

/** What a demo run reports as its model: no model runs. */
export const DEMO_MODEL = 'demo';

export interface DemoRunnerOptions {
  /** Keyed `<role>:<itemId>`, then `<role>`. Defaults to the demo feature. */
  readonly script?: Readonly<Record<string, DemoStep>>;
  /** Overrides `DEMO_STEP_DELAY_MS`, the pause that lets a watcher see the run move. */
  readonly stepDelayMs?: number;
  readonly runs?: RunSink;
  readonly events?: EventSink;
  readonly now?: () => string;
}

export class DemoRunner implements Runner {
  private readonly script: ReadonlyMap<string, DemoStep>;
  private readonly options: DemoRunnerOptions;

  constructor(options: DemoRunnerOptions = {}) {
    this.options = options;
    this.script = new Map(Object.entries(options.script ?? DEMO_SCRIPT));
  }

  /** An unmatched spec throws: a default step would let the wrong role pass. */
  stepFor(spec: Pick<AgentRunSpec, 'role' | 'itemId'>): DemoStep {
    const keys = [`${spec.role}:${spec.itemId}`, spec.role];
    for (const key of keys) {
      const step = this.script.get(key);
      if (step !== undefined) return step;
    }
    throw new Error(
      `the demo script has no step for ${spec.role} on ${spec.itemId}. Tried keys: ${keys.join(', ')}.`,
    );
  }

  async run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult> {
    const step = this.stepFor(spec);
    const startedAtMs = Date.now();
    const now = this.options.now ?? ((): string => new Date().toISOString());
    const transcript = new DemoTranscript(spec, await TranscriptWriter.open(spec.transcriptPath));

    try {
      await this.options.runs?.register({
        runId: spec.runId,
        role: spec.role,
        ticket: spec.itemId,
        feature: spec.featureSlug,
        attempt: spec.attempt,
        pid: process.pid,
        startedAt: now(),
        logPath: spec.transcriptPath,
      });
      await this.options.events?.emit({
        type: 'run_started',
        runId: spec.runId,
        role: spec.role,
        itemId: spec.itemId,
        attempt: spec.attempt,
        model: DEMO_MODEL,
        pid: process.pid,
        logPath: spec.transcriptPath,
      });

      const [opening, ...closing] = step.say;
      await transcript.init();
      await transcript.say(opening);
      for (const relative of step.read ?? []) await transcript.read(relative);

      const completed = await pause(this.options.stepDelayMs ?? DEMO_STEP_DELAY_MS, signal);
      if (completed) {
        for (const [relative, contents] of Object.entries(step.write ?? {})) {
          await transcript.write(relative, contents);
        }
        for (const text of closing) await transcript.say(text);
        await transcript.deliver(step.structured);
        await transcript.finish(step.structured, Date.now() - startedAtMs);
      }

      const result = interpretRun({
        observation: transcript.observation(),
        exitCode: completed ? 0 : null,
        signal: null,
        timedOut: false,
        aborted: !completed,
        durationMs: Date.now() - startedAtMs,
        validateStructured: spec.validateStructured,
      });
      await this.options.events?.emit({
        type: 'run_finished',
        runId: spec.runId,
        role: spec.role,
        ok: result.ok,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        durationMs: result.durationMs,
        terminalReason: result.terminalReason,
        structuredOutputCalls: result.structuredOutputCalls,
      });
      return result;
    } finally {
      await transcript.close();
      await this.options.runs?.complete(spec.runId);
    }
  }
}

/** Writes the stream-json lines a real run would, and reads them back as the real runner does. */
class DemoTranscript {
  private readonly spec: AgentRunSpec;
  private readonly sink: TranscriptWriter;
  private readonly sessionId: string;
  private readonly collector = new StreamCollector();
  private tools = 0;
  private turns = 0;

  constructor(spec: AgentRunSpec, sink: TranscriptWriter) {
    this.spec = spec;
    this.sink = sink;
    this.sessionId = `demo-${spec.runId}`;
  }

  init(): Promise<void> {
    return this.line({
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      model: DEMO_MODEL,
      tools: [...this.spec.profile.tools],
      demo: true,
    });
  }

  say(text: string): Promise<void> {
    return this.assistant({ type: 'text', text });
  }

  async read(relative: string): Promise<void> {
    const file = inside(this.spec.cwd, relative);
    const id = await this.toolUse('Read', { file_path: file });
    const contents = await readFile(file, 'utf8').catch(() => null);
    await this.toolResult(id, contents ?? `File does not exist: ${file}`, contents === null);
  }

  async write(relative: string, contents: string): Promise<void> {
    const file = inside(this.spec.cwd, relative);
    const id = await this.toolUse('Write', { file_path: file, content: contents });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
    await this.toolResult(id, `File created successfully at: ${file}`, false);
  }

  async deliver(structured: unknown): Promise<void> {
    const id = await this.toolUse(STRUCTURED_OUTPUT_TOOL, structured);
    await this.toolResult(id, 'Structured output provided successfully', false);
  }

  finish(structured: unknown, durationMs: number): Promise<void> {
    return this.line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: durationMs,
      num_turns: this.turns,
      total_cost_usd: 0,
      session_id: this.sessionId,
      terminal_reason: 'completed',
      structured_output: structured,
      demo: true,
    });
  }

  observation(): StreamObservation {
    return this.collector.observation();
  }

  close(): Promise<void> {
    return this.sink.close().catch(() => undefined);
  }

  private async toolUse(name: string, input: unknown): Promise<string> {
    this.tools += 1;
    const id = `toolu_demo_${this.spec.runId}_${this.tools}`;
    await this.assistant({ type: 'tool_use', id, name, input });
    return id;
  }

  private toolResult(id: string, content: string, isError: boolean): Promise<void> {
    return this.line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
      },
    });
  }

  private assistant(block: Record<string, unknown>): Promise<void> {
    this.turns += 1;
    return this.line({ type: 'assistant', message: { role: 'assistant', content: [block] } });
  }

  private async line(event: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(event);
    this.collector.onLine(text);
    await this.sink.writeLine(text);
  }
}

/** The script's own path, refused if it would land outside the run's working directory. */
function inside(cwd: string, relative: string): string {
  const root = path.resolve(cwd);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`the demo script names ${relative}, which is outside the run's working directory ${root}`);
  }
  return file;
}

/** `true` once `ms` has passed; `false` as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

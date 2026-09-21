/**
 * The real `Runner`: spawns Claude Code and reads its JSONL stream
 * (spec §4.4, §8.1; plan resolution A1).
 *
 * Four things in here are load-bearing and each was learned the hard way:
 *
 * 1. **`stdio[0]` must be `'ignore'`.** Inheriting stdin makes the CLI stall
 *    three seconds waiting for piped input and emit a warning (spec §4.4).
 * 2. **`detached: true`, and kills go to the process *group*.** The agent's
 *    Bash tool spawns grandchildren. `child.kill()` reaps only the CLI and
 *    leaves whatever it started running on the operator's machine — long after
 *    the test that spawned it has finished and reported green.
 * 3. **Every stream line reaches the transcript before the run ends.** M7 tails
 *    it live; buffering to completion would make that impossible to retrofit.
 * 4. **A stream with no terminal `result` event is a crash, never a success.**
 *    See `interpretRun`.
 *
 * The sandbox itself is built in `settings.ts`; nothing in this file may widen
 * it (plan Section E item 6).
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import type { TranscriptSink } from '../log/transcript.js';
import { TranscriptWriter } from '../log/transcript.js';
import { buildClaudeArgv } from './argv.js';
import { buildSandboxSettings, sandboxEnv, sandboxSettingsJson } from './settings.js';
import type { SandboxConfigView } from './settings.js';
import { JsonlLineSplitter, StreamCollector, interpretRun } from './streamParse.js';
import type { AgentRunResult, AgentRunSpec, Runner } from './types.js';

/**
 * The child shape `stdio: ['ignore', 'pipe', 'pipe']` produces: no stdin, both
 * output streams readable.
 */
export type AgentChild = ChildProcessByStdio<null, Readable, Readable>;

/** Grace between `SIGTERM` and `SIGKILL` (spec §8.1). */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/** How much stderr is kept for the failure message. */
const STDERR_TAIL_CHARS = 4_000;

export interface ClaudeCodeRunnerOptions {
  readonly config: SandboxConfigView;
  /**
   * The target repo. Required for any role whose cwd is a worktree — without it
   * `buildSandboxSettings` refuses rather than emitting an unfenced object.
   */
  readonly repoRoot?: string;
  /** Executable name. Overridden by `runner-stub.test.ts`. */
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runs?: RunSink;
  readonly events?: EventSink;
  readonly killGraceMs?: number;
  /** Test seam. Production always writes a real file. */
  readonly openTranscript?: (spec: AgentRunSpec) => Promise<TranscriptSink>;
  readonly now?: () => string;
}

export class ClaudeCodeRunner implements Runner {
  private readonly options: ClaudeCodeRunnerOptions;

  constructor(options: ClaudeCodeRunnerOptions) {
    this.options = options;
  }

  async run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const command = this.options.command ?? 'claude';
    const killGraceMs = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const now = this.options.now ?? ((): string => new Date().toISOString());

    // Built before anything is spawned or opened: a bad fence must abort the
    // run, not leave a transcript and a `.runs` entry behind.
    const settings = buildSandboxSettings(
      spec.profile,
      spec.cwd,
      this.options.config,
      this.options.repoRoot,
    );
    const argv = buildClaudeArgv(spec, sandboxSettingsJson(settings));

    const transcript = await (this.options.openTranscript?.(spec) ??
      TranscriptWriter.open(spec.transcriptPath));

    const collector = new StreamCollector();
    const splitter = new JsonlLineSplitter();
    const stderrSplitter = new JsonlLineSplitter();
    let stderrTail = '';
    let registered = false;
    let child: AgentChild | null = null;

    try {
      if (signal.aborted) {
        return await this.finish(spec, transcript, registered, {
          observation: collector.observation(),
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: true,
          durationMs: Date.now() - startedAtMs,
          validateStructured: spec.validateStructured,
          stderrTail: 'aborted before spawn',
        });
      }

      const spawned = spawn(command, argv, {
        cwd: spec.cwd,
        // stdin ignored: see the header note. stdout/stderr piped so the
        // transcript can be written while the run is still going.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sandboxEnv(this.options.env ?? process.env),
        // Own process group, so a timeout kills the agent's grandchildren too.
        detached: true,
      });
      if (spawned.stdout === null || spawned.stderr === null) {
        throw new Error(`spawn of ${command} produced no stdout/stderr pipe`);
      }
      child = spawned;

      const pid = child.pid ?? null;

      if (this.options.runs !== undefined) {
        await this.options.runs.register({
          runId: spec.runId,
          role: spec.role,
          ticket: spec.itemId,
          feature: spec.featureSlug,
          attempt: spec.attempt,
          pid,
          startedAt: now(),
          logPath: spec.transcriptPath,
        });
        registered = true;
      }

      await this.options.events?.emit({
        type: 'run_started',
        runId: spec.runId,
        role: spec.role,
        itemId: spec.itemId,
        attempt: spec.attempt,
        model: spec.model,
        pid,
        logPath: spec.transcriptPath,
      });

      const writes: Promise<void>[] = [];

      const handleLine = (line: string): void => {
        writes.push(transcript.writeLine(line));
        const event = collector.onLine(line);
        if (event === null) {
          void this.options.events?.emit({
            type: 'run_stream_malformed',
            runId: spec.runId,
            line: line.slice(0, 500),
          });
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) handleLine(line);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
        for (const line of stderrSplitter.push(chunk)) {
          // Kept as JSON so the transcript stays valid JSONL end to end — a
          // tailing reader can parse every line without special-casing stderr.
          writes.push(transcript.writeLine(JSON.stringify({ type: 'stderr', text: line })));
          void this.options.events?.emit({
            type: 'run_stderr',
            runId: spec.runId,
            text: line.slice(0, 500),
          });
        }
      });

      const outcome = await this.awaitExit(child, spec, signal, killGraceMs);

      for (const line of splitter.flush()) handleLine(line);
      for (const line of stderrSplitter.flush()) {
        writes.push(transcript.writeLine(JSON.stringify({ type: 'stderr', text: line })));
      }
      await Promise.allSettled(writes);

      return await this.finish(spec, transcript, registered, {
        observation: collector.observation(),
        exitCode: outcome.code,
        signal: outcome.signal,
        timedOut: outcome.killReason === 'timeout',
        aborted: outcome.killReason === 'aborted',
        durationMs: Date.now() - startedAtMs,
        validateStructured: spec.validateStructured,
        stderrTail,
      });
    } catch (error) {
      // A spawn failure (ENOENT on `claude`) is a crash, not an exception the
      // orchestrator has to catch: the loop must keep running.
      return await this.finish(spec, transcript, registered, {
        observation: collector.observation(),
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAtMs,
        validateStructured: spec.validateStructured,
        stderrTail: `${stderrTail}${stderrTail.length > 0 ? '\n' : ''}${String(error)}`,
      });
    }
  }

  /**
   * Wait for exit, enforcing the profile timeout and the caller's abort signal.
   *
   * Both paths go SIGTERM → grace → SIGKILL, and both target the process group.
   * `settled` guards against a second kill after the child has already gone,
   * which on a recycled PID would signal an unrelated process.
   */
  private awaitExit(
    child: AgentChild,
    spec: AgentRunSpec,
    signal: AbortSignal,
    killGraceMs: number,
  ): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    killReason: 'timeout' | 'aborted' | null;
  }> {
    const events = this.options.events;
    return new Promise((resolve) => {
      // Whichever of the two fired FIRST. Not two booleans: a timeout that is
      // then followed by an abort during the SIGTERM grace is still a timeout,
      // and recording both would make the caller guess.
      let killReason: 'timeout' | 'aborted' | null = null;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const requestKill = (reason: 'timeout' | 'aborted'): void => {
        if (settled) return;
        killReason ??= reason;
        killGroup(child, 'SIGTERM');
        void events?.emit({
          type: 'run_killed',
          runId: spec.runId,
          signal: 'SIGTERM',
          reason,
          pid: child.pid ?? null,
        });
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          if (settled) return;
          killGroup(child, 'SIGKILL');
          void events?.emit({
            type: 'run_killed',
            runId: spec.runId,
            signal: 'SIGKILL',
            reason: 'grace_expired',
            pid: child.pid ?? null,
          });
        }, killGraceMs);
        graceTimer.unref();
      };

      const timeoutTimer = setTimeout(() => {
        requestKill('timeout');
      }, spec.profile.timeoutMs);

      const onAbort = (): void => requestKill('aborted');
      signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        signal.removeEventListener('abort', onAbort);
      };

      child.once('error', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ code: null, signal: null, killReason });
      });

      child.once('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ code, signal: closeSignal, killReason });
      });
    });
  }

  private async finish(
    spec: AgentRunSpec,
    transcript: TranscriptSink,
    registered: boolean,
    input: Parameters<typeof interpretRun>[0],
  ): Promise<AgentRunResult> {
    const result = interpretRun(input);
    await transcript.close().catch(() => undefined);
    if (registered) await this.options.runs?.complete(spec.runId);
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
  }
}

/**
 * Signal the child's whole process group.
 *
 * `spawn({ detached: true })` makes the child a group leader, so `-pid`
 * addresses it and everything its Bash tool started. Falls back to signalling
 * the child alone if the group is already gone.
 */
export function killGroup(child: AgentChild, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already reaped. Nothing to do, and nothing worth failing a run over.
    }
  }
}

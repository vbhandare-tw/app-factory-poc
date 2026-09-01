/**
 * The orchestrator event log (spec §12).
 *
 * One JSONL line per decision in `<vault>/logs/orchestrator.jsonl`. Line
 * buffered rather than batched for the same reason as the transcript: M7 tails
 * it, and a crash must not take the last few decisions with it.
 *
 * `FactoryEvent` is a closed union on purpose. Later phases add their own
 * members here rather than passing free-form objects, so this file stays the
 * catalogue of everything the factory can say about itself. A `Record<string,
 * unknown>` escape hatch would make that catalogue decorative within one phase.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { WriteStream } from 'node:fs';

import type { Role } from '../domain/roles.js';
import type { AgentFailure } from '../runner/types.js';

/** Events emitted by the runner and run registry (Phase 5). */
export type RunEvent =
  | {
      readonly type: 'run_started';
      readonly runId: string;
      readonly role: Role;
      readonly itemId: string;
      readonly attempt: number;
      readonly model: string;
      readonly pid: number | null;
      readonly logPath: string;
    }
  | {
      readonly type: 'run_finished';
      readonly runId: string;
      readonly role: Role;
      readonly ok: boolean;
      readonly failure?: AgentFailure;
      readonly costUsd: number;
      readonly numTurns: number;
      readonly durationMs: number;
      readonly terminalReason: string;
    }
  | {
      /** A stream line that was not parseable JSON. Skipped, never fatal. */
      readonly type: 'run_stream_malformed';
      readonly runId: string;
      readonly line: string;
    }
  | {
      readonly type: 'run_stderr';
      readonly runId: string;
      readonly text: string;
    }
  | {
      readonly type: 'run_killed';
      readonly runId: string;
      readonly signal: string;
      readonly reason: 'timeout' | 'aborted' | 'grace_expired';
      readonly pid: number | null;
    }
  | {
      /** A `.runs` entry left behind by a crashed orchestrator, removed at startup. */
      readonly type: 'run_swept';
      readonly runId: string;
      readonly pid: number | null;
    };

/**
 * Everything the factory can log.
 *
 * Later phases widen this union — `| LoopEvent | GateEvent | ...` — rather than
 * loosening the type.
 */
export type FactoryEvent = RunEvent;

/** The written line: the event plus the timestamp the log adds. */
export type LoggedEvent = FactoryEvent & { readonly ts: string };

export interface EventSink {
  emit(event: FactoryEvent): Promise<void>;
  close(): Promise<void>;
}

export interface EventLogOptions {
  /** Injected so recorded times are deterministic in tests (as `CliDeps.now` is). */
  readonly now?: () => string;
}

export class EventLog implements EventSink {
  readonly path: string;
  private readonly stream: WriteStream;
  private readonly now: () => string;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, stream: WriteStream, now: () => string) {
    this.path = filePath;
    this.stream = stream;
    this.now = now;
  }

  static async open(filePath: string, options: EventLogOptions = {}): Promise<EventLog> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const stream = createWriteStream(resolved, { flags: 'a', encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    return new EventLog(resolved, stream, options.now ?? ((): string => new Date().toISOString()));
  }

  emit(event: FactoryEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`event log ${this.path} is already closed`));
    }
    const line = `${JSON.stringify({ ts: this.now(), ...event })}\n`;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/** In-memory sink for tests and for runners constructed without a vault. */
export class MemoryEventLog implements EventSink {
  readonly events: LoggedEvent[] = [];
  private readonly now: () => string;

  constructor(now: () => string = (): string => new Date().toISOString()) {
    this.now = now;
  }

  emit(event: FactoryEvent): Promise<void> {
    this.events.push({ ts: this.now(), ...event } as LoggedEvent);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  ofType<T extends FactoryEvent['type']>(type: T): Extract<LoggedEvent, { type: T }>[] {
    return this.events.filter((event) => event.type === type) as Extract<LoggedEvent, { type: T }>[];
  }
}

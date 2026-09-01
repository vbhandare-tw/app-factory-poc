/**
 * Per-run transcript files (spec §12).
 *
 * `logs/<feature-slug>/<item-id>-<attempt>-<role>.log`, one JSONL line per
 * stream event, written **as the run proceeds**. That is the whole point of
 * this module: M7's live tail depends on a reader being able to open the file
 * mid-run and see completed lines, and buffering to completion would cost
 * nothing today and be impossible to retrofit later without changing the
 * runner's shape.
 *
 * `writeLine` returns a promise that settles when the write callback fires, so
 * the bytes have reached the file descriptor before the caller continues. A
 * fire-and-forget `stream.write()` would usually be fine and would occasionally
 * lose ordering under back-pressure — and "occasionally" is the worst possible
 * property for a debugging artefact.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { WriteStream } from 'node:fs';

export interface TranscriptSink {
  writeLine(line: string): Promise<void>;
  close(): Promise<void>;
}

export class TranscriptWriter implements TranscriptSink {
  readonly path: string;
  private readonly stream: WriteStream;
  private closed = false;
  /** Serialises writes so lines land in call order even under back-pressure. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, stream: WriteStream) {
    this.path = filePath;
    this.stream = stream;
  }

  /** Create the parent directory and open the file for appending. */
  static async open(filePath: string): Promise<TranscriptWriter> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const stream = createWriteStream(resolved, { flags: 'a', encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    return new TranscriptWriter(resolved, stream);
  }

  writeLine(line: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`transcript ${this.path} is already closed`));
    }
    const text = line.endsWith('\n') ? line : `${line}\n`;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(text, (error) => (error ? reject(error) : resolve()));
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

/** A sink that keeps lines in memory. For unit tests and for `MockRunner` defaults. */
export class MemoryTranscript implements TranscriptSink {
  readonly lines: string[] = [];
  closed = false;

  writeLine(line: string): Promise<void> {
    this.lines.push(line.endsWith('\n') ? line.slice(0, -1) : line);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

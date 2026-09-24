/**
 * The file-side change sources (tech spec §4.2): a JSONL tail for the event log
 * and for transcripts, and a debounced watch over the vault's work files.
 */
import { existsSync, watch } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { featureId } from '../domain/ids.js';
import { readInstanceLock } from '../orchestrator/lock.js';
import { JsonlLineSplitter } from '../runner/streamParse.js';
import { VaultPaths } from '../vault/paths.js';
import { TAIL_POLL_MS, WATCH_DEBOUNCE_MS } from './constants.js';
import { confine } from './security.js';
import { FRESH_STEP_CARRY, toSteps } from './transcriptView.js';
import type { StepCarry, TranscriptStep } from './transcriptView.js';

type ErrorHandler = (error: unknown) => void;

interface Closable {
  close(): void;
}

/**
 * Changed paths under one directory, from a single recursive watch shared by
 * every consumer. On macOS each new watcher restarts one shared FSEvents stream,
 * and events that land during a restart are lost.
 */
export class DirectoryEvents {
  readonly root: string;
  private readonly listeners = new Set<{ readonly listener: (name: string | null) => void }>();
  private readonly watcher: Closable;

  constructor(root: string, onError: ErrorHandler = (): void => undefined) {
    this.root = path.resolve(root);
    const watcher = watch(this.root, { recursive: true }, (_event, name) => {
      for (const entry of [...this.listeners]) {
        if (!this.listeners.has(entry)) continue;
        try {
          entry.listener(name);
        } catch (error) {
          onError(error);
        }
      }
    });
    watcher.on('error', onError);
    this.watcher = watcher;
  }

  /** `name` is relative to the root, or `null` when the platform did not say which path changed. */
  on(listener: (name: string | null) => void): () => void {
    const entry = { listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  close(): void {
    this.listeners.clear();
    this.watcher.close();
  }
}

export interface JsonlTail {
  /** Byte offset of the first byte not yet read. */
  readonly offset: number;
  /** Read what is on disk now and deliver every complete line in it. */
  drain(): Promise<void>;
  /** Stop watching; nothing more is delivered. Idempotent. */
  close(): void;
}

export interface TailOptions {
  readonly onError?: ErrorHandler;
  /** Listen here rather than opening a watcher of its own. */
  readonly events?: DirectoryEvents;
}

interface FollowOptions extends TailOptions {
  /** The path to read, looked up before every read; `null` reads as "not there yet". */
  readonly resolve?: () => Promise<string | null>;
  readonly onReset?: () => void;
}

/** Follow a JSONL file from `fromOffset`: each complete line once, a partial one when its newline lands. */
export function tailJsonl(
  file: string,
  fromOffset: number,
  onLine: (line: string) => void,
  options: TailOptions = {},
): JsonlTail {
  return new LineFollower(file, fromOffset, (lines) => lines.forEach((line) => onLine(line)), options);
}

class LineFollower implements JsonlTail {
  offset: number;
  private readonly file: string;
  private readonly onLines: (lines: string[]) => void;
  private readonly options: FollowOptions;
  private readonly watcher: Closable | null = null;
  private readonly poll: NodeJS.Timeout;
  private splitter = new JsonlLineSplitter();
  private decoder = new StringDecoder('utf8');
  private pass: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(file: string, fromOffset: number, onLines: (lines: string[]) => void, options: FollowOptions) {
    this.file = file;
    this.offset = fromOffset;
    this.onLines = onLines;
    this.options = options;
    try {
      this.watcher =
        options.events === undefined
          ? watchFile(file, () => this.schedule(), (error) => this.fail(error))
          : listenFor(options.events, file, () => this.schedule());
    } catch (error) {
      this.fail(error);
    }
    this.poll = setInterval(() => this.schedule(), TAIL_POLL_MS);
    this.schedule();
  }

  drain(): Promise<void> {
    this.schedule();
    return this.pass ?? Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    this.watcher?.close();
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.pass !== null) {
      this.again = true;
      return;
    }
    this.pass = this.loop().finally(() => {
      this.pass = null;
    });
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.readOnce();
      } catch (error) {
        this.fail(error);
      }
    } while (this.again && !this.closed);
  }

  private async readOnce(): Promise<void> {
    const target = this.options.resolve === undefined ? this.file : await this.options.resolve();
    const size = target === null ? null : await fileSize(target);
    if (this.closed || target === null || size === null) {
      if (!this.closed && this.offset > 0) this.reset();
      return;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return;

    const length = size - this.offset;
    const buffer = Buffer.alloc(length);
    let read = 0;
    const handle = await open(target, 'r');
    try {
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, this.offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    this.offset += read;
    const lines = this.splitter.push(this.decoder.write(buffer.subarray(0, read)));
    if (!this.closed && lines.length > 0) this.onLines(lines);
  }

  /** Truncated or gone: start again from the top of whatever is there next. */
  private reset(): void {
    this.offset = 0;
    this.splitter = new JsonlLineSplitter();
    this.decoder = new StringDecoder('utf8');
    this.options.onReset?.();
  }

  private fail(error: unknown): void {
    this.options.onError?.(error);
  }
}

/** The file's size in bytes, or `null` when it does not exist. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function listenFor(events: DirectoryEvents, file: string, onChange: () => void): Closable {
  const name = path.relative(events.root, path.resolve(file));
  const off = events.on((changed) => {
    if (changed === null || changed === name) onChange();
  });
  return { close: off };
}

/** Watch `file` through its directory; a directory not made yet is waited for from its parent. */
function watchFile(file: string, onChange: () => void, onError: ErrorHandler): Closable {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (existsSync(dir)) {
    const watcher = watch(dir, (_event, name) => {
      if (name === null || name === base) onChange();
    });
    watcher.on('error', onError);
    return watcher;
  }

  let inner: Closable | null = null;
  let closed = false;
  const parent = watch(path.dirname(dir), (_event, name) => {
    if (closed || inner !== null || (name !== null && name !== path.basename(dir)) || !existsSync(dir)) return;
    try {
      inner = watchFile(file, onChange, onError);
    } catch (error) {
      onError(error);
      return;
    }
    onChange();
  });
  parent.on('error', onError);
  return {
    close: () => {
      closed = true;
      parent.close();
      inner?.close();
    },
  };
}

// ---------------------------------------------------------------------------

export interface VaultWatch {
  /** Resolves once the lock's owner is known, so the first lock change is judged against it. */
  readonly ready: Promise<void>;
  /** Count a change that no file shows (a host lifecycle change) in the current window. */
  touch(itemIds?: readonly string[]): void;
  close(): void;
}

export interface VaultWatchOptions {
  readonly debounceMs?: number;
  readonly onError?: ErrorHandler;
  /** Listen here rather than opening a watcher of its own; it must be rooted at the vault. */
  readonly events?: DirectoryEvents;
}

/**
 * One `state_changed` per window of `WATCH_DEBOUNCE_MS` over the vault's work
 * files, `.runs/`, `.kill` and the instance lock, with the item ids it touched.
 */
export function watchVault(
  paths: VaultPaths,
  onChange: (itemIds: readonly string[]) => void,
  options: VaultWatchOptions = {},
): VaultWatch {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const onError = options.onError ?? ((): void => undefined);
  const classify = classifier(paths);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let owner: number | null = null;

  const flush = (): void => {
    timer = null;
    if (closed) return;
    const itemIds = [...pending].sort();
    pending.clear();
    onChange(itemIds);
  };
  const count = (itemIds: readonly string[]): void => {
    if (closed) return;
    for (const id of itemIds) pending.add(id);
    timer ??= setTimeout(flush, debounceMs);
  };

  const readOwner = async (): Promise<number | null> =>
    (await readInstanceLock(paths.instanceLock())).record?.pid ?? null;
  // Serialised, so each read is judged against the one before it. A heartbeat
  // rewrites the lock every poll_interval without changing its owner.
  let lockReads: Promise<void> = readOwner().then((pid) => {
    owner = pid;
  }, onError);
  const ready = lockReads;

  const onName = (name: string | null): void => {
    if (closed) return;
    const change = classify(name);
    if (change === 'lock') {
      lockReads = lockReads
        .then(async () => {
          const pid = await readOwner();
          if (pid === owner) return;
          owner = pid;
          count([]);
        })
        .catch(onError);
    } else if (change !== null) {
      count(change);
    }
  };
  const events = options.events ?? new DirectoryEvents(paths.root, onError);
  const off = events.on(onName);
  const watcher: Closable = options.events === undefined ? events : { close: off };

  return {
    ready,
    touch: (itemIds = []) => count(itemIds),
    close: () => {
      if (closed) return;
      closed = true;
      watcher.close();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

type Change = readonly string[] | 'lock' | null;

function classifier(paths: VaultPaths): (name: string | null) => Change {
  const relative = (file: string): string => path.relative(paths.root, file);
  const lock = relative(paths.instanceLock());
  const kill = relative(paths.killFile());
  const runs = relative(paths.runsDir());
  const features = relative(paths.featuresDir());

  return (name) => {
    if (name === null) return [];
    if (name === lock) return 'lock';
    if (name === kill || name === runs || name.startsWith(`${runs}${path.sep}`)) return [];
    if (name === features || features.startsWith(`${name}${path.sep}`)) return [];
    if (name.startsWith(`${features}${path.sep}`)) return itemIdsFor(name.slice(features.length + 1).split(path.sep));
    return null;
  };
}

/** `<slug>/…` → the feature; `<slug>/tickets/<id>.md…` (or its temp file) → the ticket. */
function itemIdsFor(parts: readonly string[]): readonly string[] {
  const [slug, sub, file] = parts;
  if (slug === undefined || !VaultPaths.isSafeSegment(slug)) return [];
  if (sub === 'tickets' && file !== undefined && file.includes('.md')) {
    const ticket = file.slice(0, file.indexOf('.md'));
    return VaultPaths.isSafeSegment(ticket) ? [ticket] : [featureId(slug)];
  }
  return [featureId(slug)];
}

// ---------------------------------------------------------------------------

export interface TranscriptChunk {
  /** Index, from 0, of the chunk's first transcript line; that line may itself show no step. */
  readonly firstLine: number;
  readonly steps: readonly TranscriptStep[];
}

export interface TranscriptFollowerOptions {
  /** Every read is confined to it: a transcript that resolves elsewhere reads as missing. */
  readonly logsDir: string;
  readonly onSteps: (runId: string, chunk: TranscriptChunk) => void;
  readonly onError?: ErrorHandler;
}

export interface Following {
  /** Resolves once the tail has fixed where it starts: the end of the transcript as it was. */
  readonly ready: Promise<void>;
  /** Idempotent. The last release closes the tail. */
  release(): void;
}

interface SharedTail {
  refs: number;
  closed: boolean;
  follower: LineFollower | null;
  ready: Promise<void>;
}

/** One tail per followed run, shared by every subscriber to it (tech spec §5, `?run=`). */
export class TranscriptFollower {
  private readonly options: TranscriptFollowerOptions;
  private readonly tails = new Map<string, SharedTail>();
  private readonly openFollowers = new Set<LineFollower>();
  private events: DirectoryEvents | null = null;

  constructor(options: TranscriptFollowerOptions) {
    this.options = options;
  }

  /** Tails started from now on listen here instead of opening watchers of their own. */
  useEvents(events: DirectoryEvents | null): void {
    this.events = events;
  }

  get openTails(): number {
    return this.openFollowers.size;
  }

  isFollowing(runId: string): boolean {
    return this.tails.has(runId);
  }

  follow(runId: string, file: string): Following {
    let tail = this.tails.get(runId);
    if (tail === undefined) {
      const created: SharedTail = { refs: 0, closed: false, follower: null, ready: Promise.resolve() };
      created.ready = this.start(runId, file, created).catch((error: unknown) => this.options.onError?.(error));
      this.tails.set(runId, created);
      tail = created;
    }
    const shared = tail;
    shared.refs += 1;
    let released = false;
    return {
      ready: shared.ready,
      release: () => {
        if (released) return;
        released = true;
        shared.refs -= 1;
        if (shared.refs === 0) this.shut(runId, shared);
      },
    };
  }

  closeAll(): void {
    for (const [runId, tail] of [...this.tails]) this.shut(runId, tail);
  }

  private async start(runId: string, file: string, tail: SharedTail): Promise<void> {
    const resolve = (): Promise<string | null> => confine(file, [this.options.logsDir]);
    const real = await resolve();
    const from = real === null ? NOTHING_READ : await completeLinesOf(real);
    if (tail.closed) return;

    let nextLine = from.lines;
    let carry = from.carry;
    const follower = new LineFollower(
      file,
      from.offset,
      (lines) => {
        const firstLine = nextLine;
        nextLine += lines.length;
        const next = toSteps(lines, carry);
        carry = next.carry;
        if (next.steps.length > 0) this.options.onSteps(runId, { firstLine, steps: next.steps });
      },
      {
        resolve,
        onReset: () => {
          nextLine = 0;
          carry = FRESH_STEP_CARRY;
        },
        ...(this.options.onError === undefined ? {} : { onError: this.options.onError }),
        ...(this.events === null ? {} : { events: this.events }),
      },
    );
    tail.follower = follower;
    this.openFollowers.add(follower);
  }

  private shut(runId: string, tail: SharedTail): void {
    tail.closed = true;
    if (this.tails.get(runId) === tail) this.tails.delete(runId);
    if (tail.follower !== null) {
      tail.follower.close();
      this.openFollowers.delete(tail.follower);
    }
  }
}

interface ReadSoFar {
  readonly offset: number;
  readonly lines: number;
  readonly carry: StepCarry;
}

const NOTHING_READ: ReadSoFar = { offset: 0, lines: 0, carry: FRESH_STEP_CARRY };

/** Where the complete lines end, how many there are (numbered as the transcript endpoint numbers them), and their carry. */
async function completeLinesOf(file: string): Promise<ReadSoFar> {
  const bytes = await readFile(file).catch(() => null);
  if (bytes === null) return NOTHING_READ;
  const offset = bytes.lastIndexOf(0x0a) + 1;
  const complete = new JsonlLineSplitter().push(bytes.subarray(0, offset).toString('utf8'));
  return { offset, lines: complete.length, carry: toSteps(complete, FRESH_STEP_CARRY).carry };
}

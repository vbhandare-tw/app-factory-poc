/**
 * One per dashboard process (tech spec §4.1): the orchestrator hosted here, if
 * any, which of the three modes the vault is in, and the live-update sources.
 */
import type { VaultScope } from '../cli/resolve.js';
import type { StartupFailure } from '../config/validate.js';
import type { EventSink } from '../log/events.js';
import { startOrchestrator, StartupRefused } from '../orchestrator/host.js';
import type {
  OrchestratorHandle,
  OrchestratorHostDeps,
  StartOrchestratorInput,
} from '../orchestrator/host.js';
import { InstanceLockHeldError } from '../orchestrator/lock.js';
import type { LivenessCheck } from '../orchestrator/lock.js';
import { ChangeBus } from './changeBus.js';
import { MODE_CHECK_MS } from './constants.js';
import { parseEvent, readLockView } from './handlers/read.js';
import type { DashboardMode, HostStatusView, LockView } from './handlers/read.js';
import { summariseEvent } from './labels.js';
import { Mutex } from './mutex.js';
import { TeeEventSink } from './teeEvents.js';
import { DirectoryEvents, fileSize, tailJsonl, TranscriptFollower, watchVault } from './watchers.js';
import type { JsonlTail, VaultWatch } from './watchers.js';

export type HostStateCode = 'already_hosted' | 'external' | 'not_hosted' | 'starting';

/** The request does not fit the mode the vault is in. The HTTP layer answers 409. */
export class HostStateError extends Error {
  readonly code: HostStateCode;

  constructor(code: HostStateCode, message: string) {
    super(message);
    this.name = 'HostStateError';
    this.code = code;
  }
}

export interface DashboardHostOptions {
  readonly scope: VaultScope;
  readonly deps: OrchestratorHostDeps;
  readonly startOrchestrator?: (input: StartOrchestratorInput) => Promise<OrchestratorHandle>;
  readonly isAlive?: LivenessCheck;
  readonly selfPid?: number;
  readonly log?: (line: string) => void;
  /** Overrides `MODE_CHECK_MS`. */
  readonly modeCheckMs?: number;
}

interface PendingSleep {
  readonly timer: NodeJS.Timeout;
  readonly resolve: () => void;
}

interface LiveSources {
  /** The one OS watcher this host opens; everything below listens to it. */
  readonly events: DirectoryEvents;
  readonly vault: VaultWatch;
  /** The event-log tail; open only while nothing is hosted here, because the tee covers hosted runs. */
  tail: JsonlTail | null;
}

export class DashboardHost {
  readonly scope: VaultScope;
  /** Serialises dashboard POSTs against each other. Never held while a run drains. */
  readonly mutex = new Mutex();
  /** Every live change, fanned out to SSE clients and the run index (tech spec §4.2). */
  readonly bus: ChangeBus;
  /** Transcript tails for `/api/stream?run=`, one per run however many clients follow it. */
  readonly transcripts: TranscriptFollower;

  private readonly options: DashboardHostOptions;
  private readonly startFn: (input: StartOrchestratorInput) => Promise<OrchestratorHandle>;
  private handle: OrchestratorHandle | null = null;
  private controller: AbortController | null = null;
  private starting: Promise<void> | null = null;
  private settled: Promise<void> = Promise.resolve();
  private stopRequested = false;
  private pendingSleep: PendingSleep | null = null;
  private wakeLatched = false;
  private lastError: string | null = null;
  private startupFailures: readonly StartupFailure[] = [];
  private live: LiveSources | null = null;
  private tailOps: Promise<void> = Promise.resolve();
  /** Where the event-log tail picks up once nothing is hosted: past every line the tee published. */
  private resumeAt: number | null = null;
  private modeTimer: NodeJS.Timeout | null = null;
  /** The mode as of the last `state_changed`, which made the page refetch it. */
  private announcedMode: DashboardMode | null = null;

  constructor(options: DashboardHostOptions) {
    this.options = options;
    this.scope = options.scope;
    this.startFn = options.startOrchestrator ?? startOrchestrator;
    this.bus = new ChangeBus({ onError: this.onLiveError });
    this.transcripts = new TranscriptFollower({
      logsDir: options.scope.paths.logsDir(),
      onSteps: (runId, chunk) => this.bus.emit({ kind: 'transcript_line', runId, ...chunk }),
      onError: this.onLiveError,
    });
  }

  /** An orchestrator is starting, running or draining in this process. */
  get hosting(): boolean {
    return this.handle !== null || this.starting !== null;
  }

  /** A live foreign pid is `external` whatever its heartbeat age (plan A8). */
  async lockView(): Promise<LockView> {
    const view = await this.fileView();
    if (this.hosting) return { ...view, mode: 'hosted' };
    // Our own pid on a lock this host does not hold is a leftover, not a live instance.
    return view.mode === 'hosted' ? { ...view, mode: 'stopped' } : view;
  }

  async mode(): Promise<DashboardMode> {
    return (await this.lockView()).mode;
  }

  /** The hosted orchestrator's event sink (the tee), for actions taken here; `undefined` when nothing is hosted. */
  events(): EventSink | undefined {
    return this.handle?.events;
  }

  /**
   * Follow the vault: `state_changed` from its files, and the event log from
   * `eventLogOffset` whenever nothing is hosted here.
   */
  watch(eventLogOffset: number): void {
    if (this.live !== null) return;
    let events: DirectoryEvents;
    try {
      events = new DirectoryEvents(this.scope.paths.root, this.onLiveError);
    } catch (error) {
      // The page still works without live updates; it refetches on reload.
      this.onLiveError(error);
      return;
    }
    this.transcripts.useEvents(events);
    const onChange = (itemIds: readonly string[]): void => {
      this.bus.emit({ kind: 'state_changed', itemIds });
      void this.observeMode(false);
    };
    this.live = {
      events,
      vault: watchVault(this.scope.paths, onChange, { events, onError: this.onLiveError }),
      tail: null,
    };
    if (!this.hosting) this.live.tail = this.openTail(eventLogOffset);
    void this.observeMode(false);
    this.modeTimer = setInterval(() => void this.observeMode(true), this.options.modeCheckMs ?? MODE_CHECK_MS);
    this.modeTimer.unref();
  }

  /** Close every watcher and transcript tail. Idempotent. */
  async unwatch(): Promise<void> {
    if (this.modeTimer !== null) clearInterval(this.modeTimer);
    this.modeTimer = null;
    this.announcedMode = null;
    const live = this.live;
    this.live = null;
    await this.tailOps;
    live?.tail?.close();
    live?.vault.close();
    this.transcripts.closeAll();
    this.transcripts.useEvents(null);
    live?.events.close();
  }

  status(): HostStatusView {
    return {
      lastError: this.lastError,
      startupFailures: this.startupFailures,
      stopping: this.handle !== null && this.stopRequested,
    };
  }

  /** Resolves once startup has finished and the loop is running in the background. */
  start(): Promise<void> {
    if (this.hosting) {
      const message =
        this.handle !== null && this.stopRequested
          ? 'The factory is still stopping. Start it again once it has stopped.'
          : 'The factory is already running in this dashboard.';
      return Promise.reject(new HostStateError('already_hosted', message));
    }
    const attempt = this.startOnce().finally(() => {
      this.starting = null;
      if (this.handle === null) this.resumeTail();
    });
    this.starting = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  /**
   * Ask the hosted loop to stop after the item it is on; `force` also aborts
   * the agent run in flight. Returns at once — `idle()` waits for the rest.
   */
  requestStop(options: { readonly force?: boolean } = {}): void {
    const handle = this.handle;
    if (handle === null) {
      throw this.starting === null
        ? new HostStateError('not_hosted', 'The factory is not running in this dashboard.')
        : new HostStateError('starting', 'The factory is still starting. Try again in a moment.');
    }
    this.stopRequested = true;
    handle.requestStop();
    if (options.force === true) this.controller?.abort();
    this.releaseSleep();
    this.touch();
  }

  /** Drain: resolves after `run()` has settled and the lock is released. No-op when idle. */
  async stop(): Promise<void> {
    await this.starting;
    if (this.handle === null) return;
    this.requestStop();
    await this.settled;
  }

  /** Abort the agent run in flight, then shut down as `stop()` does. */
  async forceStop(): Promise<void> {
    await this.starting;
    if (this.handle === null) return;
    this.requestStop({ force: true });
    await this.settled;
  }

  /** Resolves when nothing is hosted: no start in flight and no loop running. */
  async idle(): Promise<void> {
    await this.starting;
    await this.settled;
  }

  /**
   * Start the next cycle now instead of after `poll_interval`. Mid-cycle it
   * only shortens the next sleep; it never runs a cycle itself.
   */
  wake(): void {
    if (this.handle === null) return;
    if (this.pendingSleep !== null) this.releaseSleep();
    else this.wakeLatched = true;
  }

  private async startOnce(): Promise<void> {
    const view = await this.fileView();
    if (view.mode === 'external') {
      throw new HostStateError(
        'external',
        `The factory is already running in another process (pid ${String(view.pid)}). Stop it ` +
          'there with `factory stop` before starting it from the dashboard.',
      );
    }

    // Drained before the orchestrator writes a line, so no line is both tailed and teed.
    await this.pauseTail();
    const controller = new AbortController();
    const tees: TeeEventSink[] = [];
    let handle: OrchestratorHandle;
    try {
      handle = await this.startFn({
        vaultPath: this.scope.vaultPath,
        config: this.scope.config,
        deps: this.options.deps,
        signal: controller.signal,
        eventSinkWrapper: (inner) => {
          const tee = new TeeEventSink(inner, this.bus);
          tees.push(tee);
          return tee;
        },
      });
    } catch (error) {
      if (error instanceof StartupRefused) {
        this.lastError = error.message;
        this.startupFailures = error.failures;
      } else if (!(error instanceof InstanceLockHeldError)) {
        this.lastError = messageOf(error);
      }
      // The failed start has closed its log. Skip past it only if it wrote: a start that lost the
      // lock race wrote nothing, and the winner's lines after the drain point must still be tailed.
      if (tees.some((tee) => tee.written > 0)) this.resumeAt = await this.eventLogEnd();
      this.touch();
      throw error;
    }

    this.lastError = null;
    this.startupFailures = [];
    this.controller = controller;
    this.stopRequested = false;
    this.wakeLatched = false;
    this.handle = handle;
    this.settled = this.supervise(handle);
    this.touch();
  }

  /** Never rejects: a crashed loop becomes `lastError`, and the lock is still released. */
  private async supervise(handle: OrchestratorHandle): Promise<void> {
    try {
      await handle.run({ sleep: this.sleep });
    } catch (error) {
      this.lastError = messageOf(error);
      this.log(`dashboard: the orchestrator stopped on an error: ${stackOf(error)}`);
    }
    // Under the mutex, so an approval in flight finishes emitting before the log closes.
    await this.mutex.run(async () => {
      try {
        await handle.shutdown();
      } catch (error) {
        this.lastError ??= messageOf(error);
        this.log(`dashboard: shutting the orchestrator down failed: ${stackOf(error)}`);
      }
      this.resumeAt = await this.eventLogEnd();
      this.releaseSleep();
      this.handle = null;
      this.controller = null;
      this.stopRequested = false;
      this.wakeLatched = false;
    });
    this.resumeTail();
    this.touch();
  }

  /** Read the event log up to its end, then stop following it; `resumeAt` is where it stopped. */
  private pauseTail(): Promise<void> {
    return this.queueTail(async () => {
      const tail = this.live?.tail ?? null;
      if (tail === null) return;
      await tail.drain();
      tail.close();
      this.resumeAt = tail.offset;
      if (this.live?.tail === tail) this.live.tail = null;
    });
  }

  /** Follow the event log again from `resumeAt`; a paused tail with no known offset stays off. */
  private resumeTail(): void {
    void this.queueTail(async () => {
      const offset = this.resumeAt;
      if (this.live === null || this.live.tail !== null || this.hosting || offset === null) return;
      this.live.tail = this.openTail(offset);
    });
  }

  /** The event log's size now (0 before it exists), or `null` (logged) when it cannot be read. */
  private async eventLogEnd(): Promise<number | null> {
    try {
      return (await fileSize(this.scope.paths.eventLog())) ?? 0;
    } catch (error) {
      this.onLiveError(error);
      return null;
    }
  }

  private queueTail(op: () => Promise<void>): Promise<void> {
    const next = this.tailOps.then(op).catch(this.onLiveError);
    this.tailOps = next;
    return next;
  }

  private openTail(offset: number): JsonlTail {
    return tailJsonl(
      this.scope.paths.eventLog(),
      offset,
      (line) => {
        const event = parseEvent(line);
        if (event !== null) this.bus.emit({ kind: 'event', event, summary: summariseEvent(event) });
      },
      { onError: this.onLiveError, ...(this.live === null ? {} : { events: this.live.events }) },
    );
  }

  /** A change no vault file shows (mode, `stopping`, `lastError`), sent in the watcher's current window. */
  private touch(): void {
    this.live?.vault.touch();
  }

  /** Re-read the mode; with `announce`, send `state_changed` when it differs from the one the page was last sent. */
  private async observeMode(announce: boolean): Promise<void> {
    let mode: DashboardMode;
    try {
      mode = await this.mode();
    } catch (error) {
      this.onLiveError(error);
      return;
    }
    if (this.live === null) return;
    if (announce && this.announcedMode !== null && mode !== this.announcedMode) this.touch();
    this.announcedMode = mode;
  }

  private readonly onLiveError = (error: unknown): void => {
    this.log(`dashboard: live updates: ${stackOf(error)}`);
  };

  private readonly sleep = (ms: number): Promise<void> => {
    if (this.wakeLatched || this.stopRequested) {
      this.wakeLatched = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingSleep?.timer === timer) this.pendingSleep = null;
        resolve();
      }, ms);
      timer.unref();
      this.pendingSleep = { timer, resolve };
    });
  };

  private releaseSleep(): void {
    const pending = this.pendingSleep;
    if (pending === null) return;
    this.pendingSleep = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private fileView(): Promise<LockView> {
    return readLockView(this.scope.paths, {
      ...(this.options.selfPid === undefined ? {} : { selfPid: this.options.selfPid }),
      ...(this.options.isAlive === undefined ? {} : { isAlive: this.options.isAlive }),
    });
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

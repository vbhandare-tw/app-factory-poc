/**
 * One per dashboard process (tech spec §4.1): the orchestrator hosted here, if
 * any, and which of the three modes the vault is in.
 */
import type { VaultScope } from '../cli/resolve.js';
import type { StartupFailure } from '../config/validate.js';
import { startOrchestrator, StartupRefused } from '../orchestrator/host.js';
import type {
  OrchestratorHandle,
  OrchestratorHostDeps,
  StartOrchestratorInput,
} from '../orchestrator/host.js';
import { InstanceLockHeldError } from '../orchestrator/lock.js';
import type { LivenessCheck } from '../orchestrator/lock.js';
import { readLockView } from './handlers/read.js';
import type { DashboardMode, HostStatusView, LockView } from './handlers/read.js';
import { Mutex } from './mutex.js';

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
}

interface PendingSleep {
  readonly timer: NodeJS.Timeout;
  readonly resolve: () => void;
}

export class DashboardHost {
  readonly scope: VaultScope;
  /** Serialises dashboard POSTs against each other. Never held while a run drains. */
  readonly mutex = new Mutex();

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

  constructor(options: DashboardHostOptions) {
    this.options = options;
    this.scope = options.scope;
    this.startFn = options.startOrchestrator ?? startOrchestrator;
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

    const controller = new AbortController();
    let handle: OrchestratorHandle;
    try {
      handle = await this.startFn({
        vaultPath: this.scope.vaultPath,
        config: this.scope.config,
        deps: this.options.deps,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof StartupRefused) {
        this.lastError = error.message;
        this.startupFailures = error.failures;
      } else if (!(error instanceof InstanceLockHeldError)) {
        this.lastError = messageOf(error);
      }
      throw error;
    }

    this.lastError = null;
    this.startupFailures = [];
    this.controller = controller;
    this.stopRequested = false;
    this.wakeLatched = false;
    this.handle = handle;
    this.settled = this.supervise(handle);
  }

  /** Never rejects: a crashed loop becomes `lastError`, and the lock is still released. */
  private async supervise(handle: OrchestratorHandle): Promise<void> {
    try {
      await handle.run({ sleep: this.sleep });
    } catch (error) {
      this.lastError = messageOf(error);
      this.log(`dashboard: the orchestrator stopped on an error: ${stackOf(error)}`);
    }
    try {
      await handle.shutdown();
    } catch (error) {
      this.lastError ??= messageOf(error);
      this.log(`dashboard: shutting the orchestrator down failed: ${stackOf(error)}`);
    }
    this.releaseSleep();
    this.handle = null;
    this.controller = null;
    this.stopRequested = false;
    this.wakeLatched = false;
  }

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

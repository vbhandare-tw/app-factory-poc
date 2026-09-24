/**
 * Shared pieces for the dashboard host and write-API tests (plan Phase 4): a
 * scripted stand-in for `startOrchestrator`, a `VaultScope` over a fixture
 * vault, and a few timing helpers.
 */
import { writeFileSync } from 'node:fs';

import type { VaultScope } from '../../src/cli/resolve.js';
import { ShellGit } from '../../src/git/git.js';
import type { EventLog } from '../../src/log/events.js';
import type {
  OrchestratorHandle,
  RunOptions,
  StartOrchestratorInput,
} from '../../src/orchestrator/host.js';
import type { MarkdownStorage } from '../../src/vault/storage.js';
import type { FactoryFixture } from './orchestratorFixtures.js';

export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Resolves once `signal` aborts; never, when there is no signal. */
export function abortOf(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener('abort', () => done(), { once: true });
  });
}

/** Which of `promise` and a `ms` timer finished first. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** What `openVault` returns, built by hand so a test can swap the storage. */
export function scopeFor(
  vault: FactoryFixture,
  overrides: { readonly storage?: MarkdownStorage; readonly now?: () => string } = {},
): VaultScope {
  const storage = overrides.storage ?? vault.storage;
  const now = overrides.now ?? ((): string => new Date().toISOString());
  return {
    vaultPath: vault.root,
    resolution: { vaultPath: vault.root, source: 'flag', projectName: null },
    config: vault.config,
    paths: vault.paths,
    storage,
    actionContext: {
      paths: vault.paths,
      storage,
      config: vault.config,
      now,
      git: new ShellGit({ repoRoot: vault.config.target_repo }),
    },
  };
}

/** A lock record as another process would have written it. */
export function writeLockRecord(
  vault: FactoryFixture,
  record: { readonly pid: number; readonly heartbeatAt?: string },
): void {
  const at = record.heartbeatAt ?? new Date().toISOString();
  writeFileSync(
    vault.paths.instanceLock(),
    `${JSON.stringify({ pid: record.pid, host: 'another-terminal', startedAt: at, heartbeatAt: at }, null, 2)}\n`,
  );
}

export interface FakeRunContext {
  readonly options: RunOptions;
  readonly input: StartOrchestratorInput;
  readonly stopRequested: () => boolean;
  readonly log: string[];
}

export interface FakeBehaviour {
  /** Replaces the default loop: a "cycle", then `sleep(15 s)`, until asked to stop. */
  run?: ((context: FakeRunContext) => Promise<void>) | undefined;
  /** Thrown by `start` in place of a handle. */
  refuse?: Error | undefined;
}

export interface FakeOrchestrator {
  readonly start: (input: StartOrchestratorInput) => Promise<OrchestratorHandle>;
  /** Every input `start` was called with, in order. */
  readonly inputs: StartOrchestratorInput[];
  /** `start`, `run`, `cycle`, `requestStop`, `aborted`, `shutdown`, plus whatever a behaviour adds. */
  readonly log: string[];
  /** Mutable, so a test can change what the next start does. */
  readonly behaviour: FakeBehaviour;
  /** The `sleep` the host passed to the most recent `run`. */
  sleep(): (ms: number) => Promise<void>;
}

/**
 * `startOrchestrator` without a vault, a lock or a runner. The handle's `run`
 * uses the host's `sleep` exactly as `Orchestrator.run` does.
 */
export function fakeOrchestrator(initial: FakeBehaviour = {}): FakeOrchestrator {
  const inputs: StartOrchestratorInput[] = [];
  const log: string[] = [];
  const behaviour: FakeBehaviour = { ...initial };
  let lastSleep: ((ms: number) => Promise<void>) | undefined;

  const start = async (input: StartOrchestratorInput): Promise<OrchestratorHandle> => {
    inputs.push(input);
    log.push('start');
    if (behaviour.refuse !== undefined) throw behaviour.refuse;

    let stopRequested = false;
    input.signal?.addEventListener('abort', () => log.push('aborted'), { once: true });

    return {
      events: {} as unknown as EventLog,
      get stopRequested(): boolean {
        return stopRequested;
      },
      run: async (options = {}) => {
        log.push('run');
        lastSleep = options.sleep;
        const context: FakeRunContext = { options, input, stopRequested: () => stopRequested, log };
        if (behaviour.run !== undefined) {
          await behaviour.run(context);
          return [];
        }
        const sleep = options.sleep ?? delay;
        while (!stopRequested) {
          log.push('cycle');
          await sleep(15_000);
        }
        return [];
      },
      requestStop: () => {
        stopRequested = true;
        log.push('requestStop');
      },
      shutdown: async () => {
        log.push('shutdown');
      },
    };
  };

  return {
    start,
    inputs,
    log,
    behaviour,
    sleep: () => {
      if (lastSleep === undefined) throw new Error('the host never called run() with a sleep');
      return lastSleep;
    },
  };
}

/**
 * `factory dashboard [project] [--vault <p>] [--port <n>] [--no-open] [--start]`
 * (tech spec §6). Hosts the orchestrator only when asked: opening the page must
 * never start spending on real agents.
 */
import { spawn } from 'node:child_process';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

import { DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT } from '../dashboard/constants.js';
import { registerReadRoutes } from '../dashboard/handlers/read.js';
import { registerStreamRoutes } from '../dashboard/handlers/stream.js';
import { registerWriteRoutes } from '../dashboard/handlers/write.js';
import { DashboardHost } from '../dashboard/host.js';
import type { DashboardHostOptions } from '../dashboard/host.js';
import { Router } from '../dashboard/router.js';
import { RunIndex } from '../dashboard/runIndex.js';
import { newSessionToken } from '../dashboard/security.js';
import { createDashboardServer } from '../dashboard/server.js';
import { ShellGit } from '../git/git.js';
import type { LivenessCheck } from '../orchestrator/lock.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';
import { openVault } from './resolve.js';

export interface DashboardOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  readonly port?: number | undefined;
  /** `--no-open` sets it false. */
  readonly open?: boolean | undefined;
  /** Start the orchestrator at launch instead of waiting for the Start button. */
  readonly start?: boolean | undefined;
}

export type DashboardSignal = 'SIGINT' | 'SIGTERM';

export interface SignalSource {
  on(signal: DashboardSignal, listener: () => void): unknown;
  off(signal: DashboardSignal, listener: () => void): unknown;
}

/** The outside world `runDashboard` touches, injectable so a test opens no browser. */
export interface DashboardSeams {
  readonly openUrl?: (url: string) => void;
  readonly signals?: SignalSource;
  readonly exit?: (code: number) => void;
  readonly startOrchestrator?: DashboardHostOptions['startOrchestrator'];
  readonly isAlive?: LivenessCheck;
  /** Overrides `SSE_HEARTBEAT_MS`, so a test need not wait 15 s for one. */
  readonly sseHeartbeatMs?: number;
}

export interface RunningDashboard {
  readonly url: string;
  readonly host: DashboardHost;
  readonly server: http.Server;
  /** Settles once the hosted orchestrator (if any) has stopped and the server has closed. */
  readonly closed: Promise<void>;
  close(options?: { readonly force?: boolean }): Promise<void>;
}

export async function runDashboard(
  options: DashboardOptions,
  deps: CliDeps,
  seams: DashboardSeams = {},
): Promise<RunningDashboard> {
  const scope = await openVault(options, deps);
  const host = new DashboardHost({
    scope,
    deps,
    log: deps.err,
    ...(seams.startOrchestrator === undefined ? {} : { startOrchestrator: seams.startOrchestrator }),
    ...(seams.isAlive === undefined ? {} : { isAlive: seams.isAlive }),
  });

  // Subscribed before any client can connect, so a run is addressable by the time a client hears of it.
  const { index: runIndex, offset: eventLogOffset } = await RunIndex.loadWithOffset(scope.paths.eventLog());
  host.bus.subscribe((message) => {
    if (message.kind === 'event') runIndex.apply(message.event);
  });

  const router = new Router();
  registerReadRoutes(router, {
    scope,
    git: scope.actionContext.git ?? new ShellGit({ repoRoot: scope.config.target_repo }),
    runIndex,
    lockView: () => host.lockView(),
    hostStatus: () => host.status(),
  });
  registerWriteRoutes(router, { scope, host });
  registerStreamRoutes(router, {
    bus: host.bus,
    runIndex,
    logsDir: scope.paths.logsDir(),
    transcripts: host.transcripts,
    ...(seams.sseHeartbeatMs === undefined ? {} : { heartbeatMs: seams.sseHeartbeatMs }),
  });

  const server = createDashboardServer({ token: newSessionToken(), router, log: deps.err });
  const port = await listen(server, options.port ?? DEFAULT_DASHBOARD_PORT);
  const url = `http://${DASHBOARD_HOST}:${port}/`;
  host.watch(eventLogOffset);

  const signals = seams.signals ?? process;
  const exit = seams.exit ?? ((code: number): void => process.exit(code));

  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  let serverClosing: Promise<void> | null = null;

  const close = async (closeOptions: { readonly force?: boolean } = {}): Promise<void> => {
    if (closeOptions.force === true) await host.forceStop();
    else await host.stop();
    serverClosing ??= closeServer(server);
    await serverClosing;
    await host.unwatch();
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    markClosed();
  };

  let signalCount = 0;
  function onSignal(): void {
    signalCount += 1;
    if (signalCount === 1) {
      deps.err(
        host.hosting
          ? 'Stopping after the current agent finishes. Press Ctrl-C again to stop it now.'
          : 'Stopping the dashboard.',
      );
      void close().catch(reportCloseFailure);
    } else if (signalCount === 2) {
      deps.err('Stopping now: the running agent is being stopped.');
      void close({ force: true }).catch(reportCloseFailure);
    } else {
      deps.err('Exiting without waiting.');
      exit(130);
    }
  }
  function reportCloseFailure(error: unknown): void {
    deps.err(`dashboard: could not shut down cleanly: ${messageOf(error)}`);
  }

  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);

  deps.out(`Dashboard: ${url}`);
  deps.out(`Vault: ${scope.vaultPath}`);

  if (options.open !== false) {
    const openUrl = seams.openUrl ?? ((target: string): void => openInBrowser(target, deps.err));
    try {
      openUrl(url);
    } catch (error) {
      deps.err(`Could not open a browser (${messageOf(error)}). Open ${url} yourself.`);
    }
  }

  if (options.start === true) {
    try {
      await host.start();
      deps.out('The factory is running in this dashboard.');
    } catch (error) {
      deps.err(`Could not start the factory: ${messageOf(error)}`);
    }
  } else {
    const view = await host.lockView().catch(() => null);
    deps.out(
      view?.mode === 'external'
        ? `The factory is running in another process (pid ${String(view.pid)}); the page follows it.`
        : 'The factory is stopped. Press Start in the page to run it, or pass --start.',
    );
  }
  deps.out('Press Ctrl-C to stop.');

  return { url, host, server, closed, close };
}

/** `--port`: a whole number from 0 (any free port) to 65535. */
export function parsePort(raw: string): number {
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new CliError(`--port must be a whole number from 0 to 65535, not ${JSON.stringify(raw)}`);
  }
  return port;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(
        error.code === 'EADDRINUSE'
          ? new CliError(`Port ${port} is in use — pass \`--port\`.`)
          : new CliError(`could not listen on ${DASHBOARD_HOST}:${port}: ${error.message}`),
      );
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, DASHBOARD_HOST);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** macOS `open`. A failure is reported, never fatal: the URL is already printed. */
function openInBrowser(url: string, err: (line: string) => void): void {
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.on('error', (error) => {
    err(`Could not open a browser (${error.message}). Open ${url} yourself.`);
  });
  child.unref();
}

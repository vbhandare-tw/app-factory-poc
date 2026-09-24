/**
 * `factory dashboard` (plan Phase 4, tech spec §6): binds loopback only,
 * prints and opens a `127.0.0.1` URL, never starts the orchestrator unless
 * asked, and stops on Ctrl-C — draining first, aborting on the second.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../../src/config/registry.js';
import type { CliDeps } from '../../../src/cli/deps.js';
import { CliError } from '../../../src/cli/deps.js';
import { parsePort, runDashboard } from '../../../src/cli/dashboard.js';
import type { DashboardSeams, RunningDashboard } from '../../../src/cli/dashboard.js';
import { buildProgram } from '../../../src/cli/main.js';
import { DASHBOARD_HOST } from '../../../src/dashboard/constants.js';
import { abortOf, deferred, delay, fakeOrchestrator, settlesWithin } from '../../helpers/dashboardFixtures.js';
import type { FakeOrchestrator } from '../../helpers/dashboardFixtures.js';
import { factoryVault } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchFactoryHome,
} from '../../helpers/toyRepo.js';

let vault: FactoryFixture;
let home: string;
let out: string[];
let err: string[];
let fake: FakeOrchestrator;
let signals: EventEmitter;
let opened: string[];
let exits: number[];
let running: RunningDashboard[];
let blockers: net.Server[];

function deps(): CliDeps {
  return {
    cwd: vault.root,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date().toISOString(),
  };
}

function seams(overrides: Partial<DashboardSeams> = {}): DashboardSeams {
  return {
    openUrl: (url) => {
      opened.push(url);
    },
    signals,
    exit: (code) => {
      exits.push(code);
    },
    startOrchestrator: fake.start,
    ...overrides,
  };
}

async function dashboard(
  options: { port?: number; open?: boolean; start?: boolean } = {},
  overrides: Partial<DashboardSeams> = {},
): Promise<RunningDashboard> {
  const started = await runDashboard(
    { vault: vault.root, port: options.port ?? 0, open: options.open ?? false, start: options.start ?? false },
    deps(),
    seams(overrides),
  );
  running.push(started);
  return started;
}

beforeEach(() => {
  vault = factoryVault();
  home = scratchFactoryHome();
  out = [];
  err = [];
  fake = fakeOrchestrator();
  signals = new EventEmitter();
  opened = [];
  exits = [];
  running = [];
  blockers = [];
});

afterEach(async () => {
  for (const r of running) await r.close({ force: true });
  for (const blocker of blockers) await new Promise<void>((done) => blocker.close(() => done()));
  vault.cleanup();
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('binding', () => {
  it('binds 127.0.0.1 and nothing wider (tech spec §2 rule 1)', async () => {
    const d = await dashboard();
    const address = d.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });

  it('prints, and opens, a URL that says 127.0.0.1 literally — never localhost', async () => {
    const d = await dashboard({ open: true });
    const port = (d.server.address() as AddressInfo).port;

    expect(d.url).toBe(`http://127.0.0.1:${port}/`);
    expect(opened).toEqual([d.url]);
    expect(out).toContain(`Dashboard: http://127.0.0.1:${port}/`);
    expect([...out, ...opened].join('\n')).not.toContain('localhost');
  });

  it('a port in use → CliError naming the port and --port, with no orchestrator started', async () => {
    const blocker = net.createServer();
    blockers.push(blocker);
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, DASHBOARD_HOST, () => resolve((blocker.address() as AddressInfo).port));
    });

    const error = await runDashboard({ vault: vault.root, port, open: true, start: true }, deps(), seams()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(`Port ${port} is in use — pass \`--port\`.`);
    expect(fake.inputs).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});

describe('the orchestrator', () => {
  it('is not started without --start: startOrchestrator is never called', async () => {
    const d = await dashboard();
    expect(fake.inputs).toHaveLength(0);
    expect(await d.host.mode()).toBe('stopped');
    expect(out.join('\n')).toContain('The factory is stopped.');
  });

  it('is started with --start', async () => {
    const d = await dashboard({ start: true });
    expect(fake.inputs).toHaveLength(1);
    expect(await d.host.mode()).toBe('hosted');
  });

  it('a refused --start leaves the dashboard serving, with the reason printed', async () => {
    fake.behaviour.refuse = new Error('startup validation failed (1 problem)');
    const d = await dashboard({ start: true });
    expect(d.server.listening).toBe(true);
    expect(err.join('\n')).toContain('startup validation failed (1 problem)');
    expect(await d.host.mode()).toBe('stopped');
  });
});

describe('the browser', () => {
  it('--no-open does not spawn open', async () => {
    await dashboard({ open: false });
    expect(opened).toEqual([]);
  });

  it('a failure to open it is logged, not fatal', async () => {
    const d = await dashboard(
      { open: true },
      {
        openUrl: () => {
          throw new Error('spawn open ENOENT');
        },
      },
    );
    expect(d.server.listening).toBe(true);
    expect(err.join('\n')).toContain('spawn open ENOENT');
    expect(err.join('\n')).toContain(d.url);
  });
});

describe('Ctrl-C', () => {
  it('the first drains, printing how to force it; the second aborts the agent and exits', async () => {
    fake.behaviour.run = async ({ input, log }) => {
      await abortOf(input.signal);
      log.push('run settled');
    };
    const d = await dashboard({ start: true });

    signals.emit('SIGINT');
    expect(err).toContain('Stopping after the current agent finishes. Press Ctrl-C again to stop it now.');
    expect(await settlesWithin(d.closed, 100)).toBe(false);
    expect(d.host.hosting).toBe(true);
    expect(d.server.listening).toBe(true);

    signals.emit('SIGINT');
    expect(await settlesWithin(d.closed, 2_000)).toBe(true);

    expect(fake.inputs[0]!.signal?.aborted).toBe(true);
    expect(fake.log.slice(-2)).toEqual(['run settled', 'shutdown']);
    expect(d.server.listening).toBe(false);
    expect(d.host.hosting).toBe(false);
    expect(exits).toEqual([]);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('SIGTERM is treated the same way', async () => {
    fake.behaviour.run = ({ input }) => abortOf(input.signal);
    const d = await dashboard({ start: true });

    signals.emit('SIGTERM');
    expect(await settlesWithin(d.closed, 100)).toBe(false);
    signals.emit('SIGTERM');
    expect(await settlesWithin(d.closed, 2_000)).toBe(true);
    expect(fake.inputs[0]!.signal?.aborted).toBe(true);
  });

  it('with nothing hosted closes at once', async () => {
    const d = await dashboard();
    signals.emit('SIGINT');
    expect(await settlesWithin(d.closed, 1_000)).toBe(true);
    expect(d.server.listening).toBe(false);
    expect(fake.inputs).toHaveLength(0);
  });

  it('a drain that finishes on its own closes the dashboard without a second Ctrl-C', async () => {
    const release = deferred();
    fake.behaviour.run = async () => {
      await release.promise;
    };
    const d = await dashboard({ start: true });

    signals.emit('SIGINT');
    await delay(20);
    release.resolve();

    expect(await settlesWithin(d.closed, 1_000)).toBe(true);
    expect(fake.inputs[0]!.signal?.aborted).toBe(false);
  });

  it('a third exits at once, when even the abort has not ended the run', async () => {
    const release = deferred();
    fake.behaviour.run = async () => {
      await release.promise;
    };
    const d = await dashboard({ start: true });

    signals.emit('SIGINT');
    signals.emit('SIGINT');
    expect(exits).toEqual([]);
    signals.emit('SIGINT');
    expect(exits).toEqual([130]);

    release.resolve();
    await d.closed;
  });
});

describe('parsePort', () => {
  it('accepts a whole number from 0 to 65535', () => {
    expect(parsePort('4317')).toBe(4317);
    expect(parsePort('0')).toBe(0);
    expect(parsePort('65535')).toBe(65535);
  });

  it.each(['', 'abc', '-1', '65536', '43.17', '4317x'])('refuses %j', (raw) => {
    expect(() => parsePort(raw)).toThrow(CliError);
  });
});

describe('buildProgram', () => {
  it('registers `dashboard [project]` with --vault, --port, --no-open and --start', () => {
    const command = buildProgram(deps()).commands.find((c) => c.name() === 'dashboard');
    expect(command).toBeDefined();
    expect(command!.options.map((option) => option.flags)).toEqual([
      '--vault <path>',
      '--port <n>',
      '--no-open',
      '--start',
    ]);
    expect(command!.registeredArguments.map((argument) => argument.name())).toEqual(['project']);
  });
});

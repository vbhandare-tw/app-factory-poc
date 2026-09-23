/**
 * `factory start` keeps its instance lock fresh while an agent runs, and leaves
 * no heartbeat timer behind on any way out (plan Phase 1, resolution A8).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectRegistry } from '../../src/config/registry.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { CliError } from '../../src/cli/deps.js';
import { buildProgram } from '../../src/cli/main.js';
import type { Runner } from '../../src/runner/types.js';
import { factoryVault, pipelineRunner } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };

let vault: FactoryFixture;
let home: string;
let workspace: string;

function realNow(): string {
  return new Date().toISOString();
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: workspace,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: () => undefined,
    err: () => undefined,
    now: overrides.now ?? realNow,
    ...(overrides.runner === undefined ? {} : { runner: overrides.runner }),
  };
}

async function factory(args: readonly string[], overrides: Partial<CliDeps> = {}): Promise<void> {
  await buildProgram(deps(overrides), MANIFEST).parseAsync(['node', 'factory', ...args]);
}

async function addFeature(name: string): Promise<void> {
  const file = path.join(workspace, `${name}.md`);
  writeFileSync(file, `# ${name}\n`, 'utf8');
  await factory(['feature', 'add', file, '--vault', vault.root]);
}

function loggedTypes(): string[] {
  return readFileSync(vault.paths.eventLog(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

beforeEach(() => {
  // `poll_interval: 1` (the fixture default): a heartbeat older than 3 s is stale.
  vault = factoryVault();
  home = scratchFactoryHome();
  workspace = scratchDir('heartbeat-workspace-');
});

afterEach(() => {
  vi.useRealTimers();
  vault.cleanup();
  removeScratchDir(home);
  removeScratchDir(workspace);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('factory start during a long agent run', () => {
  it('refuses a second factory start launched mid-run, and nothing is reclaimed', async () => {
    await addFeature('alpha');
    const mock = pipelineRunner();

    let second: Promise<unknown> | undefined;
    const slowPm: Runner = {
      async run(spec, signal) {
        // Held until the second start has its answer, well past 3 × poll_interval.
        second ??= sleep(3500).then(() =>
          factory(['start', '--vault', vault.root, '--once'], { runner: mock }).then(
            () => 'the second instance started',
            (error: unknown) => error,
          ),
        );
        await second;
        return await mock.run(spec, signal);
      },
    };

    await factory(['start', '--vault', vault.root, '--once'], { runner: slowPm });

    const outcome = await second;
    expect(outcome).toBeInstanceOf(CliError);
    expect((outcome as CliError).message).toMatch(/another factory instance holds/);
    expect(loggedTypes()).not.toContain('lock_reclaimed');
    expect(loggedTypes().filter((type) => type === 'lock_acquired')).toHaveLength(1);
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  }, 60_000);
});

describe('no heartbeat timer outlives factory start', () => {
  it('--once clears it and releases the lock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await addFeature('alpha');
    const mock = pipelineRunner();
    let timersDuringRun = -1;
    const counting: Runner = {
      run(spec, signal) {
        timersDuringRun = vi.getTimerCount();
        return mock.run(spec, signal);
      },
    };

    await factory(['start', '--vault', vault.root, '--once'], { runner: counting });

    expect(timersDuringRun).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  });

  it('a run that throws still clears it and releases the lock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Regenerating index.md at the end of the cycle now fails, so run() rejects.
    rmSync(vault.paths.indexFile(), { force: true });
    mkdirSync(vault.paths.indexFile());
    const timersSeen: number[] = [];
    const now = (): string => {
      timersSeen.push(vi.getTimerCount());
      return realNow();
    };

    await expect(
      factory(['start', '--vault', vault.root, '--once'], { runner: pipelineRunner(), now }),
    ).rejects.toThrow(/EISDIR/);

    expect(Math.max(...timersSeen)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  });
});

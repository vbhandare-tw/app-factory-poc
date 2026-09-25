/**
 * `factory start` reports every startup refusal as a `CliError`, so `main`
 * prints the message and exits 1 instead of printing a stack trace.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../../src/config/registry.js';
import type { CliDeps } from '../../../src/cli/deps.js';
import { CliError } from '../../../src/cli/deps.js';
import { runStart } from '../../../src/cli/start.js';
import { noWorktreesMessage } from '../../../src/orchestrator/host.js';
import { InstanceLock } from '../../../src/orchestrator/lock.js';
import { factoryVault, pipelineRunner } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchFactoryHome,
} from '../../helpers/toyRepo.js';

const vaults: FactoryFixture[] = [];
const homes: string[] = [];

function vault(config: Readonly<Record<string, unknown>> = {}): FactoryFixture {
  const fixture = factoryVault({ config });
  vaults.push(fixture);
  return fixture;
}

function deps(fixture: FactoryFixture, overrides: Partial<CliDeps> = {}): CliDeps {
  const home = scratchFactoryHome();
  homes.push(home);
  return {
    cwd: fixture.root,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: () => undefined,
    err: () => undefined,
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected factory start to refuse, but it started');
    },
    (error: unknown) => error as Error,
  );
}

afterEach(() => {
  for (const fixture of vaults.splice(0)) fixture.cleanup();
  for (const home of homes.splice(0)) removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('runStart refusals are CliErrors with the message they always had', () => {
  it('a failed startup validation', async () => {
    const broken = vault();
    broken.repo.cleanup();

    const error = await refusal(
      runStart({ vault: broken.root, once: true }, deps(broken, { runner: pipelineRunner() })),
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect(error.message).toBe(
      'startup validation failed (1 problem):\n' +
        `  - target_repo: target_repo ${broken.repo.path} does not exist. The vault is bound to a ` +
        'repo that is not there — it was moved, renamed, or deleted.',
    );
  });

  it('a real runner with no way to make worktrees', async () => {
    const real = vault({ runner: 'claude-code' });

    const error = await refusal(runStart({ vault: real.root, once: true }, deps(real)));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect(error.message).toBe(noWorktreesMessage(real.root, real.config));
    expect(error.message).toMatch(/^refusing to start: this vault is set to `runner: claude-code`/);
  });

  it('an instance lock held by a live process', async () => {
    const fixture = vault();
    const holder = await InstanceLock.acquire(fixture.paths, {
      pollIntervalSec: fixture.config.poll_interval,
      pid: process.pid,
      host: 'another-terminal',
    });

    try {
      const error = await refusal(
        runStart({ vault: fixture.root, once: true }, deps(fixture, { runner: pipelineRunner() })),
      );

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(1);
      expect(error.message).toMatch(/^another factory instance holds .*\(pid \d+ on another-terminal,/);
    } finally {
      await holder.release();
    }
  });
});

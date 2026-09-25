/**
 * `factory feature add` refuses a second feature while one is still being
 * built (plan A9), through the real binary entry point and its exit code.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../src/config/registry.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { main } from '../../src/cli/main.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { Orchestrator } from '../../src/orchestrator/loop.js';
import { MockRunner } from '../../src/runner/mock.js';
import { makeFeature } from '../helpers/notes.js';
import { factoryVault, readNoteFile } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

let vault: FactoryFixture;
let home: string;
let workspace: string;
let output: string[];
let errors: string[];

function deps(): CliDeps {
  return {
    cwd: workspace,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: (line: string) => output.push(line),
    err: (line: string) => errors.push(line),
    now: () => new Date().toISOString(),
  };
}

/** `factory <args>` exactly as the binary runs it; returns the exit code it set. */
async function factory(args: readonly string[]): Promise<number> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(['node', 'factory', ...args], deps());
    return Number(process.exitCode ?? 0);
  } finally {
    process.exitCode = previous;
  }
}

function requirement(name: string): string {
  const file = path.join(workspace, `${name}.md`);
  writeFileSync(file, `# ${name}\n`, 'utf8');
  return file;
}

beforeEach(() => {
  vault = factoryVault();
  home = scratchFactoryHome();
  workspace = scratchDir('feature-add-a9-');
  output = [];
  errors = [];
});

afterEach(() => {
  vault.cleanup();
  removeScratchDir(home);
  removeScratchDir(workspace);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('factory feature add while another feature is in refining', () => {
  it('exits non-zero with the A9 message, writes nothing, and adds once the first is done', async () => {
    expect(await factory(['feature', 'add', requirement('alpha'), '--vault', vault.root])).toBe(0);

    // One real cycle takes alpha from intake to refining; the PM run is aborted,
    // which costs no attempt, so alpha stays in refining.
    const orchestrator = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage: vault.storage,
      runner: new MockRunner({ fixtures: { pm: { failure: 'aborted' } } }),
      events: new MemoryEventLog(),
      isAlive: () => true,
    });
    await orchestrator.run({ maxCycles: 1, sleep: async () => undefined });
    await orchestrator.shutdown();
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter.status).toBe('refining');

    output = [];
    const bravo = requirement('bravo');
    expect(await factory(['feature', 'add', bravo, '--vault', vault.root])).toBe(1);
    expect(errors).toEqual([
      'FEAT-ALPHA is still in progress (refining). The factory builds one feature at a time ' +
        'until M4; finish it first.',
    ]);
    expect(output).toEqual([]);
    expect(existsSync(vault.paths.featureDir('bravo'))).toBe(false);

    // Hand-edited to done (ADR-001 makes that a supported way to reach any state).
    await vault.storage.writeNote(
      vault.paths.featureNote('alpha'),
      makeFeature({ id: 'FEAT-ALPHA', slug: 'alpha', title: 'alpha', status: 'done' }),
    );
    errors = [];
    expect(await factory(['feature', 'add', bravo, '--vault', vault.root])).toBe(0);
    expect(errors).toEqual([]);
    expect(output[0]).toBe('Added FEAT-BRAVO (bravo) in intake');
  });
});

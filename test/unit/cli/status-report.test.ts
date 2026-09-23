/**
 * `buildStatusReport` is the report half of `factory status`, shared with the
 * dashboard (plan Phase 1). `runStatus` must print exactly what it builds.
 */
import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../../src/config/registry.js';
import type { VaultResolution } from '../../../src/config/resolve.js';
import type { CliDeps } from '../../../src/cli/deps.js';
import { buildStatusReport, formatReport, runStatus } from '../../../src/cli/status.js';
import type { FeatureFrontmatter, TicketFrontmatter } from '../../../src/domain/types.js';
import { makeFeature, makeTicket } from '../../helpers/notes.js';
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
let output: string[];

function resolution(): VaultResolution {
  return { vaultPath: vault.root, source: 'flag', projectName: null };
}

function deps(): CliDeps {
  return {
    cwd: vault.root,
    env: {},
    registry: new ProjectRegistry(home),
    out: (line: string) => output.push(line),
    err: () => undefined,
    now: () => '2026-09-01T10:00:00.000Z',
  };
}

async function feature(
  slug: string,
  title: string,
  status: FeatureFrontmatter['status'],
  overrides: Partial<FeatureFrontmatter> = {},
): Promise<void> {
  mkdirSync(vault.paths.featureDir(slug), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.featureNote(slug),
    makeFeature({ id: `FEAT-${slug.toUpperCase()}`, slug, title, status, ...overrides }),
  );
}

async function ticket(
  slug: string,
  ordinal: number,
  status: TicketFrontmatter['status'],
  overrides: Partial<TicketFrontmatter> = {},
): Promise<void> {
  const id = `FEAT-${slug.toUpperCase()}-T00${ordinal}`;
  mkdirSync(vault.paths.ticketsDir(slug), { recursive: true });
  await vault.storage.writeNote(
    vault.paths.ticketPath(slug, id),
    makeTicket({ id, feature: slug, ordinal, title: `Ticket ${ordinal}`, status, ...overrides }),
  );
}

/** One of everything the report distinguishes. */
async function mixedVault(): Promise<void> {
  await feature('alpha', 'Alpha', 'in_development');
  await ticket('alpha', 1, 'done');
  await ticket('alpha', 2, 'done');
  await ticket('alpha', 3, 'in_progress');
  await ticket('alpha', 4, 'needs_human', {
    pause_reason: 'attempts_exhausted',
    pause_detail: 'three failed attempts',
    resume_to: 'in_progress',
  });
  await feature('bravo', 'Bravo', 'needs_human', {
    pause_reason: 'checkpoint',
    pause_detail: 'after_pm_refinement',
    resume_to: 'planning',
    reject_to: 'refining',
  });
  await feature('charlie', 'Charlie', 'done', { tag: 'factory/charlie/2026-09-01' });
}

beforeEach(() => {
  vault = factoryVault();
  home = scratchFactoryHome();
  output = [];
});

afterEach(() => {
  vault.cleanup();
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('buildStatusReport', () => {
  it('reports an empty vault as no features, no tickets, and a stopped orchestrator', async () => {
    expect(await buildStatusReport(resolution())).toEqual({
      vault: vault.root,
      project: null,
      source: 'flag',
      target_repo: vault.repo.path,
      base_branch: vault.repo.branch,
      orchestrator: 'stopped',
      features: [],
      totals: { features: 0, tickets: 0 },
      needs_human: [],
      running: [],
    });
  });

  it('counts tickets by state per feature and totals them across features', async () => {
    await mixedVault();

    const report = await buildStatusReport(resolution());

    expect(report.features).toEqual([
      {
        id: 'FEAT-ALPHA',
        slug: 'alpha',
        title: 'Alpha',
        status: 'in_development',
        tickets: 4,
        ticketsByState: { in_progress: 1, done: 2, needs_human: 1 },
        tag: null,
      },
      {
        id: 'FEAT-BRAVO',
        slug: 'bravo',
        title: 'Bravo',
        status: 'needs_human',
        tickets: 0,
        ticketsByState: {},
        tag: null,
      },
      {
        id: 'FEAT-CHARLIE',
        slug: 'charlie',
        title: 'Charlie',
        status: 'done',
        tickets: 0,
        ticketsByState: {},
        tag: 'factory/charlie/2026-09-01',
      },
    ]);
    expect(report.totals).toEqual({ features: 3, tickets: 4 });
  });

  it('lists a paused ticket and a paused feature in needs_human', async () => {
    await mixedVault();

    expect((await buildStatusReport(resolution())).needs_human).toEqual([
      {
        id: 'FEAT-ALPHA-T004',
        title: 'Ticket 4',
        status: 'needs_human',
        pause_reason: 'attempts_exhausted',
        pause_detail: 'three failed attempts',
      },
      {
        id: 'FEAT-BRAVO',
        title: 'Bravo',
        status: 'needs_human',
        pause_reason: 'checkpoint',
        pause_detail: 'after_pm_refinement',
      },
    ]);
  });
});

describe('runStatus prints the report buildStatusReport builds', () => {
  it('--json prints it byte for byte', async () => {
    await mixedVault();

    const returned = await runStatus({ vault: vault.root, json: true }, deps());

    const built = await buildStatusReport(resolution());
    expect(output.join('\n')).toBe(JSON.stringify(built, null, 2));
    expect(returned).toEqual(built);
  });

  it('without --json prints formatReport of it', async () => {
    await mixedVault();

    await runStatus({ vault: vault.root }, deps());

    expect(output).toEqual(formatReport(await buildStatusReport(resolution())));
  });
});

describe('factory status output (characterisation, unchanged by the extraction)', () => {
  it('prints the same human summary it printed before', async () => {
    await mixedVault();

    await runStatus({ vault: vault.root }, deps());

    expect(output).toEqual([
      `Vault:      ${vault.root}`,
      `Repo:       ${vault.repo.path} @ ${vault.repo.branch}`,
      'Orchestrator: stopped',
      '',
      'Features:',
      '  alpha  in_development  4 ticket(s)  in_progress=1 done=2 needs_human=1',
      '  bravo  needs_human  0 ticket(s)',
      '  charlie  done  0 ticket(s)  tag factory/charlie/2026-09-01',
      '',
      'Needs human: 2',
      '  FEAT-ALPHA-T004  attempts_exhausted',
      '  FEAT-BRAVO  checkpoint',
      'Running agents: 0',
    ]);
  });

  it('prints the same JSON it printed before', async () => {
    await mixedVault();

    await runStatus({ vault: vault.root, json: true }, deps());

    const printed = JSON.parse(output.join('\n')) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual([
      'vault',
      'project',
      'source',
      'target_repo',
      'base_branch',
      'orchestrator',
      'features',
      'totals',
      'needs_human',
      'running',
    ]);
    expect(printed['orchestrator']).toBe('stopped');
    expect(printed['totals']).toEqual({ features: 3, tickets: 4 });
    expect(printed['running']).toEqual([]);
  });
});

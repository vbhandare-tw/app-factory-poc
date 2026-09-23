/**
 * `addFeature` creates a feature from requirement text, and `factory feature
 * add` reads the file and delegates to it (plan Phase 1). The command's output
 * and refusal messages are unchanged.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../../src/config/registry.js';
import type { CliDeps } from '../../../src/cli/deps.js';
import { CliError } from '../../../src/cli/deps.js';
import { addFeature, FeatureAddError, runFeatureAdd } from '../../../src/cli/featureAdd.js';
import type { FeatureAddScope } from '../../../src/cli/featureAdd.js';
import { buildProgram } from '../../../src/cli/main.js';
import { ALL_FEATURE_STATES } from '../../../src/domain/states.js';
import type { FeatureState } from '../../../src/domain/states.js';
import type { FeatureFrontmatter, FeatureNote } from '../../../src/domain/types.js';
import { serializeNote } from '../../../src/vault/note.js';
import { makeFeature } from '../../helpers/notes.js';
import { factoryVault } from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
} from '../../helpers/toyRepo.js';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };
const NOW = '2026-09-01T10:00:00.000Z';

const REQUIREMENT =
  '# Add subtract\n\nThe calculator should subtract.\n\n```ts\nsubtract(3, 1)\n```\n';

/** Fenced one backtick longer than the fence inside it, and never rewritten. */
const RAW_SECTION =
  '## Raw Requirement\n\n````markdown\n# Add subtract\n\nThe calculator should subtract.\n\n' +
  '```ts\nsubtract(3, 1)\n```\n````\n';

let vault: FactoryFixture;
let home: string;
let workspace: string;
let output: string[];

function expectedNote(overrides: Partial<FeatureFrontmatter> = {}): FeatureNote {
  return {
    frontmatter: {
      type: 'feature',
      id: 'FEAT-SAMPLE',
      title: 'Add subtract',
      status: 'intake',
      slug: 'sample',
      priority: 'medium',
      feature_branch: null,
      tag: null,
      verified_sha: null,
      base_verified_sha: null,
      approved_sha: null,
      approved_note: null,
      approved_tag: null,
      attempts: 0,
      cost_usd: 0,
      created_at: NOW,
      updated_at: NOW,
      locked_by: null,
      locked_at: null,
      pause_reason: null,
      pause_detail: null,
      resume_to: null,
      reject_to: null,
      paused_at: null,
      ...overrides,
    },
    body: RAW_SECTION,
  };
}

function scope(): FeatureAddScope {
  return { paths: vault.paths, storage: vault.storage, now: () => NOW };
}

function deps(): CliDeps {
  return {
    cwd: workspace,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: (line: string) => output.push(line),
    err: () => undefined,
    now: () => NOW,
  };
}

async function factory(args: readonly string[]): Promise<void> {
  await buildProgram(deps(), MANIFEST).parseAsync(['node', 'factory', ...args]);
}

function requirementFile(name: string, contents = REQUIREMENT): string {
  const file = path.join(workspace, name);
  writeFileSync(file, contents, 'utf8');
  return file;
}

function featureDirs(): string[] {
  return readdirSync(vault.paths.featuresDir()).filter((name) => !name.startsWith('.'));
}

/** A feature already in the vault, in any stage — the way a hand edit or the loop leaves it. */
async function existingFeature(slug: string, status: FeatureState): Promise<void> {
  await vault.storage.writeNote(
    vault.paths.featureNote(slug),
    makeFeature({ id: `FEAT-${slug.toUpperCase()}`, slug, title: slug, status }),
  );
}

function a9Message(id: string, stage: string): string {
  return (
    `${id} is still in progress (${stage}). The factory builds one feature at a time until M4; ` +
    'finish it first.'
  );
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  return await promise.then(
    () => {
      throw new Error('expected a refusal, but the call succeeded');
    },
    (error: unknown) => error as Error,
  );
}

beforeEach(() => {
  vault = factoryVault();
  home = scratchFactoryHome();
  workspace = scratchDir('feature-add-workspace-');
  output = [];
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

describe('addFeature', () => {
  it('creates feature.md in intake with ## Raw Requirement holding the text verbatim', async () => {
    const result = await addFeature(scope(), {
      slug: 'sample',
      priority: 'medium',
      requirement: REQUIREMENT,
    });

    const file = vault.paths.featureNote('sample');
    expect(result).toEqual({ id: 'FEAT-SAMPLE', slug: 'sample', title: 'Add subtract', path: file });
    expect(readFileSync(file, 'utf8')).toBe(serializeNote(expectedNote()));
    expect(readFileSync(vault.paths.indexFile(), 'utf8')).toContain('sample');
  });

  it('takes the title from an explicit title, then the first heading, then the slug', async () => {
    const titled = await addFeature(scope(), {
      slug: 'titled',
      priority: 'high',
      requirement: REQUIREMENT,
      title: 'Given title',
    });
    await existingFeature('titled', 'done');
    const headed = await addFeature(scope(), {
      slug: 'headed',
      priority: 'low',
      requirement: REQUIREMENT,
    });
    await existingFeature('headed', 'done');
    const bare = await addFeature(scope(), {
      slug: 'bare',
      priority: 'medium',
      requirement: 'no heading anywhere\n',
    });

    expect([titled.title, headed.title, bare.title]).toEqual(['Given title', 'Add subtract', 'bare']);
  });

  it.each(['../x', '', 'a/b'])('rejects the unsafe slug %j and writes nothing', async (slug) => {
    const before = featureDirs();

    const error = await refusal(
      addFeature(scope(), { slug, priority: 'medium', requirement: REQUIREMENT }),
    );

    expect(error).toBeInstanceOf(FeatureAddError);
    expect((error as FeatureAddError).reason).toBe('slug');
    expect(error.message).toContain(JSON.stringify(slug));
    expect(featureDirs()).toEqual(before);
  });

  it('rejects a duplicate slug, names the existing feature, and leaves it untouched', async () => {
    await addFeature(scope(), { slug: 'sample', priority: 'medium', requirement: REQUIREMENT });
    const file = vault.paths.featureNote('sample');
    const before = readFileSync(file, 'utf8');

    const error = await refusal(
      addFeature(scope(), { slug: 'sample', priority: 'high', requirement: '# Other\n' }),
    );

    expect(error).toBeInstanceOf(FeatureAddError);
    expect((error as FeatureAddError).reason).toBe('duplicate');
    expect(error.message).toContain('FEAT-SAMPLE');
    expect(error.message).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('treats a feature directory with no feature.md as free, as before', async () => {
    mkdirSync(vault.paths.featureDir('sample'), { recursive: true });

    await addFeature(scope(), { slug: 'sample', priority: 'medium', requirement: REQUIREMENT });

    expect(readFileSync(vault.paths.featureNote('sample'), 'utf8')).toBe(
      serializeNote(expectedNote()),
    );
  });

  it('rejects an invalid priority and writes nothing', async () => {
    const error = await refusal(
      addFeature(scope(), { slug: 'sample', priority: 'urgent', requirement: REQUIREMENT }),
    );

    expect(error).toBeInstanceOf(FeatureAddError);
    expect((error as FeatureAddError).reason).toBe('priority');
    expect(error.message).toContain('"urgent"');
    expect(existsSync(vault.paths.featureNote('sample'))).toBe(false);
  });
});

describe('addFeature while another feature is active (plan A9)', () => {
  const activeStages = ALL_FEATURE_STATES.filter((stage) => stage !== 'done');

  it.each(activeStages)(
    'refuses while another feature is in %s, naming it and its stage, and writes nothing',
    async (stage) => {
      await existingFeature('alpha', stage);

      const error = await refusal(
        addFeature(scope(), { slug: 'sample', priority: 'medium', requirement: REQUIREMENT }),
      );

      expect(error).toBeInstanceOf(FeatureAddError);
      expect((error as FeatureAddError).reason).toBe('in_progress');
      expect(error.message).toBe(a9Message('FEAT-ALPHA', stage));
      expect(existsSync(vault.paths.featureDir('sample'))).toBe(false);
    },
  );

  it('succeeds when every other feature is done', async () => {
    await existingFeature('alpha', 'done');
    await existingFeature('bravo', 'done');

    const result = await addFeature(scope(), {
      slug: 'sample',
      priority: 'medium',
      requirement: REQUIREMENT,
    });

    expect(result.id).toBe('FEAT-SAMPLE');
    expect(readFileSync(vault.paths.featureNote('sample'), 'utf8')).toBe(
      serializeNote(expectedNote()),
    );
  });

  it('names the active feature, not a done one beside it', async () => {
    await existingFeature('alpha', 'done');
    await existingFeature('bravo', 'planning');

    const error = await refusal(
      addFeature(scope(), { slug: 'sample', priority: 'medium', requirement: REQUIREMENT }),
    );

    expect(error.message).toBe(a9Message('FEAT-BRAVO', 'planning'));
  });

  it('does not count a feature note it cannot read, which the loop quarantines too', async () => {
    mkdirSync(vault.paths.featureDir('broken'), { recursive: true });
    writeFileSync(vault.paths.featureNote('broken'), '---\nstatus: [unclosed\n---\n', 'utf8');

    const result = await addFeature(scope(), {
      slug: 'sample',
      priority: 'medium',
      requirement: REQUIREMENT,
    });

    expect(result.id).toBe('FEAT-SAMPLE');
  });

  it('factory feature add surfaces the refusal as a CliError with the same text', async () => {
    await existingFeature('alpha', 'refining');
    const source = requirementFile('sample.md');

    const error = await refusal(runFeatureAdd({ file: source, vault: vault.root }, deps()));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect(error.message).toBe(a9Message('FEAT-ALPHA', 'refining'));
    expect(output).toEqual([]);
    expect(existsSync(vault.paths.featureDir('sample'))).toBe(false);
  });
});

describe('factory feature add (characterisation, unchanged by the extraction)', () => {
  it('prints the same two lines and writes the same note', async () => {
    const source = requirementFile('sample.md');

    await factory(['feature', 'add', source, '--vault', vault.root]);

    const file = vault.paths.featureNote('sample');
    expect(output).toEqual(['Added FEAT-SAMPLE (sample) in intake', `  note: ${file}`]);
    expect(readFileSync(file, 'utf8')).toBe(serializeNote(expectedNote()));
  });

  it('passes --slug and --priority through', async () => {
    const source = requirementFile('whatever.md');

    await factory(['feature', 'add', source, '--slug', 'sample', '--priority', 'high', '--vault', vault.root]);

    expect(readFileSync(vault.paths.featureNote('sample'), 'utf8')).toBe(
      serializeNote(expectedNote({ priority: 'high' })),
    );
  });

  it('refuses an unsafe --slug with the message it always gave', async () => {
    const source = requirementFile('sample.md');

    const error = await refusal(
      runFeatureAdd({ file: source, slug: '../x', vault: vault.root }, deps()),
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      'sample.md does not give a usable feature slug ("../x"). Rename the file, or pass --slug.',
    );
  });

  it('refuses a filename with no usable slug with the message it always gave', async () => {
    const source = requirementFile('!!!.md');

    const error = await refusal(runFeatureAdd({ file: source, vault: vault.root }, deps()));

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      '!!!.md does not give a usable feature slug (""). Rename the file, or pass --slug.',
    );
  });

  it('refuses a duplicate with the message it always gave', async () => {
    const source = requirementFile('sample.md');
    await factory(['feature', 'add', source, '--vault', vault.root]);

    const error = await refusal(runFeatureAdd({ file: source, vault: vault.root }, deps()));

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      `${vault.paths.featureNote('sample')} already exists — feature sample is already in this ` +
        'vault. Delete it or use a different filename.',
    );
  });

  it('refuses a bad --priority with the message it always gave, before resolving the vault', async () => {
    const source = requirementFile('sample.md');

    const error = await refusal(
      runFeatureAdd(
        { file: source, priority: 'urgent', vault: path.join(workspace, 'no-such-vault') },
        deps(),
      ),
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe('--priority must be one of high, medium, low, not "urgent"');
  });

  it('refuses a missing requirement file with the message it always gave', async () => {
    const missing = path.join(workspace, 'missing.md');

    const error = await refusal(runFeatureAdd({ file: missing, vault: vault.root }, deps()));

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(`no such requirement file: ${missing}`);
  });
});

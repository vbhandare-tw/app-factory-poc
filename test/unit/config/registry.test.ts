/**
 * The project registry — `~/.app-factory/projects.yml`.
 *
 * Not in the plan's Section C file list, added because the registry is the one
 * Phase 4 component that writes outside the vault and outside the target repo.
 * Its home is a constructor argument precisely so tests can exercise it without
 * touching the operator's real one, and that seam deserves its own coverage
 * rather than only being exercised through the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_REGISTRY,
  ProjectRegistry,
  RegistryError,
  factoryHomeFromEnv,
} from '../../../src/config/registry.js';
import {
  assertNotRealFactoryHome,
  cleanupAllScratchDirs,
  realFactoryHome,
  removeScratchDir,
  scratchFactoryHome,
} from '../../helpers/toyRepo.js';

let home: string;
let registry: ProjectRegistry;

beforeEach(() => {
  home = scratchFactoryHome();
  registry = new ProjectRegistry(home);
});

afterEach(() => {
  removeScratchDir(home);
});

afterAll(() => {
  cleanupAllScratchDirs();
});

describe('the injected home', () => {
  it('puts projects.yml inside the home it was given', () => {
    expect(registry.file).toBe(path.join(home, 'projects.yml'));
  });

  it('never falls back to the real home when constructed directly', async () => {
    await registry.registerProject({ name: 'toy', vault: path.join(home, 'vault') });

    expect(existsSync(registry.file)).toBe(true);
    expect(existsSync(path.join(realFactoryHome(), 'projects.yml'))).toBe(false);
  });

  it('fromEnv prefers FACTORY_HOME over the real home', () => {
    expect(ProjectRegistry.fromEnv({ FACTORY_HOME: home }, '/home/someone').home).toBe(home);
    expect(factoryHomeFromEnv({ FACTORY_HOME: '  ' }, '/home/someone')).toBe(
      path.join('/home/someone', '.app-factory'),
    );
  });

  it('fromEnv with no override is the only path to the real home, and it is the real one', () => {
    // Asserting the default rather than exercising it: this is the value the
    // CLI layer supplies in production, and nothing in the test suite may use it.
    expect(ProjectRegistry.fromEnv({}, os.homedir()).home).toBe(realFactoryHome());
    expect(() => assertNotRealFactoryHome(ProjectRegistry.fromEnv({}, os.homedir()).home)).toThrow();
  });
});

describe('reading', () => {
  it('treats an absent file as an empty registry — a first run is normal', async () => {
    expect(await registry.read()).toEqual(EMPTY_REGISTRY);
    expect(await registry.listProjects()).toEqual([]);
    expect(await registry.defaultProject()).toBeUndefined();
  });

  it('treats an empty file as an empty registry', async () => {
    writeFileSync(registry.file, '', 'utf8');
    expect(await registry.read()).toEqual(EMPTY_REGISTRY);
  });

  it('reads a hand-written registry', async () => {
    writeFileSync(
      registry.file,
      ['version: 1', 'default: beta', 'projects:', '  beta:', '    vault: /vaults/beta', ''].join(
        '\n',
      ),
      'utf8',
    );

    const data = await registry.read();
    expect(data.default).toBe('beta');
    expect(data.projects).toEqual([
      { name: 'beta', vault: path.resolve('/vaults/beta'), repo: null, registered_at: null },
    ]);
  });

  it('rejects a project entry with no vault path rather than half-loading it', async () => {
    writeFileSync(registry.file, 'projects:\n  broken:\n    repo: /somewhere\n', 'utf8');
    await expect(registry.read()).rejects.toThrow(RegistryError);
  });

  it('rejects unparseable YAML naming the file', async () => {
    writeFileSync(registry.file, 'projects: [unclosed\n', 'utf8');
    await expect(registry.read()).rejects.toThrow(new RegExp(registry.file.replace(/\//g, '\\/')));
  });

  it('ignores a default naming a project that is not there, leaving resolution to complain', async () => {
    writeFileSync(registry.file, 'default: ghost\nprojects: {}\n', 'utf8');
    expect((await registry.read()).default).toBe('ghost');
    expect(await registry.defaultProject()).toBeUndefined();
  });
});

describe('registering', () => {
  it('makes the first project the default', async () => {
    await registry.registerProject({ name: 'one', vault: '/vaults/one' });
    expect((await registry.read()).default).toBe('one');
  });

  it('leaves the default alone when a second project is added', async () => {
    await registry.registerProject({ name: 'one', vault: '/vaults/one' });
    await registry.registerProject({ name: 'two', vault: '/vaults/two' });

    const data = await registry.read();
    expect(data.default).toBe('one');
    expect(data.projects.map((project) => project.name)).toEqual(['one', 'two']);
  });

  it('moves the default when asked explicitly', async () => {
    await registry.registerProject({ name: 'one', vault: '/vaults/one' });
    await registry.registerProject({ name: 'two', vault: '/vaults/two', makeDefault: true });
    expect((await registry.read()).default).toBe('two');
  });

  it('replaces an existing entry rather than duplicating the name', async () => {
    await registry.registerProject({ name: 'one', vault: '/vaults/one' });
    await registry.registerProject({ name: 'one', vault: '/vaults/moved', repo: '/repo' });

    const projects = await registry.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ vault: path.resolve('/vaults/moved'), repo: path.resolve('/repo') });
  });

  it('resolves relative paths so a later cwd cannot change what was registered', async () => {
    await registry.registerProject({ name: 'one', vault: 'relative/vault' });
    expect((await registry.listProjects())[0]?.vault).toBe(path.resolve('relative/vault'));
  });

  it('refuses an empty name', async () => {
    await expect(registry.registerProject({ name: '   ', vault: '/v' })).rejects.toThrow(
      RegistryError,
    );
  });

  it('writes a file that reads back identically', async () => {
    await registry.registerProject({
      name: 'toy',
      vault: '/vaults/toy',
      repo: '/repos/toy',
      registeredAt: '2026-09-01T00:00:00Z',
    });

    const first = await registry.read();
    const text = readFileSync(registry.file, 'utf8');
    await registry.write(first);

    expect(readFileSync(registry.file, 'utf8')).toBe(text);
    expect(await registry.read()).toEqual(first);
  });

  it('finds a project by name', async () => {
    await registry.registerProject({ name: 'toy', vault: '/vaults/toy' });
    expect((await registry.findProject('toy'))?.name).toBe('toy');
    expect(await registry.findProject('nope')).toBeUndefined();
  });
});

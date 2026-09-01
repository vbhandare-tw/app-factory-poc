/**
 * `factory init`, `factory projects` and `factory status` end to end (M1).
 *
 * Real commander parsing, a real vault written to disk, and a real git repo.
 * The one thing that is *not* real is the factory home: every command runs
 * against a scratch `~/.app-factory` created by `scratchFactoryHome()`, which
 * refuses to hand back a path inside the operator's actual `~/.app-factory`.
 *
 * That fence is the whole reason this file is shaped the way it is. `factory
 * init` registers a project by writing `~/.app-factory/projects.yml`. A test that
 * reached the real one would **pass** — pass here, pass twice, pass in CI —
 * while rewriting the operator's registry and leaving state that makes the next
 * run behave differently. No assertion catches that afterwards, so the location
 * is injected (`CliDeps.registry`) rather than trusted, and the last test in
 * this file asserts the real path was never even created.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/load.js';
import {
  FACTORY_HOME_DIRNAME,
  ProjectRegistry,
  factoryHomeFromEnv,
} from '../../src/config/registry.js';
import { OWNER_REF, readOwnerRef, validateStartup } from '../../src/config/validate.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { CliError } from '../../src/cli/deps.js';
import { buildProgram, main } from '../../src/cli/main.js';
import { VAULT_TEMPLATE_DIR } from '../../src/cli/init.js';
import { buildIndex } from '../../src/vault/index-md.js';
import { VaultPaths } from '../../src/vault/paths.js';
import {
  assertNotRealFactoryHome,
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  foreignFactoryHome,
  git,
  realFactoryHome,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
  toyRepo,
} from '../helpers/toyRepo.js';
import type { ToyRepo } from '../helpers/toyRepo.js';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };

let home: string;
let workspace: string;
let repo: ToyRepo;
let output: string[];
let errors: string[];

/** Deps pointed at a disposable home, a scratch cwd, and captured output. */
function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  assertNotRealFactoryHome(home);
  return {
    cwd: overrides.cwd ?? workspace,
    env: overrides.env ?? {},
    registry: overrides.registry ?? new ProjectRegistry(home),
    out: overrides.out ?? ((line) => output.push(line)),
    err: overrides.err ?? ((line) => errors.push(line)),
    now: overrides.now ?? ((): string => '2026-09-01T00:00:00Z'),
  };
}

/** Run a factory command exactly as the binary would. */
async function factory(args: readonly string[], overrides: Partial<CliDeps> = {}): Promise<void> {
  await buildProgram(deps(overrides), MANIFEST).parseAsync(['node', 'factory', ...args]);
}

beforeEach(() => {
  home = scratchFactoryHome();
  workspace = scratchDir('cli-workspace-');
  repo = toyRepo();
  output = [];
  errors = [];
});

afterEach(() => {
  removeScratchDir(home);
  removeScratchDir(workspace);
  repo.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('factory init', () => {
  it('creates a vault that loadConfig validates, bound to the repo and registered', async () => {
    const vault = path.join(workspace, 'my-vault');

    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    // 1. The vault exists with the template's shape.
    const paths = new VaultPaths(vault);
    expect(existsSync(paths.configFile())).toBe(true);
    expect(existsSync(paths.projectFile())).toBe(true);
    expect(existsSync(paths.indexFile())).toBe(true);
    expect(existsSync(paths.techDir())).toBe(true);
    expect(existsSync(paths.featuresDir())).toBe(true);
    expect(existsSync(paths.logsDir())).toBe(true);

    // 2. Its config validates and carries the repo binding.
    const config = await loadConfig(vault);
    expect(config.target_repo).toBe(repo.path);
    expect(config.base_branch).toBe(repo.branch);
    expect(config.max_parallel_devs).toBe(1);
    expect(config.setup_command).toBe('npm ci');
    expect(config.sandbox_extra_read).toEqual([]);

    // 3. The project is registered, in the scratch home and nowhere else.
    const registry = await new ProjectRegistry(home).read();
    expect(registry.projects).toEqual([
      {
        name: 'toy',
        vault,
        repo: repo.path,
        registered_at: '2026-09-01T00:00:00Z',
      },
    ]);
    expect(registry.default).toBe('toy');

    // 4. The repo carries the owner marker.
    expect(readOwnerRef(repo.path)).toBe(vault);
    expect(git(repo.path, ['cat-file', '-p', OWNER_REF])).toContain(vault);

    // 5. And the whole thing passes startup validation.
    expect(validateStartup({ vaultPath: vault, config })).toEqual([]);
  });

  it('keeps the template comments in the written config', async () => {
    const vault = path.join(workspace, 'commented');
    await factory(['init', '--vault', vault, '--repo', repo.path]);

    const text = readFileSync(new VaultPaths(vault).configFile(), 'utf8');
    expect(text).toContain('# Factory configuration (spec §11).');
    expect(text).toContain('so a higher value is rejected');
    expect(text).toContain('plan resolution A2');
    expect(text).toMatch(/^target_repo: "/m);
  });

  it('defaults the project name to the vault directory name', async () => {
    const vault = path.join(workspace, 'unnamed-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path]);

    expect((await new ProjectRegistry(home).listProjects()).map((p) => p.name)).toEqual([
      'unnamed-vault',
    ]);
  });

  it('refuses a repo that is not a git repository, and writes no vault', async () => {
    const plain = scratchDir('plain-dir-');
    const vault = path.join(workspace, 'never');
    try {
      await expect(factory(['init', '--vault', vault, '--repo', plain])).rejects.toThrow(CliError);
      expect(existsSync(vault)).toBe(false);
      expect(await new ProjectRegistry(home).listProjects()).toEqual([]);
    } finally {
      removeScratchDir(plain);
    }
  });

  it('refuses to overwrite an existing vault', async () => {
    const vault = path.join(workspace, 'twice');
    await factory(['init', '--vault', vault, '--repo', repo.path]);

    await expect(factory(['init', '--vault', vault, '--repo', repo.path])).rejects.toThrow(
      /already contains a config\.yml/,
    );
  });
});

describe('two vaults, one repo', () => {
  it('rejects the second init on the owner ref and leaves the first binding intact', async () => {
    const first = path.join(workspace, 'vault-one');
    const second = path.join(workspace, 'vault-two');

    await factory(['init', '--vault', first, '--repo', repo.path, '--name', 'one']);

    let caught: unknown;
    try {
      await factory(['init', '--vault', second, '--repo', repo.path, '--name', 'two']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain(first);
    expect((caught as CliError).message).toContain('refs/factory/owner');

    // Nothing partial: the second vault was never created and never registered,
    // and the repo still belongs to the first.
    expect(existsSync(second)).toBe(false);
    expect(readOwnerRef(repo.path)).toBe(first);
    expect((await new ProjectRegistry(home).listProjects()).map((p) => p.name)).toEqual(['one']);
  });

  it('re-initialising the same vault path onto the same repo is still refused, on the vault', async () => {
    const vault = path.join(workspace, 'vault-one');
    await factory(['init', '--vault', vault, '--repo', repo.path]);
    await expect(factory(['init', '--vault', vault, '--repo', repo.path])).rejects.toThrow(CliError);
  });

  it('does not mistake a symlinked spelling of its own vault for a different owner', async () => {
    // `path.resolve` does not follow symlinks. Comparing owner-ref paths
    // without canonicalising reports the vault as owned by someone else, and
    // the operator is told to delete a ref that is theirs. Build the symlink
    // rather than relying on the platform handing one out.
    const base = scratchDir('init-symlink-');
    const realRoot = path.join(base, 'real');
    const linkRoot = path.join(base, 'link');
    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, linkRoot, 'dir');

    try {
      const viaLink = path.join(linkRoot, 'vault');
      const viaReal = path.join(realRoot, 'vault');

      await factory(['init', '--vault', viaLink, '--repo', repo.path, '--name', 'sym']);

      // Re-initialising the same vault through its other spelling must be
      // refused *because the vault already exists*, never because the owner
      // ref looks foreign.
      let caught: unknown;
      try {
        await factory(['init', '--vault', viaReal, '--repo', repo.path, '--name', 'sym2']);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).message).toMatch(/already contains a config\.yml/);
      expect((caught as CliError).message).not.toMatch(/already owned by the vault/);
    } finally {
      removeScratchDir(base);
    }
  });
});

describe('factory status', () => {
  it('resolves through the registry from an unrelated directory and reports zero features', async () => {
    const vault = path.join(workspace, 'status-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const unrelated = scratchDir('somewhere-else-');
    try {
      output = [];
      await factory(['status', 'toy', '--json'], { cwd: unrelated });

      const report = JSON.parse(output.join('\n')) as {
        vault: string;
        project: string;
        source: string;
        target_repo: string;
        totals: { features: number; tickets: number };
        features: unknown[];
        needs_human: unknown[];
        orchestrator: string;
      };

      expect(report.vault).toBe(vault);
      expect(report.project).toBe('toy');
      expect(report.source).toBe('project');
      expect(report.target_repo).toBe(repo.path);
      expect(report.totals).toEqual({ features: 0, tickets: 0 });
      expect(report.features).toEqual([]);
      expect(report.needs_human).toEqual([]);
      expect(report.orchestrator).toBe('stopped');
    } finally {
      removeScratchDir(unrelated);
    }
  });

  it('falls back to the registry default when no project is named', async () => {
    const vault = path.join(workspace, 'default-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const unrelated = scratchDir('somewhere-else-');
    try {
      output = [];
      await factory(['status', '--json'], { cwd: unrelated });
      const report = JSON.parse(output.join('\n')) as { source: string; vault: string };
      expect([report.source, report.vault]).toEqual(['registry-default', vault]);
    } finally {
      removeScratchDir(unrelated);
    }
  });

  it('--vault at a directory with no config.yml errors instead of using the default', async () => {
    const vault = path.join(workspace, 'real-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const typo = scratchDir('not-a-vault-');
    try {
      await expect(factory(['status', '--vault', typo])).rejects.toThrow(/not a factory vault/);
    } finally {
      removeScratchDir(typo);
    }
  });

  it('prints a human summary without --json', async () => {
    const vault = path.join(workspace, 'human-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    output = [];
    await factory(['status', 'toy']);

    expect(output.join('\n')).toContain('No features yet');
    expect(output.join('\n')).toContain(repo.path);
  });
});

describe('factory projects', () => {
  it('lists what init registered and marks the default', async () => {
    const vault = path.join(workspace, 'listed');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    output = [];
    await factory(['projects', '--json']);

    const listing = JSON.parse(output.join('\n')) as {
      default: string;
      projects: { name: string; vault: string; isDefault: boolean; state: string }[];
    };

    expect(listing.default).toBe('toy');
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0]).toMatchObject({
      name: 'toy',
      vault,
      isDefault: true,
      state: 'stopped',
    });
  });

  it('says so plainly when nothing is registered', async () => {
    await factory(['projects']);
    expect(output.join('\n')).toContain('No projects registered');
  });
});

describe('startup validation catches a repo that went away', () => {
  /**
   * The plan's Phase 4 integration list has "`factory start` … spawns no agent
   * process — assert by injecting a Runner that throws if called". `factory
   * start` is Phase 7a and no Runner exists yet, so the half that *is* testable
   * now is covered here: the check that would stop `start` before it ever got
   * as far as a Runner. The Runner-injection half moves to Phase 7a.
   */
  it('reports a clear failure naming the missing repo', async () => {
    const vault = path.join(workspace, 'orphaned');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const config = await loadConfig(vault);
    const repoPath = repo.path;
    rmSync(repoPath, { recursive: true, force: true });

    const failures = validateStartup({ vaultPath: vault, config });

    expect(failures.map((failure) => failure.code)).toEqual(['target_repo_missing']);
    expect(failures[0]?.message).toContain(repoPath);
  });
});

describe('the vault template', () => {
  it('matches what the index regenerator produces for an empty vault', async () => {
    // If these ever diverge, the first regeneration after `init` writes a
    // spurious diff into the vault's git history for no state change at all.
    const template = readFileSync(path.join(VAULT_TEMPLATE_DIR, 'index.md'), 'utf8');
    expect(template).toBe(buildIndex([]));
  });

  it('its config.yml is not valid on its own — init must bind a repo', async () => {
    const bare = path.join(workspace, 'unbound');
    mkdirSync(bare, { recursive: true });
    const { cp } = await import('node:fs/promises');
    await cp(VAULT_TEMPLATE_DIR, bare, { recursive: true });

    await expect(loadConfig(bare)).rejects.toThrow(ConfigError);
  });
});

describe('main() — error to exit code', () => {
  /**
   * `buildProgram` throws; `main` is what turns that into an exit code and a
   * printed message. Nothing else in this file exercises `main`, so without
   * these the mapping is only ever confirmed by hand — and "the CLI exits 1 on
   * a bad repo" is exactly the claim that quietly stops being true.
   *
   * `process.exitCode` is process-global, so every test here restores it.
   */
  async function runMain(args: readonly string[]): Promise<number | undefined> {
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await main(['node', 'factory', ...args], deps());
      return process.exitCode;
    } finally {
      process.exitCode = previous ?? 0;
    }
  }

  it('maps a CliError to exit code 1 and prints the message, with no stack trace', async () => {
    const plain = scratchDir('plain-dir-');
    try {
      const code = await runMain([
        'init',
        '--vault',
        path.join(workspace, 'never'),
        '--repo',
        plain,
      ]);

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('is not a git repository');
      // A human-facing message, not a dump: no stack frames, no error name.
      expect(errors.join('\n')).not.toMatch(/\n\s+at /);
      expect(errors.join('\n')).not.toContain('CliError:');
    } finally {
      removeScratchDir(plain);
    }
  });

  it('leaves the exit code at 0 on success', async () => {
    const code = await runMain([
      'init',
      '--vault',
      path.join(workspace, 'ok-vault'),
      '--repo',
      repo.path,
      '--name',
      'ok',
    ]);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
  });

  it('maps a resolution failure to a clean message and exit code 1, not a stack trace', async () => {
    const typo = scratchDir('not-a-vault-');
    try {
      const code = await runMain(['status', '--vault', typo]);

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain('not a factory vault');
      expect(errors.join('\n')).not.toMatch(/\n\s+at /);
    } finally {
      removeScratchDir(typo);
    }
  });

  it('maps a bad config.yml to a clean message and exit code 1', async () => {
    const vault = path.join(workspace, 'broken-config');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);
    writeFileSync(new VaultPaths(vault).configFile(), 'target_repo: "/x"\nnonsense: 1\n', 'utf8');

    errors = [];
    const code = await runMain(['status', 'toy']);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('nonsense');
    expect(errors.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('still lets a genuine defect through with its stack — that message is for us', async () => {
    // The escape hatch must stay open: an unexpected error is a bug in the
    // factory, and swallowing it into a one-line message would hide it.
    const exploding: CliDeps = {
      ...deps(),
      registry: {
        ...new ProjectRegistry(home),
        read: async (): Promise<never> => {
          throw new TypeError('boom — a real defect');
        },
      } as unknown as ProjectRegistry,
    };

    await expect(main(['node', 'factory', 'projects'], exploding)).rejects.toThrow(
      /boom — a real defect/,
    );
  });
});

describe('the .runs registry read', () => {
  it('reports a running agent, and quarantines a filename the path seam rejects', async () => {
    const vault = path.join(workspace, 'runs-vault');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const runsDir = new VaultPaths(vault).runsDir();
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      path.join(runsDir, 'FEAT-X-T001-developer-1.json'),
      JSON.stringify({ role: 'developer', ticket: 'FEAT-X-T001', pid: 4242 }),
      'utf8',
    );
    // A name the segment validator refuses. It must be reported, not thrown on,
    // and **not read** — `factory status` has to stay usable when things are
    // odd. The contents are deliberately well-formed and distinctive: an empty
    // `{}` would produce the same all-null row whether the seam rejected the
    // name or the file was read, so the test could not tell the two apart.
    writeFileSync(
      path.join(runsDir, '..hidden.json'),
      JSON.stringify({ role: 'smuggled', ticket: 'SMUGGLED', pid: 99 }),
      'utf8',
    );

    output = [];
    await factory(['status', 'toy', '--json']);
    const report = JSON.parse(output.join('\n')) as {
      running: { run_id: string; role: string | null; pid: number | null }[];
    };

    expect(report.running).toHaveLength(2);
    expect(report.running).toContainEqual({
      run_id: 'FEAT-X-T001-developer-1',
      role: 'developer',
      item: 'FEAT-X-T001',
      pid: 4242,
    });
    expect(report.running).toContainEqual({
      run_id: '..hidden',
      role: null,
      item: null,
      pid: null,
    });
  });
});

describe('the home-directory fence', () => {
  it('never writes the operator real ~/.app-factory/projects.yml', async () => {
    const vault = path.join(workspace, 'fenced');
    await factory(['init', '--vault', vault, '--repo', repo.path, '--name', 'toy']);

    const registryFile = new ProjectRegistry(home).file;
    expect(existsSync(registryFile)).toBe(true);
    expect(registryFile.startsWith(`${home}${path.sep}`)).toBe(true);

    // The real path, computed the same way production computes it.
    const real = path.join(realFactoryHome(), 'projects.yml');
    expect(registryFile).not.toBe(real);
    expect(existsSync(real)).toBe(false);

    // And nothing was written into the directory another tool owns either.
    expect(existsSync(path.join(foreignFactoryHome(), 'projects.yml'))).toBe(false);
  });

  it('refuses a scratch home that resolves inside the real one', () => {
    expect(() => assertNotRealFactoryHome(realFactoryHome())).toThrow(/refusing to use/);
    expect(() => assertNotRealFactoryHome(path.join(realFactoryHome(), 'nested'))).toThrow(
      /refusing to use/,
    );
  });

  it('also refuses ~/.factory, which belongs to a different installed tool', () => {
    // We renamed away from `~/.factory` because Factory.ai's CLI owns it. The
    // fence keeps refusing it so a stray default can never reach either
    // directory, and so an accidental revert of FACTORY_HOME_DIRNAME is caught
    // by a test rather than by an operator losing their auth.json.
    expect(() => assertNotRealFactoryHome(foreignFactoryHome())).toThrow(/refusing to use/);
    expect(() => assertNotRealFactoryHome(path.join(foreignFactoryHome(), 'sessions'))).toThrow(
      /another tool's/,
    );
  });

  it('defaults to ~/.app-factory, never to the directory another tool owns', () => {
    expect(factoryHomeFromEnv({}, '/home/someone')).toBe(path.join('/home/someone', '.app-factory'));
    expect(factoryHomeFromEnv({}, '/home/someone')).not.toBe(path.join('/home/someone', '.factory'));
    expect(FACTORY_HOME_DIRNAME).toBe('.app-factory');
  });

  it('FACTORY_HOME redirects the registry away from the real home', () => {
    expect(factoryHomeFromEnv({ FACTORY_HOME: home }, '/home/someone')).toBe(home);
  });
});

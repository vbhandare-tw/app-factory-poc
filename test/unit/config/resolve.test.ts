/**
 * Project resolution (spec §6.1).
 *
 * Getting this wrong is the worst silent failure in the system: every later
 * command writes notes, cuts branches and spawns agents against whatever comes
 * back, and the wrong vault looks exactly like the right one until real work
 * lands in the wrong project.
 *
 * The filesystem arrives as an injected view, so all five branches — including
 * "cwd is inside a vault" and "registry default" — are reachable here without a
 * real home directory, a real cwd, or a single byte written to disk.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RegistryData } from '../../../src/config/registry.js';
import { EMPTY_REGISTRY } from '../../../src/config/registry.js';
import type { ResolveView } from '../../../src/config/resolve.js';
import { VaultResolutionError, resolveVault } from '../../../src/config/resolve.js';

const HOME = '/home/dev';
const ALPHA = `${HOME}/vaults/alpha`;
const BETA = `${HOME}/vaults/beta`;
const REPO = `${HOME}/code/product`;

interface FakeWorld {
  readonly cwd: string;
  /** Directories that hold a config.yml. Implicitly directories too. */
  readonly vaults?: readonly string[];
  /** Directories that exist but are not vaults. */
  readonly dirs?: readonly string[];
  readonly registry?: RegistryData;
}

function view(world: FakeWorld): ResolveView {
  const vaults = new Set((world.vaults ?? []).map((dir) => path.resolve(dir)));
  const dirs = new Set([...vaults, ...(world.dirs ?? []).map((dir) => path.resolve(dir))]);

  return {
    cwd: () => world.cwd,
    isDirectory: (dir) => dirs.has(path.resolve(dir)),
    isVaultRoot: (dir) => vaults.has(path.resolve(dir)),
    registry: world.registry ?? EMPTY_REGISTRY,
  };
}

function registry(
  projects: readonly { name: string; vault: string }[],
  defaultName: string | null = null,
): RegistryData {
  return {
    version: 1,
    default: defaultName,
    projects: projects.map((project) => ({
      name: project.name,
      vault: path.resolve(project.vault),
      repo: null,
      registered_at: null,
    })),
  };
}

function expectResolutionError(input: Parameters<typeof resolveVault>[0], world: FakeWorld) {
  try {
    resolveVault(input, view(world));
  } catch (error) {
    if (error instanceof VaultResolutionError) return error;
    throw error;
  }
  throw new Error('expected a VaultResolutionError, but resolution succeeded');
}

describe('1 — explicit --vault', () => {
  it('wins over everything else', () => {
    const result = resolveVault(
      { vaultFlag: ALPHA, projectName: 'beta' },
      view({
        cwd: BETA,
        vaults: [ALPHA, BETA],
        registry: registry([{ name: 'beta', vault: BETA }], 'beta'),
      }),
    );

    expect(result.vaultPath).toBe(ALPHA);
    expect(result.source).toBe('flag');
  });

  it('reports the registry name when the named vault happens to be registered', () => {
    const result = resolveVault(
      { vaultFlag: ALPHA },
      view({ cwd: '/elsewhere', vaults: [ALPHA], registry: registry([{ name: 'alpha', vault: ALPHA }]) }),
    );
    expect(result.projectName).toBe('alpha');
  });

  it('resolves a relative path against nothing but path.resolve — no cwd surprise', () => {
    const relative = path.relative(process.cwd(), ALPHA);
    const result = resolveVault(
      { vaultFlag: relative },
      view({ cwd: '/elsewhere', vaults: [ALPHA] }),
    );
    expect(result.vaultPath).toBe(ALPHA);
  });
});

describe('1 — --vault never falls through', () => {
  it('errors when the directory has no config.yml, rather than using the registry default', () => {
    // The dangerous branch. A typo'd --vault that quietly became "the registry
    // default" would redirect an entire session onto a real project, writing
    // real notes into someone else's work with no warning at all.
    const error = expectResolutionError(
      { vaultFlag: BETA },
      {
        cwd: '/elsewhere',
        vaults: [ALPHA],
        dirs: [BETA],
        registry: registry([{ name: 'alpha', vault: ALPHA }], 'alpha'),
      },
    );

    expect(error.code).toBe('flag_not_a_vault');
    expect(error.message).toContain(BETA);
    expect(error.message).not.toContain(ALPHA);
  });

  it('errors when the directory does not exist at all', () => {
    const error = expectResolutionError(
      { vaultFlag: '/no/such/place' },
      { cwd: ALPHA, vaults: [ALPHA], registry: registry([{ name: 'alpha', vault: ALPHA }], 'alpha') },
    );

    expect(error.code).toBe('flag_not_a_directory');
    expect(error.message).toContain('/no/such/place');
  });

  it('does not fall through to a vault it is standing inside', () => {
    const error = expectResolutionError(
      { vaultFlag: `${BETA}/typo` },
      { cwd: ALPHA, vaults: [ALPHA] },
    );
    expect(error.code).toBe('flag_not_a_directory');
  });
});

describe('2 — project name in the registry', () => {
  it('resolves to that project vault', () => {
    const result = resolveVault(
      { projectName: 'beta' },
      {
        ...view({
          cwd: '/elsewhere',
          vaults: [ALPHA, BETA],
          registry: registry(
            [
              { name: 'alpha', vault: ALPHA },
              { name: 'beta', vault: BETA },
            ],
            'alpha',
          ),
        }),
      },
    );

    expect(result.vaultPath).toBe(BETA);
    expect(result.source).toBe('project');
    expect(result.projectName).toBe('beta');
  });

  it('beats both the cwd vault and the registry default', () => {
    const result = resolveVault(
      { projectName: 'beta' },
      view({
        cwd: ALPHA,
        vaults: [ALPHA, BETA],
        registry: registry(
          [
            { name: 'alpha', vault: ALPHA },
            { name: 'beta', vault: BETA },
          ],
          'alpha',
        ),
      }),
    );
    expect(result.vaultPath).toBe(BETA);
  });

  it('errors when the name is unknown, and never falls through to the default', () => {
    const error = expectResolutionError(
      { projectName: 'gamma' },
      { cwd: ALPHA, vaults: [ALPHA], registry: registry([{ name: 'alpha', vault: ALPHA }], 'alpha') },
    );

    expect(error.code).toBe('project_unknown');
    expect(error.knownProjects).toEqual(['alpha']);
    expect(error.message).toContain('alpha');
  });

  it('errors when the registered vault is stale rather than skipping to the next rule', () => {
    const error = expectResolutionError(
      { projectName: 'beta' },
      {
        cwd: ALPHA,
        vaults: [ALPHA],
        registry: registry(
          [
            { name: 'alpha', vault: ALPHA },
            { name: 'beta', vault: BETA },
          ],
          'alpha',
        ),
      },
    );

    expect(error.code).toBe('project_vault_missing');
    expect(error.message).toContain(BETA);
  });
});

describe('3 — cwd auto-detection', () => {
  it('detects the vault the command was run from', () => {
    const result = resolveVault({}, view({ cwd: ALPHA, vaults: [ALPHA] }));
    expect(result).toEqual({ vaultPath: ALPHA, source: 'cwd', projectName: null });
  });

  it('detects a vault the cwd is nested inside', () => {
    const result = resolveVault(
      {},
      view({ cwd: `${ALPHA}/work/features/login`, vaults: [ALPHA] }),
    );
    expect(result.vaultPath).toBe(ALPHA);
    expect(result.source).toBe('cwd');
  });

  it('detects a `.factory-vault/` marker in the current directory', () => {
    const marker = path.join(REPO, '.factory-vault');
    const result = resolveVault({}, view({ cwd: REPO, vaults: [marker], dirs: [REPO] }));

    expect(result.vaultPath).toBe(marker);
    expect(result.source).toBe('cwd-marker');
  });

  it('detects a `.factory-vault/` marker in an ancestor directory', () => {
    const marker = path.join(REPO, '.factory-vault');
    const result = resolveVault(
      {},
      view({ cwd: `${REPO}/src/deep`, vaults: [marker], dirs: [REPO, `${REPO}/src`, `${REPO}/src/deep`] }),
    );
    expect(result.vaultPath).toBe(marker);
  });

  it('names the project when the detected vault is registered', () => {
    const result = resolveVault(
      {},
      view({ cwd: ALPHA, vaults: [ALPHA], registry: registry([{ name: 'alpha', vault: ALPHA }]) }),
    );
    expect(result.projectName).toBe('alpha');
  });

  it('a marker directory that is not itself a vault is ignored', () => {
    const marker = path.join(REPO, '.factory-vault');
    const result = resolveVault(
      {},
      view({
        cwd: REPO,
        vaults: [ALPHA],
        dirs: [REPO, marker],
        registry: registry([{ name: 'alpha', vault: ALPHA }], 'alpha'),
      }),
    );
    expect(result.source).toBe('registry-default');
  });
});

describe('4 — registry default', () => {
  it('is used when nothing else matches', () => {
    const result = resolveVault(
      {},
      view({
        cwd: '/elsewhere',
        vaults: [ALPHA, BETA],
        registry: registry(
          [
            { name: 'alpha', vault: ALPHA },
            { name: 'beta', vault: BETA },
          ],
          'beta',
        ),
      }),
    );

    expect(result.vaultPath).toBe(BETA);
    expect(result.source).toBe('registry-default');
    expect(result.projectName).toBe('beta');
  });

  it('errors when the default names a project that is not registered', () => {
    const error = expectResolutionError(
      {},
      { cwd: '/elsewhere', vaults: [ALPHA], registry: registry([{ name: 'alpha', vault: ALPHA }], 'ghost') },
    );
    expect(error.code).toBe('default_unknown');
    expect(error.message).toContain('ghost');
  });
});

describe('5 — nothing matches', () => {
  it('errors listing the registered project names', () => {
    const error = expectResolutionError(
      {},
      {
        cwd: '/elsewhere',
        vaults: [ALPHA, BETA],
        registry: registry([
          { name: 'alpha', vault: ALPHA },
          { name: 'beta', vault: BETA },
        ]),
      },
    );

    expect(error.code).toBe('no_vault');
    expect(error.knownProjects).toEqual(['alpha', 'beta']);
    expect(error.message).toContain('alpha, beta');
  });

  it('says so plainly when nothing is registered at all', () => {
    const error = expectResolutionError({}, { cwd: '/elsewhere' });
    expect(error.code).toBe('no_vault');
    expect(error.message).toContain('factory init');
  });
});

describe('precedence when several sources match at once', () => {
  /**
   * Every rule is satisfiable simultaneously: the flag points at ALPHA, the
   * project name resolves to BETA, the cwd is inside GAMMA, and the registry
   * default is DELTA. Peeling one source off at a time walks the order down.
   */
  const GAMMA = `${HOME}/vaults/gamma`;
  const DELTA = `${HOME}/vaults/delta`;

  const world: FakeWorld = {
    cwd: `${GAMMA}/work`,
    vaults: [ALPHA, BETA, GAMMA, DELTA],
    dirs: [`${GAMMA}/work`],
    registry: registry(
      [
        { name: 'alpha', vault: ALPHA },
        { name: 'beta', vault: BETA },
        { name: 'gamma', vault: GAMMA },
        { name: 'delta', vault: DELTA },
      ],
      'delta',
    ),
  };

  it('flag beats project name, cwd and default', () => {
    const result = resolveVault({ vaultFlag: ALPHA, projectName: 'beta' }, view(world));
    expect([result.vaultPath, result.source]).toEqual([ALPHA, 'flag']);
  });

  it('project name beats cwd and default', () => {
    const result = resolveVault({ projectName: 'beta' }, view(world));
    expect([result.vaultPath, result.source]).toEqual([BETA, 'project']);
  });

  it('cwd beats the default', () => {
    const result = resolveVault({}, view(world));
    expect([result.vaultPath, result.source]).toEqual([GAMMA, 'cwd']);
  });

  it('the default is reached only when nothing above it matches', () => {
    const result = resolveVault({}, view({ ...world, cwd: '/elsewhere' }));
    expect([result.vaultPath, result.source]).toEqual([DELTA, 'registry-default']);
  });

  it('the vault the cwd sits in beats a marker in the same directory', () => {
    const marker = path.join(GAMMA, '.factory-vault');
    const result = resolveVault({}, view({ cwd: GAMMA, vaults: [GAMMA, marker] }));
    expect([result.vaultPath, result.source]).toEqual([GAMMA, 'cwd']);
  });

  it('the nearest ancestor vault wins over a further one', () => {
    const nested = `${ALPHA}/nested`;
    const result = resolveVault({}, view({ cwd: nested, vaults: [ALPHA, nested] }));
    expect(result.vaultPath).toBe(nested);
  });
});

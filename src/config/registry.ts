/**
 * The project registry — `~/.app-factory/projects.yml` (spec §11).
 *
 * **The factory home is an injected parameter, never read from `os.homedir()`
 * inside a method.** That is deliberate and it is the single most important
 * decision in this file.
 *
 * `registerProject` writes to disk. If the location of that write were computed
 * deep inside the class, every test that exercised registration would write to
 * the operator's real home — and it would *pass*. It would pass on the machine
 * that wrote it, pass twice in a row, and keep passing right up until it
 * clobbered a real registry or a colleague's clean checkout behaved differently
 * from everyone else's. There is no assertion that catches that class of bug
 * after the fact; the only defence is to make the dangerous path impossible to
 * reach by accident, which is what taking `home` as a constructor argument does.
 *
 * `ProjectRegistry.fromEnv` is the one place that consults the real home, and
 * `FACTORY_HOME` overrides it — so tests point at a disposable directory and
 * never inherit the default at all.
 *
 * **Why `.app-factory` and not `.factory`.** The spec originally said
 * `~/.factory/`. That name is already taken: Factory.ai's CLI installs there
 * and keeps `auth.json`, `settings.json`, `sessions/` and `mcp.json` in it.
 * Sharing a directory another tool owns — and may clean or rewrite — is an
 * operational hazard for no benefit. Spec §11 and §11.1 now say
 * `~/.app-factory/` too; `FACTORY_HOME` overrides it either way.
 */
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { atomicWrite } from '../vault/atomic.js';

/**
 * The directory name inside the operator's home.
 *
 * Deliberately not `.factory` — see the header note. Changing this back would
 * put the registry inside another installed tool's config directory.
 */
export const FACTORY_HOME_DIRNAME = '.app-factory';

/** The registry file name inside the factory home. */
export const REGISTRY_FILENAME = 'projects.yml';

/** Environment variable that relocates the whole factory home. */
export const FACTORY_HOME_ENV = 'FACTORY_HOME';

export const REGISTRY_VERSION = 1;

export interface ProjectEntry {
  readonly name: string;
  /** Absolute path to the vault. */
  readonly vault: string;
  /** Absolute path to the bound target repo, recorded for `factory projects`. */
  readonly repo: string | null;
  readonly registered_at: string | null;
}

export interface RegistryData {
  readonly version: number;
  /** Name of the project used when nothing else resolves (spec §6.1 step 4). */
  readonly default: string | null;
  readonly projects: readonly ProjectEntry[];
}

export const EMPTY_REGISTRY: RegistryData = { version: REGISTRY_VERSION, default: null, projects: [] };

export class RegistryError extends Error {
  readonly file: string;

  constructor(file: string, detail: string, options?: { cause?: unknown }) {
    super(`${file}: ${detail}`, options);
    this.name = 'RegistryError';
    this.file = file;
  }
}

/** Where the factory home lives for a given environment. Pure. */
export function factoryHomeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const override = env[FACTORY_HOME_ENV];
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  return path.join(homedir, FACTORY_HOME_DIRNAME);
}

export class ProjectRegistry {
  /** Absolute path to the factory home directory. */
  readonly home: string;

  /** Absolute path to `projects.yml` inside it. */
  readonly file: string;

  constructor(home: string) {
    this.home = path.resolve(home);
    this.file = path.join(this.home, REGISTRY_FILENAME);
  }

  /**
   * The only constructor that looks at the real home directory, and it is the
   * CLI layer's job to call it. `FACTORY_HOME` wins when set.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): ProjectRegistry {
    return new ProjectRegistry(factoryHomeFromEnv(env, homedir));
  }

  /** An absent registry is an empty registry, not an error — a first run is normal. */
  async read(): Promise<RegistryData> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ENOENT') return EMPTY_REGISTRY;
      throw error;
    }
    return this.decode(text);
  }

  async listProjects(): Promise<readonly ProjectEntry[]> {
    return (await this.read()).projects;
  }

  /** The registry `default` entry, or `undefined` when there is not one. */
  async defaultProject(): Promise<ProjectEntry | undefined> {
    const data = await this.read();
    if (data.default === null) return undefined;
    return data.projects.find((project) => project.name === data.default);
  }

  async findProject(name: string): Promise<ProjectEntry | undefined> {
    return (await this.read()).projects.find((project) => project.name === name);
  }

  /**
   * Add or replace a project.
   *
   * The first project registered becomes the default, because a registry with
   * exactly one project and no default would make `factory status` fail from an
   * unrelated directory for no reason a human would guess.
   */
  async registerProject(entry: {
    name: string;
    vault: string;
    repo?: string | null;
    registeredAt?: string | null;
    makeDefault?: boolean;
  }): Promise<RegistryData> {
    const name = entry.name.trim();
    if (name === '') throw new RegistryError(this.file, 'a project name must not be empty');

    const current = await this.read();
    const record: ProjectEntry = {
      name,
      vault: path.resolve(entry.vault),
      repo: entry.repo === undefined || entry.repo === null ? null : path.resolve(entry.repo),
      registered_at: entry.registeredAt ?? null,
    };

    const projects = [...current.projects.filter((project) => project.name !== name), record].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    const makeDefault = entry.makeDefault ?? current.default === null;
    const next: RegistryData = {
      version: REGISTRY_VERSION,
      default: makeDefault ? name : current.default,
      projects,
    };

    await this.write(next);
    return next;
  }

  async write(data: RegistryData): Promise<void> {
    await mkdir(this.home, { recursive: true });
    await atomicWrite(this.file, encode(data));
  }

  private decode(text: string): RegistryData {
    let raw: unknown;
    try {
      raw = parseYaml(text, { schema: 'core' });
    } catch (error) {
      throw new RegistryError(this.file, `not valid YAML — ${messageOf(error)}`, { cause: error });
    }

    if (raw === null || raw === undefined) return EMPTY_REGISTRY;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RegistryError(this.file, 'the top level must be a YAML mapping');
    }

    const record = raw as Record<string, unknown>;
    const projectsRaw = record['projects'];
    const projects: ProjectEntry[] = [];

    if (projectsRaw !== undefined && projectsRaw !== null) {
      if (typeof projectsRaw !== 'object' || Array.isArray(projectsRaw)) {
        throw new RegistryError(this.file, '`projects` must be a mapping of name to project');
      }
      for (const [name, value] of Object.entries(projectsRaw as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new RegistryError(this.file, `project ${JSON.stringify(name)} must be a mapping`);
        }
        const fields = value as Record<string, unknown>;
        const vault = fields['vault'];
        if (typeof vault !== 'string' || vault.trim() === '') {
          throw new RegistryError(
            this.file,
            `project ${JSON.stringify(name)} has no \`vault\` path`,
          );
        }
        projects.push({
          name,
          vault: path.resolve(vault),
          repo: typeof fields['repo'] === 'string' ? path.resolve(fields['repo']) : null,
          registered_at:
            typeof fields['registered_at'] === 'string' ? fields['registered_at'] : null,
        });
      }
    }

    const defaultName = record['default'];
    return {
      version: typeof record['version'] === 'number' ? record['version'] : REGISTRY_VERSION,
      default: typeof defaultName === 'string' && defaultName !== '' ? defaultName : null,
      projects: projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }
}

function encode(data: RegistryData): string {
  const projects: Record<string, Record<string, string>> = {};
  for (const project of data.projects) {
    const fields: Record<string, string> = { vault: project.vault };
    if (project.repo !== null) fields['repo'] = project.repo;
    if (project.registered_at !== null) fields['registered_at'] = project.registered_at;
    projects[project.name] = fields;
  }

  return stringifyYaml(
    { version: data.version, default: data.default, projects },
    { schema: 'core', defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

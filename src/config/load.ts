/**
 * Reading and validating `<vault>/config.yml`.
 *
 * The contract that matters here is the error, not the happy path: a config
 * with four mistakes must produce one message naming all four. Validating
 * field-by-field and throwing on the first bad key turns fixing a hand-edited
 * config into a fix-run-fix-run loop, and the operator only ever sees one
 * problem at a time even though the tool already knows about the rest.
 */
import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { VaultPaths } from '../vault/paths.js';
import { ConfigSchema } from './schema.js';
import type { FactoryConfig } from './schema.js';

/** One thing wrong with the config, addressed by the key a human would edit. */
export interface ConfigIssue {
  /** Dotted key path, e.g. `gates.lint`. Empty string for a whole-file problem. */
  readonly key: string;
  readonly message: string;
}

/** Every problem with a config file, never just the first. */
export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: readonly ConfigIssue[], options?: { cause?: unknown }) {
    const listed = issues.map((issue) => `  - ${issue.key === '' ? '(file)' : issue.key}: ${issue.message}`);
    super(
      `${source} is not a valid factory config (${issues.length} ${
        issues.length === 1 ? 'problem' : 'problems'
      }):\n${listed.join('\n')}`,
      options,
    );
    this.name = 'ConfigError';
    this.source = source;
    this.issues = issues;
  }

  /** The keys this error names, in report order. Convenience for tests and the CLI. */
  keys(): string[] {
    return this.issues.map((issue) => issue.key);
  }
}

/**
 * Validate an already-parsed config object.
 *
 * Split out from `parseConfig` so a caller that already has the data — `factory
 * init` re-validating what it just wrote — does not round-trip through YAML.
 */
export function validateConfig(data: unknown, source = '<config>'): FactoryConfig {
  const result = ConfigSchema.safeParse(data);
  if (result.success) return result.data;
  throw new ConfigError(source, toIssues(result.error), { cause: result.error });
}

/** Parse and validate config YAML text. */
export function parseConfig(text: string, source = '<config>'): FactoryConfig {
  let data: unknown;
  try {
    data = parseYaml(text, { schema: 'core' });
  } catch (error) {
    throw new ConfigError(
      source,
      [{ key: '', message: `not valid YAML — ${messageOf(error)}` }],
      { cause: error },
    );
  }

  if (data === null || data === undefined) {
    throw new ConfigError(source, [
      { key: '', message: 'the file is empty — it must be a YAML mapping with at least `target_repo`' },
    ]);
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(source, [
      { key: '', message: 'the top level must be a YAML mapping of key to value' },
    ]);
  }

  return validateConfig(data, source);
}

/**
 * Read and validate `<vaultPath>/config.yml`.
 *
 * A missing file is a `ConfigError` like any other, not an `ENOENT` leaking out
 * of `fs`: "no such file or directory" without the word config is a confusing
 * thing to show someone who mistyped `--vault`.
 */
export async function loadConfig(vaultPath: string): Promise<FactoryConfig> {
  const file = new VaultPaths(vaultPath).configFile();

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      throw new ConfigError(
        file,
        [{ key: '', message: 'no config.yml here — this directory is not a factory vault' }],
        { cause: error },
      );
    }
    throw error;
  }

  return parseConfig(text, file);
}

/**
 * Flatten zod issues into one issue per offending key.
 *
 * `unrecognized_keys` arrives as a single issue carrying a list, so it is
 * expanded: the whole point of rejecting unknown keys is telling the operator
 * which key, and three typos should read as three lines.
 */
function toIssues(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const issue of error.issues) {
    const prefix = issue.path.map((part) => String(part)).join('.');

    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const full = prefix === '' ? key : `${prefix}.${key}`;
        issues.push({
          key: full,
          message: `unknown key ${JSON.stringify(full)} — remove it or check the spelling`,
        });
      }
      continue;
    }

    issues.push({ key: prefix, message: issue.message });
  }

  return issues;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

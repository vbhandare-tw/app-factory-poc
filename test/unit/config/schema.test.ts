/**
 * The config schema (spec §11).
 *
 * The behaviour worth protecting here is not "valid config parses" — it is what
 * happens to an *invalid* one. A permissive schema silently ignores a typo'd
 * key, so the operator believes a setting took effect that never did; a schema
 * that aborts on the first problem turns a four-mistake config into four runs.
 * Both failures are quiet, so both get a test.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig, validateConfig } from '../../../src/config/load.js';
import { MAX_PARALLEL_DEVS_MESSAGE, SUPPORTED_VAULT_VERSION } from '../../../src/config/schema.js';

/** The one key with no default. */
const MINIMAL = { target_repo: '/repo' };

function expectConfigError(input: unknown): ConfigError {
  try {
    validateConfig(input, 'config.yml');
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError, but the config validated');
}

describe('defaults', () => {
  it('applies every default when only target_repo is given', () => {
    const config = validateConfig(MINIMAL);

    expect(config).toEqual({
      target_repo: '/repo',
      vault_version: SUPPORTED_VAULT_VERSION,
      base_branch: 'main',
      runner: 'claude-code',
      models: {
        default: 'sonnet',
        pm: 'sonnet',
        tl_plan: 'sonnet',
        dl: 'sonnet',
        developer: 'sonnet',
        code_reviewer: 'sonnet',
        qa: 'sonnet',
      },
      poll_interval: 15,
      max_parallel_devs: 1,
      max_parallel_other: 1,
      agent_timeout: 1800,
      lock_ttl: 5400,
      max_attempts: 3,
      context_warn_chars: 200_000,
      gate_output_chars: 20_000,
      // Added in Phase 7b. This assertion is a whole-object equality, so a new
      // config key has to be listed here or the test is simply wrong about what
      // the defaults are — which is exactly what it exists to catch. Nothing
      // here was loosened: the new key is now pinned to its default like every
      // other one.
      payload_warn_chars: 13_000,
      run_budget: null,
      max_budget_usd_per_run: 5,
      sandbox_extra_read: [],
      sandbox_extra_write: [],
      setup_command: 'npm ci',
      setup_timeout: 300,
      human_checkpoints: {
        after_pm_refinement: true,
        after_ticket_breakdown: true,
        final_acceptance: true,
      },
      gates: { tests: 'npm test', lint: 'npm run lint', build: 'npm run build' },
    });
  });

  it('defaults the sandbox escape hatches to empty, not to the stale spec example', () => {
    // Spec §11's example YAML seeds these with ~/.npm and ~/.npmrc. Plan
    // resolution A2 probed it: npm runs clean under denyRead: ["~/"] with
    // nothing added. Shipping the example would punch two permanent holes in
    // every agent's read fence for a problem that does not exist.
    const config = validateConfig(MINIMAL);
    expect(config.sandbox_extra_read).toEqual([]);
    expect(config.sandbox_extra_write).toEqual([]);
  });

  it('carries setup_command and setup_timeout, which resolution A3 added', () => {
    const config = validateConfig(MINIMAL);
    expect(config.setup_command).toBe('npm ci');
    expect(config.setup_timeout).toBe(300);
  });

  it('fills in the missing halves of a partly-specified nested block', () => {
    const config = validateConfig({ ...MINIMAL, gates: { tests: 'make check' } });
    expect(config.gates).toEqual({
      tests: 'make check',
      lint: 'npm run lint',
      build: 'npm run build',
    });
  });

  it('lets one role override the model while the rest fall back', () => {
    const config = validateConfig({ ...MINIMAL, models: { tl_plan: 'opus' } });
    expect(config.models.tl_plan).toBe('opus');
    expect(config.models.developer).toBe('sonnet');
    expect(config.models.default).toBe('sonnet');
  });

  it('rejects a config with no target_repo at all', () => {
    expect(expectConfigError({}).keys()).toContain('target_repo');
  });
});

describe('unknown keys', () => {
  it('rejects an unknown top-level key and names it', () => {
    const error = expectConfigError({ ...MINIMAL, max_paralell_devs: 4 });

    expect(error.keys()).toEqual(['max_paralell_devs']);
    expect(error.message).toContain('max_paralell_devs');
  });

  it('names an unknown key inside a nested block by its full path', () => {
    const error = expectConfigError({ ...MINIMAL, gates: { tests: 'npm test', typecheck: 'tsc' } });

    expect(error.keys()).toEqual(['gates.typecheck']);
    expect(error.message).toContain('gates.typecheck');
  });

  it('names an unknown role in the models block', () => {
    const error = expectConfigError({ ...MINIMAL, models: { tl_merge: 'sonnet' } });
    expect(error.keys()).toEqual(['models.tl_merge']);
  });

  it('lists three typos as three separate named keys, not one lumped issue', () => {
    const error = expectConfigError({
      ...MINIMAL,
      poll_intervall: 15,
      max_atempts: 3,
      base_brnach: 'main',
    });

    expect(error.keys().sort()).toEqual(['base_brnach', 'max_atempts', 'poll_intervall']);
  });
});

describe('max_parallel_devs is pinned to 1', () => {
  it('rejects 3 and explains that parallelism is M4', () => {
    const error = expectConfigError({ ...MINIMAL, max_parallel_devs: 3 });

    expect(error.keys()).toContain('max_parallel_devs');
    expect(error.message).toContain(MAX_PARALLEL_DEVS_MESSAGE);
    expect(error.message).toContain('M4');
  });

  it('accepts 1', () => {
    expect(validateConfig({ ...MINIMAL, max_parallel_devs: 1 }).max_parallel_devs).toBe(1);
  });

  it('rejects 0 as well — a pin, not a lower bound', () => {
    expect(expectConfigError({ ...MINIMAL, max_parallel_devs: 0 }).keys()).toContain(
      'max_parallel_devs',
    );
  });
});

describe('malformed gates block', () => {
  it('reports which gate is wrong, not just that gates is wrong', () => {
    const error = expectConfigError({
      ...MINIMAL,
      gates: { tests: 'npm test', lint: 42, build: 'npm run build' },
    });

    expect(error.keys()).toEqual(['gates.lint']);
    expect(error.message).toContain('gates.lint');
    expect(error.message).not.toContain('gates.tests');
  });

  it('reports an empty gate command against that gate', () => {
    expect(expectConfigError({ ...MINIMAL, gates: { build: '' } }).keys()).toEqual(['gates.build']);
  });
});

describe('multiple errors are reported together', () => {
  it('reports a bad number, a bad nested value, and an unknown key in one result', () => {
    const error = expectConfigError({
      ...MINIMAL,
      max_parallel_devs: 4,
      gates: { lint: 7 },
      wibble: true,
    });

    expect(error.keys().sort()).toEqual(['gates.lint', 'max_parallel_devs', 'wibble']);
    expect(error.issues).toHaveLength(3);
    expect(error.message).toContain('3 problems');
  });

  it('a whole-object refinement would hide behind other errors — the field-level one does not', () => {
    // If `max_parallel_devs` were checked by an object-level `.refine()`, this
    // config would report only the unknown key: object refinements run after
    // every field parses, so the pin would be invisible until the typo was
    // fixed. Field-level refinement is what keeps both visible at once.
    const error = expectConfigError({ ...MINIMAL, max_parallel_devs: 9, nonsense: 1 });
    expect(error.keys().sort()).toEqual(['max_parallel_devs', 'nonsense']);
  });
});

describe('parseConfig — YAML level failures', () => {
  it('reports unparseable YAML as a config problem naming the file', () => {
    let caught: unknown;
    try {
      parseConfig('target_repo: "unclosed\n  - [\n', 'my-vault/config.yml');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('my-vault/config.yml');
  });

  it('reports an empty file rather than pretending it validated', () => {
    expect(() => parseConfig('', 'config.yml')).toThrow(ConfigError);
  });

  it('reports a top-level list rather than a mapping', () => {
    expect(() => parseConfig('- one\n- two\n', 'config.yml')).toThrow(/mapping/);
  });

  it('parses the real thing', () => {
    const config = parseConfig(
      ['target_repo: "/tmp/repo"', 'base_branch: "trunk"', 'poll_interval: 30'].join('\n'),
      'config.yml',
    );
    expect(config.base_branch).toBe('trunk');
    expect(config.poll_interval).toBe(30);
  });
});

describe('runner', () => {
  it('accepts demo, the scripted runner behind `factory demo` (dashboard plan Phase 6), alongside the other two', () => {
    expect(validateConfig({ ...MINIMAL, runner: 'demo' }).runner).toBe('demo');
    expect(validateConfig({ ...MINIMAL, runner: 'mock' }).runner).toBe('mock');
    expect(validateConfig({ ...MINIMAL, runner: 'claude-code' }).runner).toBe('claude-code');
  });

  it('still rejects an unknown runner, naming the key', () => {
    const error = expectConfigError({ ...MINIMAL, runner: 'fake' });

    expect(error.keys()).toEqual(['runner']);
    expect(error.message).toContain('runner');
  });
});

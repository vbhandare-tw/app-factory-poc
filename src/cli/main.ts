#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';

import { ConfigError } from '../config/load.js';
import { VaultResolutionError } from '../config/resolve.js';
import type { CliDeps } from './deps.js';
import { CliError, processDeps } from './deps.js';
import { runInit } from './init.js';
import { runProjects } from './projects.js';
import { runStatus } from './status.js';

interface PackageManifest {
  name: string;
  version: string;
  description?: string;
}

/**
 * Read the shipped version from package.json rather than duplicating it in a
 * constant. The relative path resolves identically from `src/cli/` (typecheck,
 * vitest) and from `dist/cli/` (built output), so there is nothing to keep in
 * sync.
 */
export function readManifest(): PackageManifest {
  const require = createRequire(import.meta.url);
  return require('../../package.json') as PackageManifest;
}

/**
 * Build the command tree.
 *
 * `deps` is **required and comes first** so an integration test can drive real
 * commands in-process against a scratch cwd and a scratch factory home. Without
 * that seam every `init`/`status` test would register projects in the
 * operator's real `~/.app-factory/projects.yml` — and pass while doing it.
 *
 * It has no default on purpose. A default of `processDeps()` would read the
 * real home, so a future test that simply forgot the argument would silently
 * get the operator's registry and still go green. Making the parameter
 * mandatory turns that mistake into a compile error. `main` below is the only
 * caller that supplies the real thing.
 */
export function buildProgram(
  deps: CliDeps,
  manifest: PackageManifest = readManifest(),
): Command {
  const program = new Command();

  program
    .name('factory')
    .description(manifest.description ?? 'App Factory orchestrator')
    .version(manifest.version, '-V, --version', 'print the factory version')
    .helpOption('-h, --help', 'show help')
    .exitOverride();

  program
    .command('init')
    .description('create a vault, bind it to a target repo, and register it')
    .requiredOption('--vault <path>', 'where to create the vault')
    .requiredOption('--repo <path>', 'the git repository the factory will build in')
    .option('--name <name>', 'registry name (defaults to the vault directory name)')
    .action(async (options: { vault: string; repo: string; name?: string }) => {
      await runInit({ vault: options.vault, repo: options.repo, name: options.name }, deps);
    });

  program
    .command('projects')
    .description('list registered projects')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      await runProjects({ json: options.json }, deps);
    });

  program
    .command('status')
    .description('features by stage, ticket counts, and the needs-human queue')
    .argument('[project]', 'registered project name')
    .option('--vault <path>', 'operate on this vault explicitly')
    .option('--json', 'emit machine-readable JSON')
    .action(async (project: string | undefined, options: { vault?: string; json?: boolean }) => {
      await runStatus({ project, vault: options.vault, json: options.json }, deps);
    });

  // Phase 7a adds start/stop/feature add/approve/reject/kill.

  return program;
}

/**
 * The binary's entry point, and the only thing that reaches the real home.
 *
 * `deps` is a parameter — with the real process as its default — purely so the
 * error-to-exit-code mapping below can be tested. Without it that mapping could
 * only ever be checked by hand, and "the CLI exits 1 on a bad repo" is exactly
 * the sort of claim that quietly stops being true.
 */
export async function main(
  argv: readonly string[] = process.argv,
  deps: CliDeps = processDeps(),
): Promise<void> {
  try {
    await buildProgram(deps, readManifest()).parseAsync([...argv]);
  } catch (error) {
    if (isCommanderExit(error)) {
      process.exitCode = error.exitCode;
      return;
    }
    // These three carry messages written for a human to read and act on.
    // Printing a stack trace for "that directory is not a git repository" or
    // "no registered project named foo" helps nobody, and it buries the one
    // line that says what to do. Anything else is a bug in the factory and
    // still gets its stack, because that is who *that* message is for.
    if (isOperatorError(error)) {
      deps.err(error.message);
      process.exitCode = error instanceof CliError ? error.exitCode : 1;
      return;
    }
    throw error;
  }
}

/**
 * Errors whose message is the whole point — a mistake in what the operator
 * typed or in the state on disk, not a defect in this code.
 */
function isOperatorError(error: unknown): error is Error {
  return (
    error instanceof CliError ||
    error instanceof VaultResolutionError ||
    error instanceof ConfigError
  );
}

function isCommanderExit(error: unknown): error is { exitCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('commander.') &&
    typeof (error as { exitCode?: unknown }).exitCode === 'number'
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  await main();
}

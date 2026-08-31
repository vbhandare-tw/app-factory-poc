#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';

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

export function buildProgram(manifest: PackageManifest = readManifest()): Command {
  const program = new Command();

  program
    .name('factory')
    .description(manifest.description ?? 'App Factory orchestrator')
    .version(manifest.version, '-V, --version', 'print the factory version')
    .helpOption('-h, --help', 'show help');

  // Subcommands land in Phase 4 (init/projects/status) and Phase 7a
  // (start/stop/feature add/approve/reject/kill). Nothing is registered yet.

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync([...argv]);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  await main();
}

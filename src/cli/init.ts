/**
 * `factory init --vault <p> --repo <p> [--name <n>]` (spec §6).
 *
 * Creates a vault from `vault-template/`, binds it to a target repo, and
 * registers it so later commands can find it from anywhere.
 *
 * The ordering below is the interesting part. The repo's `refs/factory/owner`
 * marker is checked **before** anything is written, so a second `init` against
 * a repo that another vault already drives is refused with nothing left behind.
 * Two vaults sharing a repo would cut branches over each other and merge into
 * each other's work; it is much easier to refuse the second init than to detect
 * that afterwards.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { VaultPaths } from '../vault/paths.js';
import { loadConfig } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import {
  canonicalPath,
  currentBranch,
  isGitRepo,
  readOwnerRef,
  writeOwnerRef,
} from '../config/validate.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';

/**
 * The skeleton copied into a new vault. `../..` from this module resolves to the
 * project root identically under `src/cli/` (typecheck, vitest) and `dist/cli/`
 * (built output), so there is nothing to keep in sync.
 */
export const VAULT_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'vault-template',
);

export interface InitOptions {
  readonly vault: string;
  readonly repo: string;
  readonly name?: string | undefined;
}

export interface InitResult {
  readonly vaultPath: string;
  readonly repoPath: string;
  readonly projectName: string;
  readonly baseBranch: string;
  readonly config: FactoryConfig;
}

export async function runInit(options: InitOptions, deps: CliDeps): Promise<InitResult> {
  const vaultPath = path.resolve(deps.cwd, options.vault);
  const repoPath = path.resolve(deps.cwd, options.repo);

  // --- the repo must be usable before anything is written --------------------
  if (!isDirectory(repoPath)) {
    throw new CliError(`--repo ${repoPath} is not a directory`);
  }
  if (!isGitRepo(repoPath)) {
    throw new CliError(
      `--repo ${repoPath} is not a git repository. The factory works by cutting branches and worktrees, so run \`git init\` there first.`,
    );
  }

  const owner = readOwnerRef(repoPath);
  // Both sides canonicalised, for the same reason `validateStartup` does it: a
  // symlinked spelling of this vault must not read as a foreign owner and send
  // the operator off to delete a ref that is their own.
  if (owner !== null && canonicalPath(owner) !== canonicalPath(vaultPath)) {
    throw new CliError(
      `${repoPath} is already owned by the vault at ${owner}. One repo is driven by exactly one vault: two would cut branches and merge over each other. Delete refs/factory/owner in that repo if the other vault is gone.`,
    );
  }

  // --- refuse to overwrite an existing vault ---------------------------------
  const paths = new VaultPaths(vaultPath);
  if (existsSync(paths.configFile())) {
    throw new CliError(
      `${vaultPath} already contains a config.yml, so it is already a vault. Refusing to overwrite it.`,
    );
  }

  // --- create the vault -------------------------------------------------------
  const baseBranch = currentBranch(repoPath) ?? 'main';
  await mkdir(vaultPath, { recursive: true });
  await cp(VAULT_TEMPLATE_DIR, vaultPath, { recursive: true });
  await writeFile(paths.configFile(), await bindConfig(repoPath, baseBranch), 'utf8');

  // Prove what was written actually parses, rather than trusting the template.
  const config = await loadConfig(vaultPath);

  // --- bind and register ------------------------------------------------------
  writeOwnerRef(repoPath, vaultPath);

  const projectName = (options.name ?? path.basename(vaultPath)).trim();
  await deps.registry.registerProject({
    name: projectName,
    vault: vaultPath,
    repo: repoPath,
    registeredAt: deps.now(),
  });

  deps.out(`Created vault ${vaultPath}`);
  deps.out(`  target repo:  ${repoPath}`);
  deps.out(`  base branch:  ${baseBranch}`);
  deps.out(`  registered as: ${projectName} (${deps.registry.file})`);

  return { vaultPath, repoPath, projectName, baseBranch, config };
}

/**
 * The template `config.yml` with `target_repo` and `base_branch` filled in.
 *
 * Edited through yaml's document API rather than re-emitted from a parsed
 * object: the template's comments explain every knob, and re-serialising a plain
 * object would throw all of them away on the very first write.
 */
async function bindConfig(repoPath: string, baseBranch: string): Promise<string> {
  const template = await readFile(path.join(VAULT_TEMPLATE_DIR, 'config.yml'), 'utf8');
  const doc = parseDocument(template);
  doc.set('target_repo', repoPath);
  doc.set('base_branch', baseBranch);
  return doc.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

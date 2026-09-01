/**
 * The four lines every vault-scoped command repeats: resolve the vault, load
 * and validate its config, and build the `Storage` seam over it.
 *
 * Extracted because `approve`, `reject` and `kill` are otherwise identical
 * apart from the one call they make, and three copies of a resolution order
 * with five branches (spec §6.1) is three chances to get it subtly different.
 */
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import type { FactoryConfig } from '../config/schema.js';
import type { ActionContext } from '../orchestrator/actions.js';
import { VaultPaths } from '../vault/paths.js';
import { MarkdownStorage } from '../vault/storage.js';
import type { CliDeps } from './deps.js';

export interface VaultScope {
  readonly vaultPath: string;
  readonly config: FactoryConfig;
  readonly paths: VaultPaths;
  readonly storage: MarkdownStorage;
  /** Ready to hand to `approve` / `reject` in `src/orchestrator/actions.ts`. */
  readonly actionContext: ActionContext;
}

export async function openVault(
  options: { readonly project?: string | undefined; readonly vault?: string | undefined },
  deps: CliDeps,
): Promise<VaultScope> {
  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );

  const config = await loadConfig(resolution.vaultPath);
  const paths = new VaultPaths(resolution.vaultPath);
  const storage = new MarkdownStorage(paths);

  return {
    vaultPath: resolution.vaultPath,
    config,
    paths,
    storage,
    actionContext: { paths, storage, config, now: deps.now },
  };
}

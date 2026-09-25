/**
 * `factory demo [--port <n>] [--no-open] [--fresh]` (tech spec §7): the demo feature on a throwaway
 * copy of the toy app, in the dashboard, at no cost. It lives in `<factory home>/demo/` and is never
 * registered in `projects.yml` (plan A5).
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { loadConfig } from '../config/load.js';
import { readLockView } from '../dashboard/handlers/read.js';
import { toyAppRoot } from '../dashboard/paths.js';
import { describeExec, execCapture } from '../git/exec.js';
import { GIT_TIMEOUT_MS, ORCHESTRATOR_IDENTITY, ShellGit } from '../git/git.js';
import { UnsafeWorktreePathError, assertNotUnderTempRoot } from '../git/paths.js';
import { DEMO_PROJECT_MD, DEMO_REQUIREMENT, DEMO_SLUG } from '../runner/demoScript.js';
import { VaultPaths } from '../vault/paths.js';
import { MarkdownStorage } from '../vault/storage.js';
import { runDashboard } from './dashboard.js';
import type { DashboardSeams, RunningDashboard } from './dashboard.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';
import { addFeature } from './featureAdd.js';
import { runInit } from './init.js';

export interface DemoOptions {
  readonly port?: number | undefined;
  /** `--no-open` sets it false. */
  readonly open?: boolean | undefined;
  /** Delete the demo and build it again. */
  readonly fresh?: boolean | undefined;
}

export interface DemoLayout {
  readonly root: string;
  readonly repo: string;
  readonly vault: string;
}

export function demoLayout(factoryHome: string): DemoLayout {
  const root = path.join(factoryHome, 'demo');
  return { root, repo: path.join(root, 'repo'), vault: path.join(root, 'vault') };
}

export async function runDemo(
  options: DemoOptions,
  deps: CliDeps,
  seams: DashboardSeams = {},
): Promise<RunningDashboard> {
  const layout = demoLayout(deps.registry.home);
  refuseTempLocation(layout.root);

  const hasVault = existsSync(new VaultPaths(layout.vault).configFile());
  const hasRepo = existsSync(path.join(layout.repo, '.git'));
  const built = hasVault && hasRepo;
  if ((hasVault || hasRepo) && !built && options.fresh !== true) {
    throw new CliError(`the demo in ${layout.root} is incomplete (missing its ${hasVault ? 'repo' : 'vault'}). Pass --fresh to rebuild it.`);
  }
  if (built && options.fresh !== true) {
    deps.out(`Resuming the demo in ${layout.root}. Pass --fresh to start it over.`);
  } else {
    await refuseWhileRunning(layout, seams);
    await createDemo(layout, deps);
  }

  return await runDashboard(
    { vault: layout.vault, port: options.port, open: options.open, start: true },
    deps,
    seams,
  );
}

async function createDemo(layout: DemoLayout, deps: CliDeps): Promise<void> {
  deps.out(`Creating the demo in ${layout.root}: a copy of the toy app, and a vault whose agents are scripted.`);
  await rm(layout.root, { recursive: true, force: true });
  await mkdir(layout.repo, { recursive: true });
  await cp(toyAppRoot(), layout.repo, {
    recursive: true,
    filter: (source) => !['node_modules', 'dist'].includes(path.basename(source)),
  });
  await writeFile(path.join(layout.repo, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
  await commitToyApp(layout.repo);

  await runInit({ vault: layout.vault, repo: layout.repo, name: 'demo', register: false }, deps);
  await useDemoRunner(layout.vault);
  const paths = new VaultPaths(layout.vault);
  await writeFile(paths.projectFile(), DEMO_PROJECT_MD, 'utf8');
  const added = await addFeature(
    { paths, storage: new MarkdownStorage(paths), now: deps.now },
    { slug: DEMO_SLUG, priority: 'medium', requirement: DEMO_REQUIREMENT },
  );
  deps.out(`Added ${added.id} (${added.title}). It stops three times for your approval.`);
}

async function commitToyApp(repo: string): Promise<void> {
  const init = await execCapture('git', ['init', '--quiet', '-b', 'main'], { cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
  if (init.status !== 0) throw new CliError(`could not create the demo repository: ${describeExec(init)}`);
  const git = new ShellGit({ repoRoot: repo });
  await git.add(repo, ['.']);
  await git.commit(repo, 'chore: the toy app, before the demo feature', ORCHESTRATOR_IDENTITY);
}

/** `runner: "demo"`, set through the YAML document so the template's comments survive. */
async function useDemoRunner(vaultPath: string): Promise<void> {
  const file = new VaultPaths(vaultPath).configFile();
  const doc = parseDocument(await readFile(file, 'utf8'));
  doc.set('runner', 'demo');
  const text = doc.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  await writeFile(file, text, 'utf8');
  await loadConfig(vaultPath);
}

function refuseTempLocation(root: string): void {
  try {
    assertNotUnderTempRoot(root, 'demo directory');
  } catch (error) {
    if (!(error instanceof UnsafeWorktreePathError)) throw error;
    throw new CliError(
      `The demo would live in ${root}, which is under a temp directory, and the factory never puts ` +
        'worktrees there (plan Section E item 7). Set FACTORY_HOME to a directory outside the temp ' +
        'folders, or leave it unset.',
    );
  }
}

async function refuseWhileRunning(layout: DemoLayout, seams: DashboardSeams): Promise<void> {
  const view = await readLockView(
    new VaultPaths(layout.vault),
    seams.isAlive === undefined ? {} : { isAlive: seams.isAlive },
  );
  if (view.mode === 'external') {
    throw new CliError(
      `The demo is running in another process (pid ${String(view.pid)}). Stop it there, then run ` +
        '`factory demo --fresh` again.',
    );
  }
}

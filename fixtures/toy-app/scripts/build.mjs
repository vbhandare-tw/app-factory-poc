#!/usr/bin/env node
/**
 * A real build gate with zero npm dependencies.
 *
 * There is no `tsc` here on purpose: the fixture must run from a fresh git
 * worktree with no `npm install`, so it can only use what Node ships. What the
 * factory needs from `build` is a real subprocess whose exit code is 0 exactly
 * when the source is loadable, and a build artefact on disk.
 *
 * So: load every non-test module under `src/` through Node's TypeScript type
 * stripping (which rejects syntax errors and non-erasable TS such as `enum` or
 * `namespace`), then emit `dist/build-manifest.json` describing what was built.
 *
 * LIMITATION, stated plainly: this validates syntax and module resolution, not
 * types. A type error that is still valid syntax will not fail this gate.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectModules(dir) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return found;
    }
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...(await collectModules(full)));
      continue;
    }
    if (!/\.m?ts$/.test(entry.name)) continue;
    if (/\.(test|spec)\.m?ts$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

async function main() {
  const modules = await collectModules(SRC_DIR);

  if (modules.length === 0) {
    console.error('build: no modules found under src/');
    process.exitCode = 1;
    return;
  }

  /** @type {{ module: string, sha256: string, exports: string[] }[]} */
  const built = [];
  /** @type {{ module: string, error: string }[]} */
  const failures = [];

  for (const file of modules) {
    const relative = path.relative(REPO_ROOT, file);
    const source = await readFile(file, 'utf8');
    try {
      const loaded = await import(pathToFileURL(file).href);
      built.push({
        module: relative,
        sha256: createHash('sha256').update(source).digest('hex'),
        exports: Object.keys(loaded).sort(),
      });
    } catch (error) {
      failures.push({ module: relative, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`build failed: ${failure.module}\n  ${failure.error}`);
    }
    process.exitCode = 1;
    return;
  }

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(
    path.join(DIST_DIR, 'build-manifest.json'),
    `${JSON.stringify({ name: 'toy-app', modules: built }, null, 2)}\n`,
    'utf8',
  );

  console.log(`build: ${built.length} module(s) -> dist/build-manifest.json`);
}

await main();

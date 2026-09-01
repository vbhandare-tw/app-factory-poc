/**
 * A child process that dies **in the middle of a dispatch**.
 *
 * Sibling of `crashDuringWrite.mjs`, and here for the same reason: an
 * in-process thrown error runs our own `finally` blocks — including the one
 * that releases the item claim — which is precisely the code a real crash does
 * not run. A test built on a thrown error would therefore hand the restart a
 * tidier vault than a crash ever leaves, and the recovery it proves would be
 * recovery from a situation that cannot happen. SIGKILL cannot be caught, so
 * what is on disk when this exits is what would survive a power cut.
 *
 * Run as:
 *   node crashDuringDispatch.mjs <vault> <after_run|after_side_files|after_persist> <fixtures.json>
 *
 * It drives the **real** `Orchestrator`, not a hand-rolled copy of the dispatch
 * flow. A second copy would drift from the real one and this test would then be
 * measuring the copy.
 *
 * It imports the built output rather than the TypeScript sources, because Node's
 * type stripping cannot resolve the `.js` specifiers the sources use. The test
 * builds `dist/` before spawning this.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'dist', 'index.js');

const { loadConfig, MarkdownStorage, MockRunner, Orchestrator, VaultPaths } = await import(DIST);

const [vaultPath, crashPoint, fixturesFile] = process.argv.slice(2);
if (!vaultPath || !crashPoint || !fixturesFile) {
  console.error('usage: crashDuringDispatch.mjs <vault> <crashPoint> <fixtures.json>');
  process.exit(2);
}

const paths = new VaultPaths(vaultPath);
const config = await loadConfig(vaultPath);
const storage = new MarkdownStorage(paths);
const runner = new MockRunner({ fixtures: JSON.parse(readFileSync(fixturesFile, 'utf8')) });

const orchestrator = await Orchestrator.start({
  paths,
  config,
  storage,
  runner,
  hooks: {
    crash(point, info) {
      if (point !== crashPoint) return;
      process.stdout.write(`CRASH ${point} ${info.itemId}\n`);
      process.kill(process.pid, 'SIGKILL');
      // Unreachable if SIGKILL behaved. Spin briefly so a platform where it did
      // not fails with a distinctive exit code instead of quietly carrying on
      // and releasing the claim we are trying to leave behind.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        /* wait to be killed */
      }
      process.exit(99);
    },
  },
});

await orchestrator.run({ maxCycles: 1, sleep: async () => undefined });
await orchestrator.shutdown();

// Reaching here means the crash point never fired — which is a broken test, not
// a passing one. The distinctive code says so.
process.exit(98);

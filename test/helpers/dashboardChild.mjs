/**
 * A real `factory dashboard` process whose agents are canned and can be slow.
 *
 * Run as:
 *   node dashboardChild.mjs <vault> <fixtures.json> <factory-home>
 *
 * It calls the built `runDashboard` with `--start` semantics and real process
 * signals, so a test can send SIGINT by this process's own pid. Agent runs
 * print `RUN_START <role> <itemId>` and `RUN_END <role> <ok|failure>`.
 *
 * Imports `dist/`, like `crashDuringDispatch.mjs`: the test builds it first.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'dist');

const { runDashboard } = await import(path.join(DIST, 'cli', 'dashboard.js'));
const { MockRunner, ProjectRegistry } = await import(path.join(DIST, 'index.js'));

const [vaultPath, fixturesFile, home] = process.argv.slice(2);
if (!vaultPath || !fixturesFile || !home) {
  console.error('usage: dashboardChild.mjs <vault> <fixtures.json> <factory-home>');
  process.exit(2);
}

const mock = new MockRunner({ fixtures: JSON.parse(readFileSync(fixturesFile, 'utf8')) });
const runner = {
  async run(spec, signal) {
    process.stdout.write(`RUN_START ${spec.role} ${spec.itemId}\n`);
    const result = await mock.run(spec, signal);
    process.stdout.write(`RUN_END ${spec.role} ${result.ok ? 'ok' : result.failure}\n`);
    return result;
  },
};

const dashboard = await runDashboard(
  { vault: vaultPath, port: 0, open: false, start: true },
  {
    cwd: vaultPath,
    env: { PATH: process.env.PATH ?? '' },
    registry: new ProjectRegistry(home),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
    runner,
  },
);

await dashboard.closed;
process.stdout.write('CLOSED\n');

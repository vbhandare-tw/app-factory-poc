/**
 * Holds a vault's instance lock from a second process, as a terminal
 * `factory start` would, until it is sent SIGTERM.
 *
 * Run as:
 *   node holdLock.mjs <vault>
 *
 * Prints `LOCKED` once the lock is held. Imports `dist/`; the test builds it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'dist', 'index.js');

const { InstanceLock, VaultPaths } = await import(DIST);

const [vaultPath] = process.argv.slice(2);
if (!vaultPath) {
  console.error('usage: holdLock.mjs <vault>');
  process.exit(2);
}

const lock = await InstanceLock.acquire(new VaultPaths(vaultPath), { pollIntervalSec: 15 });
const keepAlive = setInterval(() => undefined, 60_000);

process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  lock.release().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

process.stdout.write('LOCKED\n');

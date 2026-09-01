/**
 * A child process that dies between the temp write and the rename.
 *
 * This is the only way to prove the crash-safety guarantee in plan Section E
 * item 1 for real: an in-process thrown error runs our own cleanup path, which
 * is exactly the path a power cut does not run. SIGKILL cannot be caught, so
 * what survives on disk here is what would survive a real crash.
 *
 * Run as:
 *   node --experimental-strip-types crashDuringWrite.mjs <target> <contentFile>
 *
 * It imports `src/vault/atomic.ts` by its real `.ts` path, which Node's type
 * stripping resolves. That works only because `atomic.ts` imports nothing but
 * node builtins — if that ever stops being true, this script breaks loudly
 * rather than silently testing nothing.
 */
import { readFileSync } from 'node:fs';

import { atomicWrite } from '../../src/vault/atomic.ts';

const [target, contentFile] = process.argv.slice(2);
if (!target || !contentFile) {
  console.error('usage: crashDuringWrite.mjs <target> <contentFile>');
  process.exit(2);
}

const contents = readFileSync(contentFile, 'utf8');

await atomicWrite(target, contents, {
  beforeRename(tempPath) {
    process.stdout.write(`${tempPath}\n`);
    process.kill(process.pid, 'SIGKILL');
    // Unreachable if SIGKILL behaved. Spin briefly so a platform where it did
    // not fails with a distinctive exit code instead of quietly renaming.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      /* wait to be killed */
    }
    process.exit(99);
  },
});

process.exit(0);

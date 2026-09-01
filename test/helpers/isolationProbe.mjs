/**
 * The blast-radius probe (spec §14 probes 10–14; plan Phase 5).
 *
 * Copied into worktree A and run there by a real, sandboxed agent through the
 * Bash tool. It attempts every escape ADR-003 must block, records the errno the
 * kernel returned, and writes the answers to `probe-result.json` in its own
 * worktree — the one place it *is* allowed to write.
 *
 * Two deliberate design choices:
 *
 * - It is **node**, not `cat`/`echo`. Spec §4.1 records that Claude Code's own
 *   `Read(...)` deny rules are bypassed entirely by `node -e
 *   "fs.readFileSync(...)"`. Probing through node is what makes this a test of
 *   the kernel sandbox rather than of the tool-permission layer.
 * - The verdict comes from **this file's captured errno**, never from the
 *   agent's prose. An agent that hallucinates "all blocked" cannot make the
 *   test pass.
 *
 * It also checks the two things that must still WORK. A fence that blocks
 * everything is as wrong as one that blocks nothing, and only these positive
 * assertions catch it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Targets come from `probe-config.json` in this worktree, written by the test.
 *
 * Deliberately not derived from a `<base>/repo` layout or a symlink: the
 * sandbox matches on resolved paths, so a probe reaching the repo through a
 * different path than the one `denyWrite` was built from would test nothing and
 * still look convincing.
 */
const config = JSON.parse(readFileSync(path.join(process.cwd(), 'probe-config.json'), 'utf8'));
const repo = config.repo;
const worktreeB = config.worktreeB;
const home = os.homedir();

const results = {};

function tryWrite(name, target, makeParent = false) {
  try {
    if (makeParent) mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'factory-isolation-probe\n');
    results[name] = { blocked: false, code: null, target };
  } catch (error) {
    results[name] = { blocked: true, code: error.code ?? String(error), target };
  }
}

function tryCommand(name, command, args) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  results[name] = {
    status: outcome.status,
    signal: outcome.signal ?? null,
    stdout: (outcome.stdout ?? '').slice(0, 400),
    stderr: (outcome.stderr ?? '').slice(0, 400),
    error: outcome.error ? String(outcome.error) : null,
  };
}

// --- must be blocked -------------------------------------------------------
tryWrite('write_main_checkout', path.join(repo, 'ESCAPED.txt'));
tryWrite('write_sibling_worktree', path.join(worktreeB, 'ESCAPED.txt'));
tryWrite('write_home', path.join(home, '.factory-isolation-ESCAPED.txt'));
tryWrite('write_git_hooks', path.join(repo, '.git', 'hooks', 'pre-commit'), true);
tryWrite('write_git_config', path.join(repo, '.git', 'config'));
tryWrite('write_git_refs', path.join(repo, '.git', 'refs', 'heads', 'pwned'), true);
tryWrite('write_git_objects', path.join(repo, '.git', 'objects', 'ESCAPED'), true);

// --- must still work -------------------------------------------------------
tryWrite('write_own_worktree', path.join(process.cwd(), 'own-write-ok.txt'));
tryCommand('git_status', 'git', ['status', '--short']);
tryCommand('git_diff', 'git', ['diff']);

// --- must be blocked, but only after the two above have been proven to work --
// `git add` is last because it is the one that changes the index.
tryCommand('git_add', 'git', ['add', '-A']);

writeFileSync(path.join(process.cwd(), 'probe-result.json'), JSON.stringify(results, null, 2));
console.log('PROBE_WRITTEN');

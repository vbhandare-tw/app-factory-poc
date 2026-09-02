/**
 * `verify-isolation` — the only test in this suite that must call the real CLI.
 *
 * ============================================================================
 * WHY A STUB CANNOT REPLACE THIS
 * ============================================================================
 * Everything else about the sandbox is testable only as *shape*. A unit test on
 * `buildSandboxSettings` compares the object we built against the object we
 * expected — the same belief written down twice. A stub `claude` accepts
 * `--settings` and ignores it. Neither can tell the difference between a fence
 * and a well-formed JSON object that fences nothing, and Claude Code's own
 * `--help` warns that in `--print` mode "Settings files that fail validation are
 * silently ignored (no error dialog is shown)".
 *
 * So this test provisions a real repo and two real worktrees, runs a real
 * cheap-model agent inside worktree A, and reads the errno the macOS kernel
 * actually returned for each escape attempt.
 *
 * If you are tempted to stub this to get a green run: don't. Delete it instead,
 * so the loss is visible. A truthful red is worth more than a false green here.
 *
 * ============================================================================
 * CLI VERSION
 * ============================================================================
 * The pin lives in `test/helpers/cliVersion.ts`, shared with the two other
 * real-CLI files so it cannot drift between them. Originally calibrated against
 * **v2.1.220** (the version spec §4.2/§4.5 were written from), re-probed and
 * still passing at **v2.1.258** on macOS 24.6.0. The test asserts the installed
 * version and reports a mismatch loudly, because a failure after an upgrade is a
 * security regression, not a flake (plan Section C).
 *
 * ============================================================================
 * HOW TO RUN IT — the tag
 * ============================================================================
 *   npm run test:isolation      # just this file
 *   FACTORY_REAL_CLI=1 npm test # the whole suite including this
 *   CI=1 npm test               # what CI does — this file is mandatory there
 *
 * Without `FACTORY_REAL_CLI=1` or `CI`, the real-CLI case reports as SKIPPED
 * (never as passing) and the free negative-control case below still runs. It
 * costs about $0.02 and ~30s per run, which is why it is off in the fast local
 * loop.
 *
 * ============================================================================
 * WORKTREE LOCATION
 * ============================================================================
 * The repo and both worktrees live under `.factory-test-repos/`, never a temp
 * path. `$TMPDIR` and `/tmp/claude*` are on the sandbox's default *write*
 * allowlist (spec §4.2), so a worktree there is silently unfenced and this
 * whole test would pass while proving nothing. Plan Section E item 7; the
 * runtime guard is in `test/helpers/toyRepo.ts`.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { ShellGit } from '../../src/git/git.js';
import { worktreeRoot } from '../../src/git/paths.js';
import { provisionWorktree } from '../../src/git/worktree.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { ClaudeCodeRunner } from '../../src/runner/claudeCode.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { PROBED_CLI_VERSION, installedCliVersion } from '../helpers/cliVersion.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, git, scratchDir, toyRepo } from '../helpers/toyRepo.js';
import { testProfile, testSandboxConfig, testSpec } from '../helpers/runnerFixtures.js';


/** Cheapest model that still drives the Bash tool. Spec §14 used the same one. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The tag. Opt-in locally, automatic in CI.
 *
 * Deliberately NOT `describe.skip` — a hard skip is invisible in a long run.
 * `describe.skipIf` leaves a named SKIPPED entry in every report.
 */
const RUN_REAL_CLI =
  process.env['FACTORY_REAL_CLI'] === '1' ||
  (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== '0');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_SOURCE = path.resolve(HERE, '..', 'helpers', 'isolationProbe.mjs');

/** Everything the probe must be refused. */
const MUST_BE_BLOCKED = [
  'write_main_checkout',
  'write_sibling_worktree',
  'write_home',
  'write_git_hooks',
  'write_git_config',
  'write_git_refs',
  'write_git_objects',
] as const;

interface ProbeWrite {
  blocked: boolean;
  code: string | null;
  target: string;
}
interface ProbeCommand {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
}
type ProbeResult = Record<string, ProbeWrite & ProbeCommand>;

interface Arena {
  readonly base: string;
  readonly repo: string;
  readonly worktreeA: string;
  readonly worktreeB: string;
  readonly homeEscape: string;
}

const arenas: Arena[] = [];
/** Worktree roots created by the real provisioner. Cleaned with the arenas. */
const provisionedRoots: string[] = [];

afterAll(() => {
  for (const root of provisionedRoots) rmSync(root, { recursive: true, force: true });
  for (const arena of arenas) {
    // Remove the worktrees through git so the repo's administrative files go too.
    for (const worktree of [arena.worktreeA, arena.worktreeB]) {
      try {
        git(arena.repo, ['worktree', 'remove', '--force', worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    rmSync(arena.base, { recursive: true, force: true });
    rmSync(arena.homeEscape, { force: true });
  }
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

/**
 * A repo plus two sibling worktrees, all outside any temp path.
 *
 * Worktree B exists purely so the probe has a sibling to try to reach. Without
 * it the test could not tell "confined to my worktree" from "confined to the
 * repo tree", and those are very different guarantees.
 */
function arena(): Arena {
  const repo = toyRepo();
  const base = scratchDir('isolation-');
  const worktreeA = path.join(base, 'wtA');
  const worktreeB = path.join(base, 'wtB');

  git(repo.path, ['worktree', 'add', '--quiet', worktreeA, '-b', 'iso-a']);
  git(repo.path, ['worktree', 'add', '--quiet', worktreeB, '-b', 'iso-b']);

  copyFileSync(PROBE_SOURCE, path.join(worktreeA, 'probe.mjs'));
  // The probe reads its targets from here rather than deriving them from a
  // directory layout. The paths it attacks are then exactly the paths the fence
  // was built from — no symlink or `..` in between to make the result ambiguous.
  writeFileSync(
    path.join(worktreeA, 'probe-config.json'),
    JSON.stringify({ repo: repo.path, worktreeB }, null, 2),
    'utf8',
  );

  const result: Arena = {
    base,
    repo: repo.path,
    worktreeA,
    worktreeB,
    homeEscape: path.join(os.homedir(), '.factory-isolation-ESCAPED.txt'),
  };
  arenas.push(result);
  return result;
}

/**
 * The same arena, but with both worktrees built by the **real**
 * `provisionWorktree` (plan Phase 8).
 *
 * ============================================================================
 * WHY THIS EXISTS ALONGSIDE `arena()` AND DOES NOT REPLACE IT
 * ============================================================================
 * `arena()` builds its worktrees by hand, which is what makes it a clean test
 * of the fence: it isolates the sandbox from whatever the provisioner happens
 * to do. But it means nothing in this suite ever ran an agent inside a worktree
 * the production code chose the location of — and the location **is** the
 * fence, because the sandbox's default write allowlist covers `$TMPDIR` and
 * `/tmp/claude*` (spec §4.2).
 *
 * That gap had a very specific failure shape. If `provisionWorktree` put
 * worktrees somewhere subtly different — a symlinked parent resolving into
 * `/private/var`, a root derived two calls deep from `os.tmpdir()` — then the
 * unit test on the path string would still pass (it asserts against the same
 * constant the implementation used), this file would still pass (it never
 * called the provisioner), and in production every agent would run unfenced
 * with nothing anywhere going red.
 *
 * So: same probe, same assertions, real provisioner. This is the only case in
 * the phase that can fail for the right reason.
 */
async function provisionedArena(): Promise<Arena> {
  const repo = toyRepo();
  const vaultName = `iso-vault-${provisionedRoots.length + 1}`;
  const handle = new ShellGit({ repoRoot: repo.path });
  provisionedRoots.push(worktreeRoot(repo.path, vaultName));

  await handle.ensureBranch('feature/isolation', repo.branch);

  const build = async (ticketId: string): Promise<string> =>
    (
      await provisionWorktree({
        git: handle,
        repoRoot: repo.path,
        vaultName,
        ticketId,
        featureSlug: 'isolation',
        title: `Ticket ${ticketId}`,
        fromRef: 'feature/isolation',
        setupCommand: 'npm ci --no-audit --no-fund --offline',
        setupTimeoutMs: 300_000,
      })
    ).path;

  const worktreeA = await build('FEAT-ISO-T001');
  const worktreeB = await build('FEAT-ISO-T002');

  copyFileSync(PROBE_SOURCE, path.join(worktreeA, 'probe.mjs'));
  writeFileSync(
    path.join(worktreeA, 'probe-config.json'),
    JSON.stringify({ repo: repo.path, worktreeB }, null, 2),
    'utf8',
  );

  const result: Arena = {
    base: worktreeRoot(repo.path, vaultName),
    repo: repo.path,
    worktreeA,
    worktreeB,
    homeEscape: path.join(os.homedir(), '.factory-isolation-ESCAPED.txt'),
  };
  arenas.push(result);
  return result;
}

/** Run the probe directly and return what it recorded. */
function readProbeResult(worktreeA: string): ProbeResult {
  const file = path.join(worktreeA, 'probe-result.json');
  expect(existsSync(file), `the probe never wrote ${file} — it did not run`).toBe(true);
  return JSON.parse(readFileSync(file, 'utf8')) as ProbeResult;
}


describe('verify-isolation — negative control (no CLI, always runs)', () => {
  it('the probe detects a completely unfenced world', () => {
    // This is what makes the real-CLI case below meaningful. If the probe could
    // not tell an unfenced world from a fenced one, every assertion there would
    // be vacuous — which is exactly the failure mode that would go unnoticed.
    const a = arena();

    execFileSync(process.execPath, ['probe.mjs'], { cwd: a.worktreeA, stdio: 'ignore' });
    const results = readProbeResult(a.worktreeA);

    for (const key of MUST_BE_BLOCKED) {
      expect(results[key]?.blocked, `unsandboxed, ${key} should have SUCCEEDED`).toBe(false);
    }
    expect(results['write_own_worktree']?.blocked).toBe(false);
    expect(results['git_status']?.status).toBe(0);

    // Clean up what the unfenced run really did create.
    rmSync(a.homeEscape, { force: true });
    rmSync(path.join(a.repo, 'ESCAPED.txt'), { force: true });
    rmSync(path.join(a.worktreeB, 'ESCAPED.txt'), { force: true });
  });

  it('the real provisioner puts its worktrees where the fence can reach them', async () => {
    // Free, always on, and the cheap half of the guarantee: the location the
    // production code chooses is not on the sandbox's default write allowlist.
    // The paid half — that the kernel then actually refuses — is the real-CLI
    // case below.
    const a = await provisionedArena();

    for (const worktree of [a.worktreeA, a.worktreeB]) {
      for (const temp of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()]) {
        expect(
          path.resolve(worktree).startsWith(`${path.resolve(temp)}${path.sep}`),
          `${worktree} is under ${temp}, which is on the sandbox write allowlist (spec §4.2)`,
        ).toBe(false);
      }
      expect(path.resolve(worktree).startsWith(`${path.resolve(a.repo)}${path.sep}`)).toBe(false);
    }
    expect(a.worktreeA).not.toBe(a.worktreeB);
  });

  it('the installed CLI is the version these expectations were probed against', () => {
    const version = installedCliVersion();
    expect(
      version,
      `Claude Code reports "${version}" but the sandbox findings in spec §4.2/§4.5 and this ` +
        `test's expectations were probed against ${PROBED_CLI_VERSION}. A sandbox failure after ` +
        'an upgrade is a security regression, not a flake (ADR-003).',
    ).toContain(PROBED_CLI_VERSION);
  });
});

describe.skipIf(!RUN_REAL_CLI)('verify-isolation — real CLI (FACTORY_REAL_CLI=1 or CI)', () => {
  it('a sandboxed agent cannot escape its worktree, and keeps read-only git', async () => {
    const a = arena();
    const vault = new VaultPaths(scratchDir('isolation-vault-'));
    const events = new MemoryEventLog();

    const runner = new ClaudeCodeRunner({
      config: testSandboxConfig(),
      // The fence is derived from this, and `probe-config.json` hands the probe
      // the very same path — so a mismatch cannot make the test pass by accident.
      repoRoot: a.repo,
      events,
    });

    const spec = testSpec({
      role: 'developer',
      cwd: a.worktreeA,
      model: PROBE_MODEL,
      // The cheapest prompt that still exercises the Bash tool and therefore a
      // sandboxed child process — which is the thing being tested.
      prompt: 'Use the Bash tool to run exactly this command: node probe.mjs — then reply DONE.',
      systemPromptAppend: '',
      profile: testProfile({
        role: 'developer',
        cwd: 'ticket_worktree',
        tools: ['Bash'],
        allowedTools: ['Bash'],
        timeoutMs: 180_000,
        maxBudgetUsd: 0.5,
      }),
      outputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string' } },
        required: ['outcome'],
        additionalProperties: false,
      },
      itemId: 'FEAT-ISO-T001',
      featureSlug: 'isolation',
      transcriptPath: vault.logPath('isolation', 'FEAT-ISO-T001', 1, 'developer'),
    });

    const result = await runner.run(spec, new AbortController().signal);

    // Reported so the real cost of this test is never a guess.
    console.log(
      `[verify-isolation] cli=${installedCliVersion()} model=${PROBE_MODEL} ` +
        `total_cost_usd=${result.costUsd} turns=${result.numTurns} ok=${result.ok} ` +
        `terminal=${result.terminalReason}`,
    );

    expect(
      result.failure,
      `the agent run itself failed (${result.terminalReason}); nothing about the fence was proven`,
    ).toBeUndefined();

    const results = readProbeResult(a.worktreeA);

    // The evidence, printed on every run. A green tick with no visible errno is
    // exactly the kind of result nobody checks; this makes the kernel's answer
    // part of the record.
    for (const [name, outcome] of Object.entries(results)) {
      const verdict =
        outcome.target !== undefined
          ? `blocked=${String(outcome.blocked)} errno=${outcome.code ?? 'none'}`
          : `exit=${String(outcome.status)}${
              outcome.stderr ? ` stderr=${outcome.stderr.trim().split('\n')[0]}` : ''
            }`;
      console.log(`[verify-isolation] ${name.padEnd(24)} ${verdict}`);
    }

    // ---- every escape is refused by the kernel ----------------------------
    for (const key of MUST_BE_BLOCKED) {
      expect(results[key]?.blocked, `${key} was NOT blocked: ${JSON.stringify(results[key])}`).toBe(
        true,
      );
      expect(results[key]?.code, `${key} was blocked but not with EPERM`).toBe('EPERM');
    }

    // ---- and independently of what the probe said about itself ------------
    expect(existsSync(a.homeEscape), 'a file was created in the home directory').toBe(false);
    expect(existsSync(path.join(a.repo, 'ESCAPED.txt')), 'the main checkout was written').toBe(false);
    expect(existsSync(path.join(a.worktreeB, 'ESCAPED.txt')), 'worktree B was written').toBe(false);
    expect(existsSync(path.join(a.repo, '.git', 'hooks', 'pre-commit')), 'a git hook was planted').toBe(
      false,
    );
    expect(existsSync(path.join(a.repo, '.git', 'refs', 'heads', 'pwned')), 'a ref was created').toBe(
      false,
    );

    // ---- git staging is refused ------------------------------------------
    const gitAdd = results['git_add'];
    expect(gitAdd?.status, 'git add succeeded — the agent can stage').not.toBe(0);
    expect(
      gitAdd?.stderr,
      'git add failed, but not because of the object-store fence — check the reason',
    ).toMatch(/not permitted/i);
    expect(
      gitAdd?.stderr,
      'git add failed on ~/.gitconfig, not on the .git fence: the fence was never reached',
    ).not.toMatch(/\.gitconfig/);

    // ---- and the read-only git the agent legitimately needs still works ----
    // A fence that blocks everything is as wrong as one that blocks nothing.
    for (const key of ['git_status', 'git_diff'] as const) {
      expect(
        results[key]?.status,
        `${key} must still work under the fence: ${JSON.stringify(results[key])}`,
      ).toBe(0);
      // Exit 0 is not enough on its own. Before GIT_CONFIG_GLOBAL/XDG_CONFIG_HOME
      // were pinned, these commands failed `fatal: unable to access
      // '<home>/.gitconfig': Operation not permitted` (exit 128) and then, once
      // that was fixed, still warned twice per command about
      // `~/.config/git/ignore`. Both would leak into the agent's context.
      expect(results[key]?.stderr ?? '', `${key} still touches the fenced home`).not.toMatch(
        /not permitted/i,
      );
      expect(results[key]?.stderr ?? '').not.toMatch(/fatal:/i);
    }

    // ---- and the agent can still do its actual job ------------------------
    expect(results['write_own_worktree']?.blocked, 'the agent cannot write its own worktree').toBe(
      false,
    );

    // The transcript exists and is live-parseable JSONL.
    const lines = readFileSync(spec.transcriptPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(events.ofType('run_finished')[0]?.ok).toBe(true);
  }, 300_000);
});

/**
 * The same probe, against a worktree the **production provisioner** made.
 *
 * See the note on `provisionedArena` for why this is a separate case rather
 * than a rewrite of the one above: the hand-built arena isolates the fence from
 * the provisioner, and this one closes the gap that isolation leaves — an agent
 * has never, in any other test, run in a directory `src/git/worktree.ts` chose.
 *
 * It costs a second real-CLI run. That is the price of the only assertion in
 * Phase 8 that can fail for the right reason.
 */
describe.skipIf(!RUN_REAL_CLI)('verify-isolation — real CLI, worktree from provisionWorktree', () => {
  it('a sandboxed agent in a provisioned worktree cannot escape it, and keeps read-only git', async () => {
    const a = await provisionedArena();
    const vault = new VaultPaths(scratchDir('isolation-vault-'));
    const events = new MemoryEventLog();

    const runner = new ClaudeCodeRunner({
      config: testSandboxConfig(),
      repoRoot: a.repo,
      events,
    });

    const spec = testSpec({
      role: 'developer',
      cwd: a.worktreeA,
      model: PROBE_MODEL,
      prompt: 'Use the Bash tool to run exactly this command: node probe.mjs — then reply DONE.',
      systemPromptAppend: '',
      profile: testProfile({
        role: 'developer',
        cwd: 'ticket_worktree',
        tools: ['Bash'],
        allowedTools: ['Bash'],
        timeoutMs: 180_000,
        maxBudgetUsd: 0.5,
      }),
      outputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string' } },
        required: ['outcome'],
        additionalProperties: false,
      },
      itemId: 'FEAT-ISO-T001',
      featureSlug: 'isolation',
      transcriptPath: vault.logPath('isolation', 'FEAT-ISO-T001', 1, 'developer'),
    });

    const result = await runner.run(spec, new AbortController().signal);

    console.log(
      `[verify-isolation:provisioned] worktree=${a.worktreeA}`,
    );
    console.log(
      `[verify-isolation:provisioned] cli=${installedCliVersion()} model=${PROBE_MODEL} ` +
        `total_cost_usd=${result.costUsd} turns=${result.numTurns} ok=${result.ok} ` +
        `terminal=${result.terminalReason}`,
    );

    expect(
      result.failure,
      `the agent run itself failed (${result.terminalReason}); nothing about the fence was proven`,
    ).toBeUndefined();

    const results = readProbeResult(a.worktreeA);

    for (const [name, outcome] of Object.entries(results)) {
      const verdict =
        outcome.target !== undefined
          ? `blocked=${String(outcome.blocked)} errno=${outcome.code ?? 'none'}`
          : `exit=${String(outcome.status)}${
              outcome.stderr ? ` stderr=${outcome.stderr.trim().split('\n')[0]}` : ''
            }`;
      console.log(`[verify-isolation:provisioned] ${name.padEnd(24)} ${verdict}`);
    }

    // ---- every escape is refused by the kernel ----------------------------
    for (const key of MUST_BE_BLOCKED) {
      expect(results[key]?.blocked, `${key} was NOT blocked: ${JSON.stringify(results[key])}`).toBe(
        true,
      );
      expect(results[key]?.code, `${key} was blocked but not with EPERM`).toBe('EPERM');
    }

    // ---- and independently of what the probe said about itself ------------
    expect(existsSync(a.homeEscape), 'a file was created in the home directory').toBe(false);
    expect(existsSync(path.join(a.repo, 'ESCAPED.txt')), 'the main checkout was written').toBe(false);
    expect(existsSync(path.join(a.worktreeB, 'ESCAPED.txt')), 'the sibling worktree was written').toBe(
      false,
    );
    expect(existsSync(path.join(a.repo, '.git', 'hooks', 'pre-commit')), 'a git hook was planted').toBe(
      false,
    );
    expect(existsSync(path.join(a.repo, '.git', 'refs', 'heads', 'pwned')), 'a ref was created').toBe(
      false,
    );

    // ---- git staging is refused ------------------------------------------
    const gitAdd = results['git_add'];
    expect(gitAdd?.status, 'git add succeeded — the agent can stage').not.toBe(0);
    expect(
      gitAdd?.stderr,
      'git add failed, but not because of the object-store fence — check the reason',
    ).toMatch(/not permitted/i);
    expect(
      gitAdd?.stderr,
      'git add failed on ~/.gitconfig, not on the .git fence: the fence was never reached',
    ).not.toMatch(/\.gitconfig/);

    // ---- and the read-only git the agent legitimately needs still works ----
    for (const key of ['git_status', 'git_diff'] as const) {
      expect(
        results[key]?.status,
        `${key} must still work under the fence: ${JSON.stringify(results[key])}`,
      ).toBe(0);
      expect(results[key]?.stderr ?? '', `${key} still touches the fenced home`).not.toMatch(
        /not permitted/i,
      );
      expect(results[key]?.stderr ?? '').not.toMatch(/fatal:/i);
    }

    // ---- and the agent can still do its actual job ------------------------
    expect(results['write_own_worktree']?.blocked, 'the agent cannot write its own worktree').toBe(
      false,
    );
    expect(events.ofType('run_finished')[0]?.ok).toBe(true);
  }, 300_000);
});

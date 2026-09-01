/**
 * `execCapture` — the process boundary the unsandboxed `setup_command` crosses.
 *
 * ============================================================================
 * WHY OUTPUT CAPPING NEEDS A TEST OF ITS OWN
 * ============================================================================
 * `config.setup_command` runs unsandboxed, with network, as the orchestrator
 * (plan resolution A3). Three things bound what happens when it goes wrong: a
 * deadline, a captured-and-capped output, and a failure that removes the
 * worktree. The first and third are covered by `worktree.test.ts`. The second
 * was not covered anywhere — a test named for it asserted something else
 * entirely, which is worse than no test, because the name reads as coverage.
 *
 * What it protects: the tail of this output goes into a `needs_human` note's
 * `pause_detail`, i.e. into a YAML frontmatter value a human reads in Obsidian.
 * An `npm ci` that fails after downloading half a registry produces megabytes.
 * Uncapped, that lands in the vault.
 *
 * **The tail, not the head.** A failing install prints its reason last. A cap
 * that kept the first 20k characters would reliably preserve the part nobody
 * needs and discard the only line that explains anything — and it would look
 * identical in every test that merely checked "output was truncated".
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_OUTPUT_CHARS,
  describeExec,
  execCapture,
} from '../../../src/git/exec.js';
import { testRepoRoot } from '../../helpers/toyRepo.js';
import { mkdirSync } from 'node:fs';

const CWD = testRepoRoot();

function run(script: string, options: { timeoutMs?: number; maxOutputChars?: number } = {}) {
  mkdirSync(CWD, { recursive: true });
  return execCapture(process.execPath, ['-e', script], {
    cwd: CWD,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
  });
}

describe('output capping', () => {
  it('caps stdout at the configured size', async () => {
    // 500_000 characters — comfortably past the cap, and produced for real
    // rather than asserted about.
    const result = await run(
      "process.stdout.write('x'.repeat(500000));",
      { maxOutputChars: 1000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(1000);
  });

  it('keeps the END of the stream, which is where the failure is', async () => {
    const result = await run(
      "process.stdout.write('HEAD' + 'x'.repeat(200000) + 'THE-REAL-ERROR');",
      { maxOutputChars: 100 },
    );

    expect(result.stdout).toHaveLength(100);
    expect(result.stdout.endsWith('THE-REAL-ERROR')).toBe(true);
    // The head is exactly what a naive `slice(0, max)` would have kept.
    expect(result.stdout).not.toContain('HEAD');
  });

  it('caps stderr independently of stdout', async () => {
    const result = await run(
      "process.stdout.write('o'.repeat(50000)); process.stderr.write('e'.repeat(50000));",
      { maxOutputChars: 200 },
    );

    expect(result.stdout).toHaveLength(200);
    expect(result.stderr).toHaveLength(200);
  });

  it('caps output arriving in many small chunks, not just one big write', async () => {
    // The cap is applied per chunk as the stream arrives. A version that only
    // trimmed at the end would still pass the tests above while holding the
    // whole megabyte in memory first.
    const result = await run(
      "for (let i = 0; i < 5000; i += 1) process.stdout.write('chunk' + i + '\\n');",
      { maxOutputChars: 500 },
    );

    expect(result.stdout).toHaveLength(500);
    expect(result.stdout.trimEnd().endsWith('chunk4999')).toBe(true);
  });

  it('leaves output shorter than the cap completely alone', async () => {
    const result = await run("process.stdout.write('short and complete');");
    expect(result.stdout).toBe('short and complete');
  });

  it('defaults to a cap rather than to unbounded', async () => {
    // The default is what a caller that forgets the option gets, and every
    // caller in `src/git/**` forgets it.
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBeGreaterThan(0);
    const result = await run(`process.stdout.write('y'.repeat(${DEFAULT_MAX_OUTPUT_CHARS + 5000}));`);
    expect(result.stdout).toHaveLength(DEFAULT_MAX_OUTPUT_CHARS);
  });
});

describe('deadlines and failure shapes', () => {
  it('reports a timeout distinctly from a non-zero exit', async () => {
    const result = await run('setTimeout(() => {}, 60000);', { timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    // A caller must be able to tell "your install script is broken" from "your
    // install script never finishes" — they need different messages to a human.
    expect(result.status === null || result.status !== 0).toBe(true);
    expect(result.durationMs).toBeLessThan(30_000);
  });

  it('keeps whatever a timed-out process managed to print', async () => {
    const result = await run(
      "process.stdout.write('got this far\\n'); setTimeout(() => {}, 60000);",
      { timeoutMs: 500 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('got this far');
  });

  it('reports a non-zero exit as data, not as an exception', async () => {
    const result = await run("process.stderr.write('boom'); process.exit(7);");

    expect(result.status).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('boom');
    expect(result.spawnError).toBeNull();
  });

  it('reports a command that cannot be started at all', async () => {
    const result = await execCapture('definitely-not-a-real-binary-xyz', [], { cwd: CWD });

    expect(result.spawnError).not.toBeNull();
    expect(result.status).toBeNull();
  });

  it('describes a failure in one line a human can act on', async () => {
    const result = await run("process.stderr.write('registry unreachable'); process.exit(1);");
    const description = describeExec(result);

    expect(description).toContain('exited 1');
    expect(description).toContain('registry unreachable');
    expect(description).toContain(CWD);
  });
});

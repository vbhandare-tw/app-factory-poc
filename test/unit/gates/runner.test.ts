/**
 * The gate runner (plan Phase 9, spec §8.2, ADR-004).
 *
 * ============================================================================
 * WHY THESE RUN REAL SUBPROCESSES
 * ============================================================================
 * Every claim in ADR-004 is about an exit code the operating system produced.
 * A fake `ExecFn` returning `{status: 1}` would prove that this module can read
 * a number out of an object — it would pass equally well for an implementation
 * that never spawned anything, which is the only implementation worth being
 * afraid of here. So the pass, fail, short-circuit and timeout cases all run
 * real `node -e` commands through a real shell, and only the two shapes that
 * cannot be staged reliably (a spawn that fails outright) use the seam.
 *
 * The commands are `node -e` rather than shell builtins so the cases behave the
 * same wherever the suite runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { sectionText } from '../../../src/domain/markdown.js';
import { GATE_NAMES } from '../../../src/domain/states.js';
import type { GateName } from '../../../src/domain/states.js';
import { appendToSection } from '../../../src/vault/storage.js';
import type { ExecResult } from '../../../src/git/exec.js';
import { ChildProcessGateRunner } from '../../../src/gates/runner.js';
import type { GateConfig, GateRunOptions } from '../../../src/gates/runner.js';
import {
  allGatesPassed,
  describeGateFailure,
  firstFailedGate,
  NO_EXIT_CODE,
  renderGateResults,
  toGateSummaries,
} from '../../../src/gates/results.js';
import type { GateResults } from '../../../src/gates/results.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

const NODE = JSON.stringify(process.execPath);

/** A command that exits 0 after printing `text`. */
function passes(text: string): string {
  return `${NODE} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(text)})`)}`;
}

/**
 * A command that prints to stderr and exits 1.
 *
 * `process.exitCode = 1` rather than `process.exit(1)`: when stdout or stderr is
 * a pipe, `process.exit` **discards** whatever is still queued, so a busy
 * machine truncates the output mid-stream and the test that reads the tail
 * fails for a reason that has nothing to do with the gate runner. Setting the
 * code lets the process end naturally, once the streams have flushed.
 */
function fails(text: string): string {
  return `${NODE} -e ${JSON.stringify(
    `process.stderr.write(${JSON.stringify(text)}); process.exitCode = 1`,
  )}`;
}

let dir: string;

beforeEach(() => {
  dir = scratchDir('gates-');
});

afterAll(() => {
  cleanupAllScratchDirs();
});

function optionsFor(overrides: Partial<GateRunOptions> = {}): GateRunOptions {
  const seen: GateName[] = [];
  return {
    logPathFor: (gate) => path.join(dir, 'logs', `${gate}.log`),
    maxOutputChars: 20_000,
    timeoutMs: 30_000,
    onGateFinished: (gate) => {
      seen.push(gate);
    },
    ...overrides,
  };
}

/** Which commands actually reached a process. The short-circuit's real evidence. */
function recordingExec(gates: GateConfig): {
  readonly exec: GateRunOptions['exec'];
  readonly ran: string[];
} {
  const ran: string[] = [];
  return {
    ran,
    exec: async (file, _args, execOptions): Promise<ExecResult> => {
      ran.push(file);
      const shouldFail = file === gates.tests;
      return await Promise.resolve({
        command: file,
        cwd: execOptions.cwd,
        status: shouldFail ? 1 : 0,
        signal: null,
        stdout: '',
        stderr: shouldFail ? 'boom' : '',
        timedOut: false,
        durationMs: 1,
        spawnError: null,
      });
    },
  };
}

describe('exit codes', () => {
  it('exit 0 is the only pass, and every gate is reported', async () => {
    const gates: GateConfig = {
      tests: passes('tests ok\n'),
      lint: passes('lint ok\n'),
      build: passes('build ok\n'),
    };

    const results = await new ChildProcessGateRunner().run(dir, gates, optionsFor());

    expect(Object.keys(results).sort()).toEqual([...GATE_NAMES].sort());
    for (const gate of GATE_NAMES) {
      expect(results[gate].status, gate).toBe('pass');
      expect(results[gate].exitCode, gate).toBe(0);
    }
    expect(allGatesPassed(results)).toBe(true);
    expect(firstFailedGate(results)).toBeNull();
  });

  it('a non-zero exit is a fail, and the output travels with it', async () => {
    const gates: GateConfig = {
      tests: fails('AssertionError: expected 2 to equal 3\n'),
      lint: passes('lint ok\n'),
      build: passes('build ok\n'),
    };

    const results = await new ChildProcessGateRunner().run(dir, gates, optionsFor());

    expect(results.tests.status).toBe('fail');
    expect(results.tests.exitCode).toBe(1);
    expect(results.tests.output).toContain('AssertionError: expected 2 to equal 3');
    expect(allGatesPassed(results)).toBe(false);
    expect(firstFailedGate(results)).toBe('tests');
    expect(describeGateFailure(results)).toContain('tests');
  });

  it('exit 2 is a fail too — the check is `=== 0`, not `!== 1`', async () => {
    const odd = `${NODE} -e "process.exitCode = 2"`;
    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: odd, lint: passes(''), build: passes('') },
      optionsFor(),
    );
    expect(results.tests.status).toBe('fail');
    expect(results.tests.exitCode).toBe(2);
  });
});

describe('short-circuiting on the first failure', () => {
  it('does not run lint or build after tests fails', async () => {
    const gates: GateConfig = {
      tests: 'TESTS_COMMAND',
      lint: 'LINT_COMMAND',
      build: 'BUILD_COMMAND',
    };
    const { exec, ran } = recordingExec(gates);

    const results = await new ChildProcessGateRunner().run(dir, gates, optionsFor({ exec }));

    // The assertion that matters: the later commands never reached a process.
    // Asserting only on `status: 'skipped'` would also pass for a runner that
    // ran them and then relabelled the results.
    expect(ran).toEqual(['TESTS_COMMAND']);
    expect(results.tests.status).toBe('fail');
    expect(results.lint.status).toBe('skipped');
    expect(results.build.status).toBe('skipped');
    expect(results.lint.output).toContain('the tests gate failed');
  });

  it('a skipped gate is not a pass — the ticket cannot advance on one', async () => {
    const gates: GateConfig = { tests: 'T', lint: 'L', build: 'B' };
    const { exec } = recordingExec(gates);
    const results = await new ChildProcessGateRunner().run(dir, gates, optionsFor({ exec }));

    expect(allGatesPassed(results)).toBe(false);
    // And the frontmatter a ticket would carry says so in every row.
    const summaries = toGateSummaries(results);
    expect(summaries.lint.status).toBe('skipped');
    expect(summaries.build.status).toBe('skipped');
  });

  it('runs every gate when the first ones pass', async () => {
    const gates: GateConfig = {
      tests: passes('a'),
      lint: passes('b'),
      build: passes('c'),
    };
    const seen: GateName[] = [];
    await new ChildProcessGateRunner().run(
      dir,
      gates,
      optionsFor({
        onGateFinished: (gate) => {
          seen.push(gate);
        },
      }),
    );
    expect(seen).toEqual(['tests', 'lint', 'build']);
  });
});

describe('output capping', () => {
  it('tails the frontmatter copy and writes the whole thing to the log', async () => {
    // See `fails()` on why this is `exitCode` and not `exit`.
    const noisy = `${NODE} -e "for (let i = 0; i < 400; i += 1) process.stdout.write('LINE' + i + ' ' + 'x'.repeat(40) + '\\n'); process.exitCode = 1"`;

    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: noisy, lint: passes(''), build: passes('') },
      optionsFor({ maxOutputChars: 300 }),
    );

    const result = results.tests;
    expect(result.status).toBe('fail');

    // The tail: bounded, and it is the *end* of the stream, because that is
    // where a failure summary is.
    expect(result.output.length).toBeLessThan(600);
    expect(result.output).toContain('LINE399');
    expect(result.output).not.toContain('LINE0 ');
    expect(result.output).toContain('earlier characters are in the log file');

    // The log: unbounded by `maxOutputChars`, and it has the beginning too.
    const log = readFileSync(result.logPath, 'utf8');
    expect(log.length).toBeGreaterThan(10_000);
    expect(log).toContain('LINE0 ');
    expect(log).toContain('LINE399');
  });

  it('does not tail an output that already fits', async () => {
    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: passes('short\n'), lint: passes(''), build: passes('') },
      optionsFor({ maxOutputChars: 20_000 }),
    );
    expect(results.tests.output).not.toContain('earlier characters');
    expect(results.tests.output).toContain('short');
  });
});

describe('a gate that cannot run', () => {
  it('reports a missing command as a failure with a readable reason, not a throw', async () => {
    const missing = 'this-command-does-not-exist-anywhere-12345';

    const run = new ChildProcessGateRunner().run(
      dir,
      { tests: missing, lint: passes(''), build: passes('') },
      optionsFor(),
    );

    await expect(run).resolves.toBeDefined();
    const results = await run;
    expect(results.tests.status).toBe('fail');
    expect(results.tests.output).toContain(missing);
    // The shell reports 127 for a command it cannot find. Whatever the number,
    // it is not 0, and that is the whole rule.
    expect(results.tests.exitCode).not.toBe(0);
  });

  it('reports a spawn that fails outright as a failure, not a throw', async () => {
    const exec = async (file: string, _args: readonly string[], execOptions: { cwd: string }): Promise<ExecResult> =>
      await Promise.resolve({
        command: file,
        cwd: execOptions.cwd,
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 3,
        spawnError: 'spawn ENOENT',
      });

    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: 'whatever', lint: passes(''), build: passes('') },
      optionsFor({ exec }),
    );

    expect(results.tests.status).toBe('fail');
    expect(results.tests.exitCode).toBe(NO_EXIT_CODE);
    expect(results.tests.output).toContain('spawn ENOENT');
  });

  it('reports an exec that throws as a failure, not a throw', async () => {
    const exec = (): Promise<ExecResult> => Promise.reject(new Error('the seam blew up'));

    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: 'whatever', lint: passes(''), build: passes('') },
      optionsFor({ exec }),
    );

    expect(results.tests.status).toBe('fail');
    expect(results.tests.output).toContain('the seam blew up');
  });
});

describe('a gate that never finishes', () => {
  it('is killed at its deadline and reported as a failure', async () => {
    const hangs = `${NODE} -e "setInterval(() => {}, 1000)"`;

    const started = Date.now();
    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: hangs, lint: passes(''), build: passes('') },
      optionsFor({ timeoutMs: 700 }),
    );

    expect(results.tests.status).toBe('fail');
    expect(results.tests.output).toContain('timed out');
    // It really was killed rather than waited out.
    expect(Date.now() - started).toBeLessThan(20_000);
    // And the gates behind it short-circuited, so a hung suite does not also
    // spend ten minutes on lint.
    expect(results.lint.status).toBe('skipped');
  }, 30_000);
});

describe('what reaches the note', () => {
  async function greenRun(): Promise<GateResults> {
    return await new ChildProcessGateRunner().run(
      dir,
      { tests: passes('ok\n'), lint: passes('ok\n'), build: passes('ok\n') },
      optionsFor(),
    );
  }

  it('the frontmatter summary is the snake_case shape a note round-trips', async () => {
    const summaries = toGateSummaries(await greenRun());
    expect(Object.keys(summaries.tests).sort()).toEqual([
      'duration_ms',
      'exit_code',
      'log_path',
      'output',
      'status',
    ]);
  });

  it('the rendered section names the commit the gates ran against', async () => {
    const rendered = renderGateResults(await greenRun(), { attempt: 2, commitSha: 'abc1234' });
    expect(rendered).toContain('Attempt 2');
    expect(rendered).toContain('abc1234');
    expect(rendered).toContain('All gates passed');
  });

  it('fences failing output so a test runner printing a heading cannot split the section', async () => {
    // The heading is assembled at runtime so the *command string* — which is
    // echoed into the section — does not itself contain `## `. Without that the
    // assertion below would find the echo and pass without proving anything.
    const heading = `${NODE} -e "process.stdout.write('#' + '# Acceptance Criteria\\n'); process.exitCode = 1"`;
    const results = await new ChildProcessGateRunner().run(
      dir,
      { tests: heading, lint: passes(''), build: passes('') },
      optionsFor(),
    );

    const rendered = renderGateResults(results, { attempt: 1 });
    expect(rendered, 'the failing output was not carried into the section at all').toContain(
      '## Acceptance Criteria',
    );

    // The property that matters is not "there is a fence somewhere" — it is that
    // the vault's own heading scan cannot see the gate output's heading. Asserted
    // with the real writer and the real scanner, on a real note body: a
    // `## Acceptance Criteria` that escaped the fence here would shadow the
    // ticket's own section and silently starve the QA recipe (Phase 7a's bug).
    const body = appendToSection('## Acceptance Criteria\n\nTHE REAL ONE\n', '## Gate Results', rendered);
    expect(sectionText(body, '## Acceptance Criteria')).toContain('THE REAL ONE');
    expect(sectionText(body, '## Gate Results')).toContain('## Acceptance Criteria');
  });
});

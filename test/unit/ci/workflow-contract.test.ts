/**
 * The contract between the CI workflows and the suite's paid-run switches.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Three test files gate their real-CLI probes on the same predicate:
 *
 *   const RUN_REAL_CLI =
 *     process.env['FACTORY_REAL_CLI'] === '1' ||
 *     (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== '0');
 *
 * GitHub Actions sets `CI=true` on every runner. So the *default* behaviour of
 * `npm test` on Actions is to spawn live Claude agents — which needs a CLI, a
 * credential and money. The per-push workflow therefore sets `CI: '0'`, the
 * escape hatch the predicate already documents, so the free suite runs and the
 * paid describes report SKIPPED by name.
 *
 * That arrangement is split across two files that nothing links together: the
 * YAML sets an environment variable, and the TypeScript decides what it means.
 * Either side can be edited alone, and both edits look harmless:
 *
 *   - Drop `CI: '0'` from the workflow, or add a step that re-exports `CI=true`,
 *     and every push starts spawning live agents.
 *   - "Simplify" the predicate to `process.env['CI'] !== undefined` and the
 *     `'0'` escape hatch disappears, with the same result.
 *   - Add `push:` to the fence workflow's triggers and every push pays for the
 *     sandbox probes.
 *
 * None of those is caught by anything else. The rest of the suite never runs
 * under CI's environment, so it cannot see any of it.
 *
 * ============================================================================
 * HOW IT CHECKS
 * ============================================================================
 * Not by grepping the YAML for strings this test already knows. It:
 *
 *   1. parses both workflow files with the real YAML parser;
 *   2. reconstructs the environment each *step* would actually see, starting
 *      from `CI=true` because that is what a GitHub runner always sets, then
 *      layering workflow env over it, then job env, then step env — the same
 *      precedence Actions uses;
 *   3. lifts the real predicate *expressions* out of the test sources, as text,
 *      and evaluates them against those environments.
 *
 * Step 3 is the point. It runs the actual code the probes are gated on, not a
 * copy of it, so a change to either side that breaks the agreement fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const INTEGRATION_DIR = path.join(REPO_ROOT, 'test', 'integration');

const CHECKS_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FENCE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'sandbox-fence.yml');

/** The job ids this contract is written against. Renaming one fails loudly here. */
const CHECKS_JOB = 'checks';
const FENCE_JOB = 'fence';

/**
 * What a GitHub-hosted runner sets before a single line of the workflow runs.
 * Modelling this is the whole reason the test is meaningful: with an empty base
 * environment, a workflow that forgot `CI: '0'` would still look correct.
 */
const RUNNER_BASE_ENV: Readonly<Record<string, string>> = { CI: 'true' };

/** The files whose paid describes must be off on every push. */
const PINNED_REAL_CLI_FILES = [
  'isolation.test.ts',
  'agents-real-cli.test.ts',
  'dev-loop-real-cli.test.ts',
] as const;

/**
 * Skips that are not a paid-run switch, declared here deliberately (see below).
 * Reads gitignored transcripts already on disk; skips when absent. Costs nothing.
 */
const FREE_CONDITIONAL_SKIPS = ['dashboard-transcript-real.test.ts'] as const;

// ---------------------------------------------------------------------------
// Workflow reading
// ---------------------------------------------------------------------------

interface Step {
  readonly name?: unknown;
  readonly uses?: unknown;
  readonly with?: unknown;
  readonly env?: unknown;
  readonly run?: unknown;
  readonly 'continue-on-error'?: unknown;
}

interface Job {
  readonly 'runs-on'?: unknown;
  readonly env?: unknown;
  readonly steps?: unknown;
  readonly 'continue-on-error'?: unknown;
}

interface Workflow {
  readonly on?: unknown;
  readonly env?: unknown;
  readonly jobs?: unknown;
}

function readWorkflow(file: string): Workflow {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} is missing. This contract test exists to keep the CI ` +
        `workflows and the suite's paid-run switches in agreement; without the workflow there is ` +
        `nothing to agree with.`,
    );
  }
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${path.relative(REPO_ROOT, file)} did not parse as a YAML mapping.`);
  }
  return parsed as Workflow;
}

function jobOf(workflow: Workflow, file: string, id: string): Job {
  const jobs = workflow.jobs;
  if (jobs === null || typeof jobs !== 'object') {
    throw new Error(`${path.relative(REPO_ROOT, file)} has no \`jobs:\` mapping.`);
  }
  const job = (jobs as Record<string, unknown>)[id];
  if (job === null || job === undefined || typeof job !== 'object') {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} has no job \`${id}\`. If it was renamed, update the ` +
        `job ids at the top of this test — do not delete the assertion.`,
    );
  }
  return job as Job;
}

function stepsOf(job: Job, label: string): readonly Step[] {
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new Error(`Job \`${label}\` has no steps.`);
  }
  return job.steps as readonly Step[];
}

/** Actions stringifies every env value, so this does too — `CI: false` becomes `"false"`. */
function envBlock(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') {
    throw new Error(`Expected an \`env:\` mapping, got ${typeof value}.`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    out[key] = String(raw);
  }
  return out;
}

/** Workflow env < job env < step env, over what the runner already set. */
function effectiveEnv(workflow: Workflow, job: Job, step: Step): Record<string, string> {
  return {
    ...RUNNER_BASE_ENV,
    ...envBlock(workflow.env),
    ...envBlock(job.env),
    ...envBlock(step.env),
  };
}

/** The workflow's trigger names, sorted, so a test can state the whole set. */
function triggersOf(workflow: Workflow, file: string): readonly string[] {
  const triggers = workflow.on;
  if (triggers === null || triggers === undefined || typeof triggers !== 'object') {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} has no \`on:\` mapping, or wrote it in a form this ` +
        `test cannot read (a bare string or a list). Both are legal YAML; neither is what the ` +
        `assertions below assume.`,
    );
  }
  return Object.keys(triggers as Record<string, unknown>).sort();
}

function describeStep(step: Step, index: number): string {
  return typeof step.name === 'string' ? `step ${index + 1} (${step.name})` : `step ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Predicate extraction and evaluation
// ---------------------------------------------------------------------------

interface Switch {
  /** File name inside `test/integration/`. */
  readonly file: string;
  /** e.g. `RUN_REAL_CLI`. */
  readonly name: string;
  /** The source text of the initialiser, verbatim. */
  readonly expression: string;
}

/**
 * Every `const RUN_REAL_* = <expr>;` declared by an integration test.
 *
 * Discovered rather than listed, so a fourth paid-run file added later is held
 * to the same contract without anyone remembering to add it here.
 */
function discoverSwitches(): readonly Switch[] {
  const found: Switch[] = [];
  for (const file of readdirSync(INTEGRATION_DIR).sort()) {
    if (!file.endsWith('.test.ts')) continue;
    const source = readFileSync(path.join(INTEGRATION_DIR, file), 'utf8');
    const pattern = /^const (RUN_REAL_[A-Z0-9_]+) =\s*([\s\S]*?);$/gm;
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match !== null) {
      found.push({ file, name: match[1]!, expression: match[2]!.trim() });
      match = pattern.exec(source);
    }
  }
  return found;
}

/**
 * Integration files that skip a describe conditionally.
 *
 * `discoverSwitches` reads a fairly specific declaration shape. For the three
 * pinned files a shape change fails loudly, because they are named explicitly.
 * A *new* paid file that writes `export const RUN_REAL_X`, or omits the
 * semicolon, would simply not be found — and nothing would say so, which is the
 * one case where nobody is looking.
 *
 * So the skips themselves are counted from the other end. `describe.skipIf` is
 * how every conditional suite in this repo is written; a file that has one and
 * no readable switch is a hole in this contract by definition.
 */
function filesWithConditionalSkips(): readonly string[] {
  const out: string[] = [];
  for (const file of readdirSync(INTEGRATION_DIR).sort()) {
    if (!file.endsWith('.test.ts')) continue;
    const source = readFileSync(path.join(INTEGRATION_DIR, file), 'utf8');
    if (source.includes('describe.skipIf(') || source.includes('it.skipIf(')) out.push(file);
  }
  return out;
}

/**
 * Shell text in a `run:` block that would put CI back on.
 *
 * `effectiveEnv` only models YAML `env:` blocks, so the rule written at the top
 * of ci.yml — "do not let a step re-export CI=true" — was a comment and nothing
 * more. Both of these defeat the opt-out and neither touches an `env:` key:
 *
 *   run: echo "CI=true" >> "$GITHUB_ENV"
 *   run: CI=true npm test
 *
 * This is a text match, so it is not airtight: `export ${VAR}=true`, a value
 * read from a file, or a composite action that writes GITHUB_ENV all slip past.
 * It closes the two forms someone would actually reach for, and it turns a
 * comment into something that fails.
 */
const CI_REEXPORT = /(^|[\s;&|(])CI\s*=|GITHUB_ENV/;

/**
 * Run the extracted expression against a synthetic `process`.
 *
 * Deliberately evaluating the real source text: a re-implementation here would
 * agree with itself forever and prove nothing about the code that actually
 * gates the probes.
 */
function evaluate(entry: Switch, env: Record<string, string>): boolean {
  const compiled = new Function('process', `"use strict"; return (${entry.expression});`) as (
    fakeProcess: { env: Record<string, string> },
  ) => unknown;
  const result = compiled({ env });
  if (typeof result !== 'boolean') {
    throw new Error(
      `${entry.file}: ${entry.name} evaluated to ${typeof result}, not a boolean. ` +
        `\`describe.skipIf\` treats anything truthy as "run the paid case", so a non-boolean ` +
        `here is a hazard in its own right.`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------

describe('the CI workflows and the suite’s paid-run switches', () => {
  const switches = discoverSwitches();

  it('finds a paid-run switch in every file that has one', () => {
    const files = new Set(switches.map((entry) => entry.file));
    for (const file of PINNED_REAL_CLI_FILES) {
      expect(
        files.has(file),
        `No \`const RUN_REAL_… = …;\` found in test/integration/${file}. Either the probe gate ` +
          `was renamed or reformatted out of reach of this test — in which case fix the reader ` +
          `below — or the gate is gone, in which case the probes are no longer opt-in at all.`,
      ).toBe(true);
    }
    expect(files.has('pipeline-real.test.ts')).toBe(true);
  });

  it('no integration file skips a suite through a switch this test cannot read', () => {
    const discovered = new Set(switches.map((entry) => entry.file));
    const skipping = filesWithConditionalSkips();
    expect(
      skipping.length,
      'No integration file uses describe.skipIf at all any more, which would mean the paid ' +
        'suites are no longer opt-in. That is not a reader bug; go and look.',
    ).toBeGreaterThanOrEqual(PINNED_REAL_CLI_FILES.length + 1);
    for (const file of skipping) {
      if ((FREE_CONDITIONAL_SKIPS as readonly string[]).includes(file)) continue;
      expect(
        discovered.has(file),
        `test/integration/${file} skips a suite conditionally, but no \`RUN_REAL_… = …;\` in ` +
          `it was readable by discoverSwitches(). Every assertion below silently ignores this ` +
          `file, so whatever it gates — money, a live agent, a credential — is unchecked on ` +
          `every push. Either name its switch RUN_REAL_* in the declaration shape this test ` +
          `reads, or, if the skip genuinely costs nothing, say so here deliberately.`,
      ).toBe(true);
    }
  });

  it('the three pinned files gate their probes on one and the same expression', () => {
    const realCli = switches.filter(
      (entry) =>
        entry.name === 'RUN_REAL_CLI' &&
        (PINNED_REAL_CLI_FILES as readonly string[]).includes(entry.file),
    );
    expect(realCli).toHaveLength(PINNED_REAL_CLI_FILES.length);
    const distinct = new Set(realCli.map((entry) => entry.expression));
    expect(
      distinct.size,
      `The three real-CLI files no longer agree on when a probe run is wanted:\n` +
        realCli.map((entry) => `  ${entry.file}: ${entry.expression}`).join('\n') +
        `\nThree copies drifting apart is the same hazard test/helpers/cliVersion.ts exists to ` +
        `prevent for the version pin: one file gets fixed, the others keep their own answer.`,
    ).toBe(1);
  });

  describe('the per-push workflow', () => {
    const workflow = readWorkflow(CHECKS_WORKFLOW);
    const job = jobOf(workflow, CHECKS_WORKFLOW, CHECKS_JOB);

    it('leaves every paid switch off, even though Actions sets CI=true', () => {
      for (const [index, step] of stepsOf(job, CHECKS_JOB).entries()) {
        const env = effectiveEnv(workflow, job, step);
        for (const entry of switches) {
          expect(
            evaluate(entry, env),
            `${describeStep(step, index)} of job \`${CHECKS_JOB}\` would run with ` +
              `${JSON.stringify(env)}, and ${entry.file}'s ${entry.name} is true there. ` +
              `A push would spawn live agents: it needs the Claude CLI and a credential the ` +
              `job does not have, and on a machine that does have them it costs money. ` +
              `The documented opt-out is CI=0.`,
          ).toBe(false);
        }
      }
    });

    it('runs on exactly the triggers it was designed for', () => {
      expect(triggersOf(workflow, CHECKS_WORKFLOW)).toEqual(['pull_request', 'push']);
    });

    it('cannot be made green while the suite is red', () => {
      expect(
        job['continue-on-error'],
        `Job \`${CHECKS_JOB}\` sets continue-on-error. A job that reports success whatever the ` +
          `tests did is worse than no job: it is a green tick that means nothing, on the one ` +
          `check standing between a CLI upgrade and ADR-003.`,
      ).toBeFalsy();

      const steps = stepsOf(job, CHECKS_JOB);
      for (const [index, step] of steps.entries()) {
        expect(
          step['continue-on-error'],
          `${describeStep(step, index)} of job \`${CHECKS_JOB}\` sets continue-on-error. ` +
            `One line, and the pipeline is permanently green with a failing suite.`,
        ).toBeFalsy();
      }

      const testSteps = steps.filter(
        (step) => typeof step.run === 'string' && step.run.trim() === 'npm test',
      );
      expect(
        testSteps.length,
        `Exactly one step of \`${CHECKS_JOB}\` should run \`npm test\` and nothing else. ` +
          `A narrowed invocation — a file list, a \`-t\` filter, \`--passWithNoTests\` — is how ` +
          `a suite stops covering what everyone assumes it covers, and it reads as harmless in ` +
          `a diff. Steps found running the suite: ` +
          JSON.stringify(
            steps
              .filter((step) => typeof step.run === 'string' && /vitest|npm test/.test(step.run))
              .map((step) => step.run),
          ),
      ).toBe(1);
    });

    it('never puts CI back on from inside a shell step', () => {
      for (const [index, step] of stepsOf(job, CHECKS_JOB).entries()) {
        if (typeof step.run !== 'string') continue;
        expect(
          CI_REEXPORT.test(step.run),
          `${describeStep(step, index)} of job \`${CHECKS_JOB}\` assigns CI or writes to ` +
            `GITHUB_ENV inside its script. The job-level \`CI: '0'\` is what keeps every push ` +
            `off live agents, and a shell line beats it without touching an \`env:\` block ` +
            `anywhere a reviewer would look.`,
        ).toBe(false);
      }
    });
  });

  describe('the sandbox-fence workflow', () => {
    const workflow = readWorkflow(FENCE_WORKFLOW);
    const job = jobOf(workflow, FENCE_WORKFLOW, FENCE_JOB);
    const steps = stepsOf(job, FENCE_JOB);

    it('actually turns the real-CLI probes on somewhere', () => {
      const runsProbes = steps.some((step) => {
        const env = effectiveEnv(workflow, job, step);
        return switches
          .filter(
            (entry) =>
              entry.name === 'RUN_REAL_CLI' &&
              (PINNED_REAL_CLI_FILES as readonly string[]).includes(entry.file),
          )
          .every((entry) => evaluate(entry, env));
      });
      expect(
        runsProbes,
        `No step in job \`${FENCE_JOB}\` has an environment that makes RUN_REAL_CLI true in all ` +
          `three pinned files. The whole point of this workflow is that something re-runs the ` +
          `sandbox probes after a CLI upgrade; a job that skips them is a green tick for nothing.`,
      ).toBe(true);
    });

    it('does not also start the $5–15 real-pipeline run', () => {
      for (const [index, step] of steps.entries()) {
        const env = effectiveEnv(workflow, job, step);
        for (const entry of switches.filter((candidate) => candidate.name === 'RUN_REAL_PIPELINE')) {
          expect(
            evaluate(entry, env),
            `${describeStep(step, index)} of job \`${FENCE_JOB}\` would also trigger ` +
              `${entry.file}'s ${entry.name}. The fence probes cost cents; the pipeline run ` +
              `costs dollars and is not what this schedule is for.`,
          ).toBe(false);
        }
      }
    });

    it('runs on exactly two triggers, and they are the two that were costed', () => {
      expect(
        triggersOf(workflow, FENCE_WORKFLOW),
        `An allowlist, not a denylist, because the dangerous triggers are the ones nobody ` +
          `thinks to ban. This job holds ANTHROPIC_API_KEY: \`pull_request_target\` would hand ` +
          `that secret to code from a fork, and \`issue_comment\`, \`repository_dispatch\` and ` +
          `\`workflow_call\` all let someone else decide when to spend. Every addition here ` +
          `must be a deliberate one.`,
      ).toEqual(['schedule', 'workflow_dispatch']);
    });

    it('runs on macOS, the only platform ADR-003 has evidence for', () => {
      const runsOn = job['runs-on'];
      expect(
        typeof runsOn === 'string' && runsOn.startsWith('macos-'),
        `Job \`${FENCE_JOB}\` runs on ${JSON.stringify(runsOn)}. Every probe behind ADR-003 has ` +
          `been run against macOS Seatbelt, at CLI 2.1.220, 2.1.258 and 2.1.276. A green run on ` +
          `another platform would be read as evidence for a sandbox nobody has ever probed, ` +
          `which is worse than no run at all. Probe Linux deliberately and record it before ` +
          `changing this.`,
      ).toBe(true);
    });
  });

  it('both workflows run the Node version package.json says the project needs', () => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const declared = (manifest as { engines?: { node?: unknown } }).engines?.node;
    expect(typeof declared).toBe('string');
    const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(declared as string);
    expect(
      minimum,
      `package.json engines.node is ${JSON.stringify(declared)}; this test only understands a ` +
        `\`>=x.y.z\` floor.`,
    ).not.toBeNull();
    const floor = [minimum![1]!, minimum![2]!, minimum![3]!].map(Number) as [
      number,
      number,
      number,
    ];

    let checked = 0;
    for (const file of [CHECKS_WORKFLOW, FENCE_WORKFLOW]) {
      const workflow = readWorkflow(file);
      const jobs = workflow.jobs as Record<string, Job>;
      for (const [jobId, job] of Object.entries(jobs)) {
        for (const [index, step] of stepsOf(job, jobId).entries()) {
          if (typeof step.uses !== 'string' || !step.uses.startsWith('actions/setup-node')) continue;
          const version = (step.with as { 'node-version'?: unknown } | undefined)?.['node-version'];
          expect(
            typeof version === 'string',
            `${describeStep(step, index)} of \`${jobId}\` pins no node-version.`,
          ).toBe(true);
          const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
          expect(
            parts,
            `${describeStep(step, index)} of \`${jobId}\` uses node-version ` +
              `${JSON.stringify(version)}; pin an exact x.y.z so CI and engines cannot drift ` +
              `apart unnoticed.`,
          ).not.toBeNull();
          const got = [parts![1]!, parts![2]!, parts![3]!].map(Number) as [number, number, number];
          const ok =
            got[0] > floor[0] ||
            (got[0] === floor[0] && (got[1] > floor[1] || (got[1] === floor[1] && got[2] >= floor[2])));
          expect(
            ok,
            `${describeStep(step, index)} of \`${jobId}\` runs Node ${String(version)}, below the ` +
              `${String(declared)} the package declares. CI would be testing a runtime the project ` +
              `does not claim to support.`,
          ).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked, 'Neither workflow sets up Node at all.').toBeGreaterThanOrEqual(2);
  });
});

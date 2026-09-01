/**
 * The attempt policy (plan Phase 7b, `src/orchestrator/attempts.ts`).
 *
 * ============================================================================
 * WHY HALF OF THIS FILE DRIVES A REAL DISPATCH
 * ============================================================================
 * `classifyFailure` is a pure function and its four cases are cheap to assert
 * directly. That is not enough. The rule the plan actually states is about what
 * lands on the note — "a first schema failure ... leaves `attempts` unchanged"
 * — and `attempts` is written by `dispatch.ts`, not by the policy. A policy
 * that returned the right disposition into a dispatcher that ignored it would
 * pass every pure test in this file.
 *
 * So the dispatch cases below run a real `Orchestrator` cycle against a real
 * vault on disk, with a scripted `Runner`, and read `attempts` back out of the
 * markdown. The scripted runner is deliberately **not** `MockRunner`: the
 * retry happens inside one dispatch, so the second run needs a different
 * payload from the first, and `MockRunner`'s fixture map is resolved per run
 * from keys a test cannot change mid-dispatch.
 *
 * ============================================================================
 * THE MALFORMED PAYLOAD IS MALFORMED IN A REALISTIC WAY
 * ============================================================================
 * `badPmPayload` is a **near miss**, not junk: every field is present and one
 * array is returned as a string. That is the failure this rule exists for — an
 * agent that did the work and got the shape slightly wrong. A payload of `null`
 * would exercise the same code path while proving nothing about whether the
 * rule is aimed at anything real.
 */
import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateAgentOutput } from '../../../src/agents/schemas.js';
import { MemoryEventLog } from '../../../src/log/events.js';
import {
  classifyFailure,
  describeAttemptFailure,
  failureConsumesAttempt,
  FREE_SCHEMA_RETRIES,
  pauseReasonForFailure,
  schemaRetryGuidance,
} from '../../../src/orchestrator/attempts.js';
import { payloadChars } from '../../../src/orchestrator/dispatch.js';
import { Orchestrator } from '../../../src/orchestrator/loop.js';
import type { AgentRunResult, AgentRunSpec, Runner } from '../../../src/runner/types.js';
import { makeFeature } from '../../helpers/notes.js';
import {
  factoryVault,
  pmPayload,
  readNoteFile,
} from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const SLUG = 'sample';
const FEATURE_ID = 'FEAT-SAMPLE';

let vault: FactoryFixture;
let events: MemoryEventLog;
let clockMs: number;

function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

// ---------------------------------------------------------------------------
// The pure policy.
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('forgives a first schema failure and asks for a retry in place', () => {
    const disposition = classifyFailure({
      failure: 'schema',
      role: 'pm',
      schemaFailuresForgiven: 0,
      issues: ['scope_in: Invalid input: expected array, received string'],
    });

    expect(disposition.kind).toBe('retry_in_place');
  });

  it('puts the validator’s exact words into the retry guidance', () => {
    const disposition = classifyFailure({
      failure: 'schema',
      role: 'pm',
      schemaFailuresForgiven: 0,
      issues: ['scope_in: Invalid input: expected array, received string'],
    });

    expect(disposition.kind === 'retry_in_place' ? disposition.guidance : '').toContain(
      'scope_in: Invalid input: expected array, received string',
    );
  });

  it('charges a second consecutive schema failure', () => {
    // Anchored to a literal, not only to the constant. Written purely as
    // `schemaFailuresForgiven: FREE_SCHEMA_RETRIES`, this case survives raising
    // the constant to any value — the comparison moves with it — so it would go
    // green for a build that had made the retry effectively unlimited. Pinning
    // the constant is what makes the row below mean "the second one costs you".
    expect(FREE_SCHEMA_RETRIES, 'one free retry per dispatch, per plan Phase 7b').toBe(1);
    expect(
      classifyFailure({
        failure: 'schema',
        role: 'pm',
        schemaFailuresForgiven: 1,
        issues: ['still wrong'],
      }).kind,
    ).toBe('consume');
  });

  it('charges every other failure kind on its first occurrence', () => {
    for (const failure of ['timeout', 'crash', 'api_error'] as const) {
      expect(
        classifyFailure({ failure, role: 'pm', schemaFailuresForgiven: 0 }).kind,
        `${failure} was not charged`,
      ).toBe('consume');
    }
  });

  it('a non-schema failure after a forgiven schema one is still charged exactly once', () => {
    // The plan's "a schema failure followed by a gate failure counts as one
    // attempt, not two". Gates are Phase 9, so the second failure stands in as
    // any charged kind: the property under test is that the forgiven schema
    // failure adds nothing to it.
    const first = classifyFailure({
      failure: 'schema',
      role: 'dl',
      schemaFailuresForgiven: 0,
      issues: ['tickets: expected array'],
    });
    const second = classifyFailure({ failure: 'crash', role: 'dl', schemaFailuresForgiven: 1 });

    expect(first.kind).toBe('retry_in_place');
    expect(second.kind).toBe('consume');
    expect([first, second].filter((entry) => entry.kind === 'consume')).toHaveLength(1);
  });

  it('forgives an abort outright, with no retry — that is Phase 7a’s rule, unchanged', () => {
    expect(classifyFailure({ failure: 'aborted', role: 'pm', schemaFailuresForgiven: 0 }).kind).toBe(
      'forgive',
    );
  });
});

describe('failureConsumesAttempt and pauseReasonForFailure', () => {
  it('charge everything but an abort', () => {
    expect(failureConsumesAttempt('aborted')).toBe(false);
    for (const failure of ['timeout', 'crash', 'api_error', 'schema'] as const) {
      expect(failureConsumesAttempt(failure), failure).toBe(true);
    }
  });

  it('map a schema failure to malformed_output', () => {
    expect(pauseReasonForFailure('schema')).toBe('malformed_output');
    expect(pauseReasonForFailure('timeout')).toBe('timeout');
    expect(pauseReasonForFailure('crash')).toBe('attempts_exhausted');
  });
});

/**
 * Phase 9's additions to the policy (plan Phase 9, spec §9.1).
 *
 * The four new kinds are not agent-run failures — a red gate is a run that
 * succeeded and produced code that does not work, and a `request_changes` is an
 * agent doing its job correctly. They still cost an attempt, and what a human
 * eventually reads in `pause_detail` is derived from them, so the mapping is
 * pinned here rather than left to whatever the switch happens to do.
 */
describe('the Phase 9 failure kinds', () => {
  const PHASE_9 = ['gate', 'review_changes', 'qa_fail', 'no_changes', 'commit_failed'] as const;

  it('all cost an attempt', () => {
    for (const failure of PHASE_9) {
      expect(failureConsumesAttempt(failure), failure).toBe(true);
    }
  });

  it('all park an exhausted ticket as attempts_exhausted', () => {
    for (const failure of PHASE_9) {
      expect(pauseReasonForFailure(failure), failure).toBe('attempts_exhausted');
    }
  });

  it('each has a description a human can read, and no two share one', () => {
    // The `pause_detail` a stuck ticket carries begins with this text. "the
    // ticket failed 3 time(s) (qa_fail)" is a log line, not a sentence, and it
    // is the first thing an operator sees in NEEDS_HUMAN.md.
    const described = PHASE_9.map((failure) => describeAttemptFailure(failure));
    for (const [index, text] of described.entries()) {
      expect(text, PHASE_9[index]).not.toContain('_');
      expect(text.length).toBeGreaterThan(10);
    }
    expect(new Set(described).size).toBe(described.length);
  });

  it('every AgentFailure still has a description too', () => {
    for (const failure of ['timeout', 'aborted', 'crash', 'schema', 'api_error'] as const) {
      expect(describeAttemptFailure(failure).length, failure).toBeGreaterThan(10);
    }
  });

  it('none of them buys a free retry — only a schema failure does', () => {
    // `classifyFailure`'s forgiveness rule is about a payload that missed its
    // shape. A red gate is not a near miss and must not be re-run for free:
    // that would double every ticket's gate budget silently.
    for (const failure of PHASE_9) {
      expect(
        classifyFailure({
          failure: failure as never,
          role: 'developer',
          schemaFailuresForgiven: 0,
        }).kind,
        failure,
      ).toBe('consume');
    }
  });
});

describe('schemaRetryGuidance', () => {
  it('tells the agent nothing was recorded, so it returns the whole payload again', () => {
    const guidance = schemaRetryGuidance('dl', ['tickets: expected array']);
    expect(guidance).toContain('nothing you returned was');
    expect(guidance).toContain('whole payload again');
  });

  it('names the role whose contract was missed', () => {
    expect(schemaRetryGuidance('tl_plan', ['x'])).toContain('tl_plan');
  });

  it('still produces usable text when the validator reported no detail', () => {
    const guidance = schemaRetryGuidance('pm', []);
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance).toContain('every required field');
  });
});

// ---------------------------------------------------------------------------
// The rule as it lands on the note.
// ---------------------------------------------------------------------------

/**
 * A `pm` payload that is one field-type away from valid.
 *
 * Asserted invalid at construction time. A "malformed" fixture that quietly
 * validated would make every retry assertion below pass for the wrong reason.
 */
function badPmPayload(): Record<string, unknown> {
  const payload = { ...pmPayload(), scope_in: 'subtract in src/calc.ts' };
  const check = validateAgentOutput('pm', payload);
  if (check.ok) {
    throw new Error('badPmPayload validated — the schema-retry tests would prove nothing');
  }
  return payload;
}

interface ScriptedRun {
  readonly structured?: unknown;
  readonly failure?: AgentRunResult['failure'];
  readonly schemaIssues?: readonly string[];
  readonly costUsd?: number;
}

/** A `Runner` that returns a fixed sequence, one entry per call. */
function scripted(script: readonly ScriptedRun[]): Runner & { calls: AgentRunSpec[] } {
  const calls: AgentRunSpec[] = [];
  return {
    calls,
    run(spec: AgentRunSpec): Promise<AgentRunResult> {
      const step = script[calls.length];
      calls.push(spec);
      if (step === undefined) {
        throw new Error(
          `the scripted runner ran out after ${calls.length} calls — the dispatcher made more ` +
            'runs than this test expected, which is itself the thing worth knowing',
        );
      }
      const failed = step.failure !== undefined;
      return Promise.resolve({
        ok: !failed,
        structured: failed ? null : (step.structured ?? null),
        costUsd: step.costUsd ?? 0.1,
        numTurns: 1,
        durationMs: 1,
        sessionId: 'scripted',
        terminalReason: failed ? String(step.failure) : 'completed',
        permissionDenials: [],
        ...(step.failure === undefined ? {} : { failure: step.failure }),
        ...(step.schemaIssues === undefined ? {} : { schemaIssues: [...step.schemaIssues] }),
      });
    },
  };
}

/** A feature already at `refining`, so one cycle is exactly one `pm` dispatch. */
async function refiningFeature(): Promise<string> {
  const file = vault.paths.featureNote(SLUG);
  mkdirSync(vault.paths.featureDir(SLUG), { recursive: true });
  await vault.storage.writeNote(
    file,
    makeFeature({ id: FEATURE_ID, slug: SLUG, status: 'refining' }, '## Raw Requirement\n\nAdd subtract.\n'),
  );
  return file;
}

async function runOneCycle(runner: Runner): Promise<void> {
  const instance = await Orchestrator.start({
    paths: vault.paths,
    config: vault.config,
    storage: vault.storage,
    runner,
    events,
    now,
    isAlive: () => true,
  });
  await instance.run({ maxCycles: 1, sleep: async () => undefined });
  await instance.shutdown();
}

beforeEach(() => {
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
  events = new MemoryEventLog(now);
  vault = factoryVault();
});

afterEach(() => {
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('a first schema failure, through a real dispatch', () => {
  it('re-runs the agent and leaves attempts unchanged', async () => {
    const file = await refiningFeature();
    const runner = scripted([{ structured: badPmPayload() }, { structured: pmPayload() }]);

    await runOneCycle(runner);

    expect(runner.calls.map((call) => call.role)).toEqual(['pm', 'pm']);
    const note = readNoteFile(file);
    expect(note.frontmatter.attempts, 'the free retry charged an attempt').toBe(0);
    // ...and the retry's output was applied, so the free run was not merely free
    // but useful.
    expect(note.frontmatter.status).toBe('needs_human');
    expect(note.frontmatter.resume_to).toBe('planning');
  });

  it('puts the specific validation error into the retry’s prompt', async () => {
    await refiningFeature();
    const runner = scripted([{ structured: badPmPayload() }, { structured: pmPayload() }]);

    await runOneCycle(runner);

    const retry = runner.calls[1];
    expect(retry, 'there was no second run to inspect').toBeDefined();
    // The exact complaint zod produced for `scope_in`, not a paraphrase of it.
    const issue = validateAgentOutput('pm', badPmPayload());
    const detail = issue.ok ? '' : (issue.issues[0] ?? '');
    expect(detail.length).toBeGreaterThan(0);
    expect(retry?.prompt).toContain(detail);
    // And the first run did not carry it — otherwise the assertion above would
    // hold for a dispatcher that injected the guidance unconditionally.
    expect(runner.calls[0]?.prompt).not.toContain(detail);
  });

  it('writes the free run’s cost to the note — forgiven of attempts, not of money', async () => {
    const file = await refiningFeature();
    const runner = scripted([
      { structured: badPmPayload(), costUsd: 0.28 },
      { structured: pmPayload(), costUsd: 0.31 },
    ]);

    await runOneCycle(runner);

    expect(readNoteFile(file).frontmatter.cost_usd).toBeCloseTo(0.59, 6);
  });

  it('keeps the malformed run’s transcript instead of overwriting it', async () => {
    await refiningFeature();
    const runner = scripted([{ structured: badPmPayload() }, { structured: pmPayload() }]);

    await runOneCycle(runner);

    const [first, second] = runner.calls;
    expect(first?.transcriptPath).not.toBe(second?.transcriptPath);
    expect(second?.transcriptPath).toContain('schema-retry1');
  });

  it('records a schema_retry event carrying the issues and the cost', async () => {
    await refiningFeature();
    await runOneCycle(scripted([{ structured: badPmPayload(), costUsd: 0.2 }, { structured: pmPayload() }]));

    const retries = events.ofType('schema_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.role).toBe('pm');
    expect(retries[0]?.costUsd).toBe(0.2);
    expect(retries[0]?.issues.join(' ')).toContain('scope_in');
  });

  it('applies to a runner that reports the failure itself, not only to one we catch', async () => {
    // `ClaudeCodeRunner` validates in-process and returns `failure: 'schema'`;
    // `MockRunner` does not validate at all, so its bad payload arrives as a
    // successful run. Both must buy the same retry, or the rule is real against
    // the real CLI and absent in every mock test.
    const file = await refiningFeature();
    const runner = scripted([
      { failure: 'schema', schemaIssues: ['scope_in: expected array, received string'] },
      { structured: pmPayload() },
    ]);

    await runOneCycle(runner);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.prompt).toContain('scope_in: expected array, received string');
    expect(readNoteFile(file).frontmatter.attempts).toBe(0);
  });
});

describe('a forgiven run that is then cancelled', () => {
  it('still records what the forgiven run cost', async () => {
    // Forgiven of attempts, not of money. A schema failure buys a free re-run;
    // if the orchestrator is cancelled before that re-run lands, the first
    // run's cost is still real and still has to reach the note. Before this was
    // fixed the abort path returned without writing and the money vanished.
    const file = await refiningFeature();
    const controller = new AbortController();
    const runner = scripted([
      { structured: badPmPayload(), costUsd: 0.42 },
      { failure: 'aborted', costUsd: 0 },
    ]);

    const instance = await Orchestrator.start({
      paths: vault.paths,
      config: vault.config,
      storage: vault.storage,
      runner,
      events,
      now,
      isAlive: () => true,
      signal: controller.signal,
    });
    await instance.run({ maxCycles: 1, sleep: async () => undefined });
    await instance.shutdown();

    const note = readNoteFile(file);
    expect(note.frontmatter.cost_usd, 'the forgiven run’s cost was dropped').toBeCloseTo(0.42, 6);
    // Still forgiven: no attempt charged, and the item is where it started.
    expect(note.frontmatter.attempts).toBe(0);
    expect(note.frontmatter.status).toBe('refining');
  });

  it('writes nothing at all when there is no carried cost', async () => {
    // The ordinary abort. Nothing was forgiven, so nothing needs recording, and
    // the cheapness of that path is the reason `factory stop` is safe to use.
    const file = await refiningFeature();
    const before = readNoteFile(file);

    await runOneCycle(scripted([{ failure: 'aborted', costUsd: 0 }]));

    const after = readNoteFile(file);
    expect(after.frontmatter.cost_usd).toBe(before.frontmatter.cost_usd);
    expect(after.frontmatter.updated_at).toBe(before.frontmatter.updated_at);
  });
});

describe('the payload-size warning', () => {
  it('stays quiet for a payload under the limit', async () => {
    await refiningFeature();
    await runOneCycle(scripted([{ structured: pmPayload() }]));
    expect(events.ofType('payload_large')).toEqual([]);
  });

  it('warns once, with the real size, for a payload over it', async () => {
    // The threshold is lowered rather than the payload inflated to 15k: a
    // fixture that large would dominate the file and prove nothing extra. What
    // is under test is that the configured number is the one consulted.
    vault = factoryVault({ config: { payload_warn_chars: 200 } });
    const file = await refiningFeature();
    const payload = pmPayload();

    await runOneCycle(scripted([{ structured: payload }]));

    const warnings = events.ofType('payload_large');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.role).toBe('pm');
    expect(warnings[0]?.limitChars).toBe(200);
    expect(warnings[0]?.chars).toBe(payloadChars(payload));
    // It is a warning, not a refusal: the payload was still applied.
    expect(readNoteFile(file).frontmatter.status).toBe('needs_human');
    expect(readNoteFile(file).frontmatter.resume_to).toBe('planning');
  });

  it('measures the JSON the CLI actually had to carry, not the field text', () => {
    // Counting the markdown fields alone understates the payload by the JSON
    // escaping and structure, which is the thing that has to fit.
    const payload = pmPayload({ notes_markdown: 'a "quoted" line\nand another' });
    const fieldsOnly = String(payload['notes_markdown']).length;
    expect(payloadChars(payload)).toBeGreaterThan(fieldsOnly);
  });

  it('never throws on a payload that cannot be stringified', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => payloadChars(cyclic)).not.toThrow();
  });
});

describe('a second consecutive schema failure, through a real dispatch', () => {
  it('increments attempts exactly once for the pair of runs', async () => {
    const file = await refiningFeature();
    const runner = scripted([{ structured: badPmPayload() }, { structured: badPmPayload() }]);

    await runOneCycle(runner);

    expect(runner.calls, 'a third run happened — the retry is not capped at one').toHaveLength(2);
    const note = readNoteFile(file);
    expect(note.frontmatter.attempts).toBe(1);
    // Still `refining`: one attempt of three, so the next cycle retries rather
    // than pausing.
    expect(note.frontmatter.status).toBe('refining');
  });

  it('charges one attempt when the retry fails some other way', async () => {
    // The shape of the plan's "schema failure followed by a gate failure counts
    // as one attempt, not two", using the failure kinds this phase has.
    const file = await refiningFeature();
    const runner = scripted([{ structured: badPmPayload() }, { failure: 'crash' }]);

    await runOneCycle(runner);

    expect(readNoteFile(file).frontmatter.attempts).toBe(1);
  });

  it('pauses at the attempt limit having spent two runs per attempt, not one', async () => {
    const file = await refiningFeature();
    // `max_attempts` is 3, and every attempt burns its free retry: six runs.
    const runner = scripted(Array.from({ length: 6 }, () => ({ structured: badPmPayload() })));

    await runOneCycle(runner);
    await runOneCycle(runner);
    await runOneCycle(runner);

    expect(runner.calls).toHaveLength(6);
    const note = readNoteFile(file);
    expect(note.frontmatter.attempts).toBe(3);
    expect(note.frontmatter.status).toBe('needs_human');
    expect(note.frontmatter.pause_reason).toBe('malformed_output');
  });
});

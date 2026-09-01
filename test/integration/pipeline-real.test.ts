/**
 * The M2 pipeline on **real** PM, TL and DL agents (plan Phase 7b).
 *
 * ============================================================================
 * THIS IS THE ONLY TEST IN THE PROJECT THAT SPENDS REAL MONEY ON A PIPELINE
 * ============================================================================
 * One full sequence cost **$1.34** at `claude-sonnet-5` when Phase 6 measured
 * it, and about eight minutes of wall clock. So it is behind its own switch,
 * `FACTORY_REAL_PIPELINE=1`, and **not** behind `FACTORY_REAL_CLI` — that one is
 * on for every `npm run test:all`, which costs about $0.064 today, and folding a
 * $1.34 pipeline into it would make the standard paid suite twenty times more
 * expensive without anybody choosing that.
 *
 *   FACTORY_REAL_PIPELINE=1 npx vitest run test/integration/pipeline-real.test.ts
 *   FACTORY_REAL_PIPELINE=1 FACTORY_REAL_PIPELINE_RUNS=3 npx vitest run …
 *
 * The free checks below always run: they exercise the self-containment checker
 * against a payload recorded from a real DL, which is what keeps the checker
 * itself honest between paid runs.
 *
 * ============================================================================
 * WHAT A PASS HERE MEANS, AND WHAT IT DOES NOT
 * ============================================================================
 * A pass means the pipeline reached `in_development` with a resolvable ticket
 * DAG. It does **not** mean the tickets are good. The check that matters most —
 * "could a Developer agent, holding only this ticket, actually build it" — is
 * partly structural (`findSelfContainmentProblems`) and partly a human read of
 * the real `buildContext` output. Plan Phase 7b is explicit that this is the
 * failure that poisons Phase 9 silently, and that a green run here is not
 * evidence against it.
 *
 * ============================================================================
 * FLAKINESS HERE IS A PROMPT DEFECT — WITH ONE MEASURED EXCEPTION
 * ============================================================================
 * Plan Phase 7b: "Flakiness here is a prompt defect, not test flake, and must be
 * fixed rather than retried." That is the default and it still holds: if the
 * breakdown is wrong, the fix is an edit to `prompts/*.md`, and the count of
 * consecutive clean runs restarts at zero. Re-running until it passes proves
 * nothing except that the sample was small.
 *
 * The exception, established by measurement across fourteen real sequences and
 * written up in the plan's "Phase 7b measurement results": a failed
 * `StructuredOutput` **delivery** is not a prompt defect. The CLI mangles the
 * payload at a parameter boundary — the tickets array arrives glued onto the end
 * of the previous string field — and it does so at 2,145 characters as readily
 * as at 14,000. No prompt edit changes that. The orchestrator charges an
 * attempt, retries the next cycle, and succeeds.
 *
 * So the assertions below are set from the observed distribution rather than
 * from an idea of what a clean run ought to look like, and the two numbers that
 * do **not** predict failure — payload size and `StructuredOutput` call count —
 * warn rather than fail. A guard that fires on correct runs is a guard the next
 * person turns off.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildContext, recipeFor, SECTION } from '../../src/agents/context.js';
import { validateAgentOutput } from '../../src/agents/schemas.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { realWorktrees } from '../../src/cli/deps.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { runStart } from '../../src/cli/start.js';
import { buildProgram } from '../../src/cli/main.js';
import { detectCycles, resolveActionable } from '../../src/domain/dag.js';
import { sectionText } from '../../src/domain/markdown.js';
import { vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import type { FeatureFrontmatter, TicketNote } from '../../src/domain/types.js';
import { factoryVault } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  describeSelfContainmentProblems,
  findSelfContainmentProblems,
} from '../helpers/ticketSelfContainment.js';
import type { TicketLike } from '../helpers/ticketSelfContainment.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  scratchDir,
  scratchFactoryHome,
  testRepoRoot,
} from '../helpers/toyRepo.js';
import { rmSync } from 'node:fs';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };
const SLUG = 'evaluate';
const FEATURE_ID = 'FEAT-EVALUATE';

const RUN_REAL_PIPELINE = process.env['FACTORY_REAL_PIPELINE'] === '1';
/** Survives `afterAll`. See `keepTranscripts`. */
const TRANSCRIPT_KEEP = path.join(testRepoRoot(), 'pipeline-real-logs');
const RUNS = Number.parseInt(process.env['FACTORY_REAL_PIPELINE_RUNS'] ?? '1', 10);

/**
 * The DL payload size at which the trim is considered to have regressed.
 *
 * Distinct from `config.payload_warn_chars`, which is a warning an operator
 * sees in the log. This is the test's hard bar, set above every payload this
 * pipeline has ever had accepted (14,471) and below the pre-trim band it was
 * moved out of (~18,700). See the note at its use.
 */
const PAYLOAD_REGRESSION_CHARS = 16_000;

/**
 * The requirement.
 *
 * ============================================================================
 * WHY THIS IS NOT PHASE 6'S REQUIREMENT
 * ============================================================================
 * Phase 6 measured $1.34 against "add `evaluate()` with precedence, parentheses,
 * error types and a CLI", and the first Phase 7b run reused it for cost
 * comparability. That run **found the requirement to be the wrong size**, which
 * is worth recording because it is not a prompt defect and no prompt edit fixes
 * it.
 *
 * Under any competent design that ask has exactly two parts: a parser, and a CLI
 * that imports the parser. It is a two-ticket, strictly sequential feature. The
 * Tech Lead in that run reused `DivideByZeroError` from `src/calc.ts` instead of
 * creating an error module — a good engineering call that removes the last
 * candidate for independent work. So plan Phase 7b's done condition, "a 4-ticket
 * feature ... with at least two parallelisable tickets", was **unreachable
 * honestly** on that ask: any breakdown satisfying it would have been padded.
 *
 * This requirement adds a second capability, number formatting, that genuinely
 * needs nothing from the parser and that the parser needs nothing from. The
 * independence is deliberately **not stated** in the text — a requirement that
 * announced "these two parts are independent" would be handing the Delivery Lead
 * the answer, and the point is to test whether the prompt makes it find one.
 */
const REQUIREMENT = [
  '# A command-line expression calculator',
  '',
  'The calculator can only apply one named operation to two numbers. Three things would make it',
  'genuinely usable.',
  '',
  '**Evaluating whole expressions.** `evaluate("2 + 3 * 4")` should return `14`. It must honour',
  'normal operator precedence (`*` and `/` bind tighter than `+` and `-`), support parentheses,',
  'ignore whitespace, and raise a clear, named error for malformed input and for division by zero',
  'rather than returning `NaN` or `Infinity`.',
  '',
  '**Formatting results for a person to read.** Division produces long decimals — `10 / 3` comes',
  'out as `3.3333333333333335`, which nobody wants to look at. There should be a way to render any',
  'number for display: at most six significant digits, no trailing zeros, and no exponent notation',
  'for ordinary sizes. Formatting `3.3333333333333335` should give `3.33333`, and formatting `4`',
  'should give `4`, not `4.00000`.',
  '',
  '**A command line.** A person should be able to type an expression in a terminal and see the',
  'formatted result, without writing any code. A malformed expression should print a clear message',
  'and exit with a non-zero status rather than a stack trace.',
  '',
].join('\n');

/**
 * A filled-in `project.md`, written into the vault before anything runs.
 *
 * ============================================================================
 * THE TEMPLATE IS NOT A REALISTIC VAULT, AND RUN 1 PROVED IT
 * ============================================================================
 * `factoryVault()` copies `vault-template/project.md` verbatim, and that file is
 * a **template**: its "Stack and conventions" section reads "_Language,
 * framework, test runner, and any house rules an agent must follow._" The first
 * real run spent one of the PM's five questions on exactly that —
 * "project.md's 'Stack and conventions' section is an unfilled template — what
 * language/runtime and test framework should this feature be implemented in?"
 *
 * That question is **correct behaviour**. The PM has no tools, `project.md` is
 * one of only two documents it receives, and the target repo's `CLAUDE.md` is
 * not on its recipe. The defect was in the harness: an operator fills this in at
 * `factory init`, so a test that leaves it as boilerplate is measuring the
 * pipeline under a condition no real vault is in.
 *
 * Deliberately **not** fixed by editing `vault-template/project.md`, which must
 * stay a template, and deliberately not a copy of the repo's `CLAUDE.md` — it is
 * what a person would write, and it stops short of the design decisions the Tech
 * Lead is supposed to make.
 */
const PROJECT_MD = [
  '# Project',
  '',
  '## What this is',
  '',
  '`toy-app` is a small arithmetic calculator library. It is the target repo this factory builds',
  'against, and it has no users beyond its own test suite.',
  '',
  '## Stack and conventions',
  '',
  '- **Node 22, TypeScript, ESM only.** Node runs `.ts` files through type stripping — there is no',
  '  compiler — so only erasable syntax is allowed: no `enum`, no `namespace`, no constructor',
  '  parameter properties, no decorators.',
  '- **Zero npm dependencies, ever.** There is no network and no `node_modules`. Anything a change',
  "  needs must come from Node 22's standard library.",
  "- **Relative imports carry the real extension**: `import { add } from './calc.ts'`.",
  '- **Tests** use `node:test` and `node:assert/strict` and sit beside the code as',
  '  `src/<name>.test.ts`.',
  '- **Errors** are named classes extending `Error`, never bare strings.',
  '- Two-space indent, single quotes, semicolons, trailing newline.',
  '',
  '## Gates',
  '',
  '`npm test`, `npm run lint` and `npm run build` must each exit 0. `npm run build` checks that',
  'every module under `src/` loads under type stripping; it does **not** check types.',
  '',
  '## Out of scope',
  '',
  '- Adding dependencies, a bundler, or a type checker.',
  '- Anything outside this repository.',
  '',
  '## Working agreement',
  '',
  '- The orchestrator is the only writer of this vault. Agents never edit these files; they return',
  '  structured output and the orchestrator writes it.',
  '- **Do not edit notes in Obsidian while the factory is running.** There is no lost-update guard',
  '  by design. Edit when an item is `needs_human`, or when the factory is stopped.',
  '',
].join('\n');

let vault: FactoryFixture;
let home: string;
let workspace: string;
let clockMs: number;
const worktreeRoots: string[] = [];

function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

function deps(): CliDeps {
  return {
    cwd: workspace,
    env: { PATH: process.env['PATH'] ?? '' },
    registry: new ProjectRegistry(home),
    out: () => undefined,
    err: () => undefined,
    now,
    // The real thing — the same factory `processDeps()` installs. Anything less
    // and the agents would run in the operator's own checkout, which is the
    // situation Phase 7a's refusal exists to prevent.
    workspaceFactory: realWorktrees,
  };
}

async function factory(args: readonly string[]): Promise<void> {
  await buildProgram(deps(), MANIFEST).parseAsync(['node', 'factory', ...args]);
}

/** One or more real cycles through the production `factory start` path. */
async function cycles(maxCycles: number): Promise<void> {
  await runStart({ vault: vault.root, maxCycles }, deps());
}

interface RunCost {
  readonly role: string;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly ok: boolean;
}

/** Per-role spend, read from the orchestrator's own event log. */
function runCosts(): RunCost[] {
  const file = vault.paths.eventLog();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const costs: RunCost[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as {
      type?: string;
      role?: string;
      costUsd?: number;
      durationMs?: number;
      ok?: boolean;
    };
    if (event.type !== 'run_finished') continue;
    costs.push({
      role: String(event.role),
      costUsd: event.costUsd ?? 0,
      durationMs: event.durationMs ?? 0,
      ok: event.ok === true,
    });
  }
  return costs;
}

/**
 * Copy the run's transcripts somewhere `afterAll` will not delete.
 *
 * ============================================================================
 * WHY THIS IS NOT OPTIONAL TIDINESS
 * ============================================================================
 * The vault lives in a scratch directory that `cleanupAllScratchDirs()` removes,
 * so a failed run used to take its own evidence with it. That cost a real
 * diagnosis: two runs produced a Delivery Lead payload containing one ticket
 * titled `"test"`, and by the time the failure was read the transcript that
 * would have explained it no longer existed. A run that costs a dollar and
 * proves nothing because its log was deleted is the worst possible outcome here.
 *
 * Written to `.factory-test-repos/pipeline-real-logs/`, which is gitignored with
 * the rest of that directory and is not on the scratch registry.
 */
function keepTranscripts(label: string): string {
  const destination = path.join(TRANSCRIPT_KEEP, label);
  try {
    mkdirSync(destination, { recursive: true });
    cpSync(vault.paths.logsDir(), destination, { recursive: true });
  } catch {
    // Best effort. A missing logs directory means no agent ever started, which
    // the assertions will report far more clearly than an error from here.
  }
  return destination;
}

/**
 * The size of each role's structured payload, read from its own transcript.
 *
 * ============================================================================
 * THE NUMBER THIS PHASE LEARNED TO WATCH
 * ============================================================================
 * Measured from the `result` event the CLI wrote, not from the notes the
 * orchestrator produced, because what matters is the size the CLI had to carry
 * through one `StructuredOutput` call. That is where it fails: at roughly
 * 20,000 characters the mechanism exhausts its internal retries and returns
 * `structured_output_retry_exhausted`, or — worse — degrades to a minimal
 * payload that still validates. Two Phase 7b runs came back with a single
 * ticket titled `"test"` that way, having spent $1.86 and $1.57.
 *
 * Printed on every run and asserted below, because a size that only gets looked
 * at after something breaks is a size nobody is watching.
 */
function payloadSizes(): Array<{ role: string; chars: number; calls: number }> {
  const sizes: Array<{ role: string; chars: number; calls: number }> = [];
  let files: string[];
  try {
    files = readdirSync(vault.paths.featureLogDir(SLUG)).filter((name) => name.endsWith('.log'));
  } catch {
    return sizes;
  }

  for (const name of files.sort()) {
    const role = /-(pm|tl_plan|dl)(?:-schema-retry\d+)?\.log$/.exec(name)?.[1];
    if (role === undefined) continue;
    const jsonl = readFileSync(path.join(vault.paths.featureLogDir(SLUG), name), 'utf8');
    let chars = 0;
    let calls = 0;
    for (const line of jsonl.split('\n')) {
      if (line.trim() === '') continue;
      let event: {
        type?: string;
        structured_output?: unknown;
        message?: { content?: unknown };
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.type === 'result' && event.structured_output != null) {
        chars = JSON.stringify(event.structured_output).length;
      }
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const part = block as { type?: string; name?: string };
        if (part.type === 'tool_use' && part.name === 'StructuredOutput') calls += 1;
      }
    }
    sizes.push({ role, chars, calls });
  }
  return sizes;
}

/** How many times the Phase 7b schema-retry rule fired. See its use below. */
function schemaRetryCount(): number {
  let raw: string;
  try {
    raw = readFileSync(vault.paths.eventLog(), 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let event: { type?: string };
    try {
      event = JSON.parse(line) as { type?: string };
    } catch {
      continue;
    }
    if (event.type === 'schema_retry') count += 1;
  }
  return count;
}

function total(costs: readonly RunCost[]): number {
  return costs.reduce((sum, entry) => sum + entry.costUsd, 0);
}

/** A ticket note read back as the shape the self-containment checker wants. */
function asTicketLike(note: TicketNote): TicketLike {
  return {
    title: note.frontmatter.title,
    description_md: sectionText(note.body, SECTION.rawRequirement) ?? '',
    acceptance_criteria: (sectionText(note.body, SECTION.acceptanceCriteria) ?? '')
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0),
    technical_notes_md: sectionText(note.body, SECTION.techPlan) ?? '',
    depends_on: note.frontmatter.depends_on,
  };
}

beforeEach(() => {
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
  vault = factoryVault({ config: { runner: 'claude-code' } });
  // See `PROJECT_MD` — the shipped template is boilerplate, and every role gets
  // this file.
  writeFileSync(vault.paths.projectFile(), PROJECT_MD, 'utf8');
  home = scratchFactoryHome();
  workspace = scratchDir('real-pipeline-workspace-');
  worktreeRoots.push(worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));
});

afterAll(() => {
  for (const root of worktreeRoots) rmSync(root, { recursive: true, force: true });
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

// ---------------------------------------------------------------------------
// Free checks. These run on every `npm test`.
// ---------------------------------------------------------------------------

/**
 * A breakdown recorded from a real Delivery Lead run, and the same breakdown
 * with the three defects the checker exists to catch put back into it.
 *
 * The clean copy is the **negative control**: without it, "the checker found
 * nothing" could equally mean the checker does not work. Phase 6's own
 * `agents-real-cli.test.ts` uses the same device for the same reason.
 */
const CLEAN_BREAKDOWN: readonly TicketLike[] = [
  {
    title: 'Add ParseError and DivideByZeroError to src/errors.ts',
    description_md:
      'Create `src/errors.ts` exporting two named error classes, `ParseError` and ' +
      '`DivideByZeroError`, both extending `Error` and both setting `this.name`. `ParseError` ' +
      'takes the offending input string and exposes it as `input`.',
    acceptance_criteria: [
      "`new ParseError('2 +').name` is `'ParseError'`",
      "`new ParseError('2 +').input` is `'2 +'`",
      '`npm test` exits 0',
    ],
    technical_notes_md: 'Follow the existing class style in `src/calc.ts`. ESM only, `.ts` extensions on imports.',
    depends_on: [],
  },
  {
    title: 'Add evaluate() to src/evaluate.ts with precedence and parentheses',
    description_md:
      'Create `src/evaluate.ts` exporting `evaluate(input: string): number`. It tokenises the ' +
      'input, honours `*` and `/` binding tighter than `+` and `-`, and supports parentheses. ' +
      'It throws `ParseError` from `src/errors.ts` on malformed input.',
    acceptance_criteria: [
      "`evaluate('2 + 3 * 4')` returns 14",
      "`evaluate('(2 + 3) * 4')` returns 20",
      "`evaluate('2 +')` throws ParseError",
    ],
    technical_notes_md: 'A recursive-descent parser is enough. Import as `./errors.ts`.',
    depends_on: ['Add ParseError and DivideByZeroError to src/errors.ts'],
  },
];

const DIRTY_BREAKDOWN: readonly TicketLike[] = [
  {
    title: 'Add the parser core',
    description_md: 'Build the tokeniser and the expression parser as described in the previous ticket.',
    acceptance_criteria: ['it works'],
    technical_notes_md: 'See my breakdown notes for the module split.',
    depends_on: [],
  },
  {
    title: 'Finish the arithmetic support in the evaluator',
    description_md: 'Ticket 1 added `+` and `-`. Add the remaining operators.',
    acceptance_criteria: ['T001 still passes'],
    technical_notes_md: '',
    depends_on: ['Add the parser core'],
  },
];

describe('the self-containment checker (free, always runs)', () => {
  it('passes a breakdown whose tickets each stand alone', () => {
    const findings = findSelfContainmentProblems(CLEAN_BREAKDOWN);
    expect(describeSelfContainmentProblems(findings)).toBe('');
  });

  it('catches every kind of cross-ticket reference it claims to', () => {
    const findings = findSelfContainmentProblems(DIRTY_BREAKDOWN);
    const rules = new Set(findings.map((finding) => finding.rule));

    expect([...rules].join(' | ')).toContain('names another ticket by position');
    expect([...rules].join(' | ')).toContain('names a ticket by ordinal');
    expect([...rules].join(' | ')).toContain('names a ticket by id');
    expect([...rules].join(' | ')).toContain('defers work to another ticket');
    expect([...rules].join(' | ')).toContain('refers to the breakdown notes');
  });

  it('does not fire on ordinary prose about code', () => {
    // The rule that most wants to over-fire. "the previous token" is what a
    // parser ticket legitimately says, and a checker that flagged it would be
    // switched off within a week.
    const findings = findSelfContainmentProblems([
      {
        title: 'Add the tokeniser',
        description_md:
          'When the previous token is an operator, a `-` starts a negative literal rather than a ' +
          'subtraction. Keep the prior result on the stack and reuse the last value.',
        acceptance_criteria: ["`tokenise('-2')` yields one numeric token"],
        technical_notes_md: '',
      },
    ]);
    expect(describeSelfContainmentProblems(findings)).toBe('');
  });

  it('tells "as described above" apart from "as described in the previous ticket"', () => {
    // The distinction a real Delivery Lead run forced (see the rule's comment in
    // `ticketSelfContainment.ts`). A ticket note is rendered to the Developer as
    // description → acceptance criteria → tech notes, so "above" from inside the
    // tech notes is the same ticket and resolves. "the previous ticket" is a
    // note the Developer has no way to open.
    const resolvable: TicketLike = {
      title: 'Add the CLI entry point to src/cli.ts',
      description_md: 'Import `evaluate` from `./evaluate.ts` and `formatNumber` from `./format.ts`.',
      acceptance_criteria: ['`node src/cli.ts "2 + 2"` prints `4`'],
      technical_notes_md: 'Both modules are exactly as described above and already exist in the worktree.',
    };
    expect(describeSelfContainmentProblems(findSelfContainmentProblems([resolvable]))).toBe('');

    const unresolvable: TicketLike = {
      ...resolvable,
      technical_notes_md: 'Both modules are as described in the previous ticket.',
    };
    expect(describeSelfContainmentProblems(findSelfContainmentProblems([unresolvable]))).not.toBe('');
  });

  it('tells a scope fence apart from a dangling reference', () => {
    // The second narrowing a real Delivery Lead run forced. "those belong to
    // other tickets" is the sentence that stops two Developers editing the same
    // file; it names no note to go and read. "the other ticket" does.
    const fence: TicketLike = {
      title: 'Add format() to src/format.ts',
      description_md: 'Create `src/format.ts` exporting `format(value: number): string`.',
      acceptance_criteria: ["`format(4)` returns `'4'`"],
      technical_notes_md:
        'Do not touch `src/cli.ts`, `src/evaluate.ts`, or `package.json` — those belong to other tickets.',
    };
    expect(describeSelfContainmentProblems(findSelfContainmentProblems([fence]))).toBe('');

    const dangling: TicketLike = {
      ...fence,
      technical_notes_md: 'Use the signature agreed in the other ticket.',
    };
    expect(describeSelfContainmentProblems(findSelfContainmentProblems([dangling]))).not.toBe('');
  });

  it('does not fire when one ticket title is a prefix of another', () => {
    const findings = findSelfContainmentProblems([
      { title: 'Add the CLI entry point', description_md: 'Add the CLI entry point in `src/cli.ts`.', acceptance_criteria: ['x'] },
      { title: 'Add the CLI entry point tests', description_md: 'Test `src/cli.ts`.', acceptance_criteria: ['y'] },
    ]);
    expect(describeSelfContainmentProblems(findings)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The paid run.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_REAL_PIPELINE)('the M2 pipeline on real agents (FACTORY_REAL_PIPELINE=1)', () => {
  for (let run = 1; run <= Math.max(1, RUNS); run += 1) {
    it(
      `run ${run}/${Math.max(1, RUNS)}: intake → in_development, with a valid ticket DAG`,
      async () => {
        // Everything below runs inside a `finally` that copies the transcripts
        // out of the scratch vault. It has to: an assertion firing anywhere in
        // here would otherwise let `afterAll` delete the only record of a run
        // that has already cost real money, which is exactly what happened to
        // the third run of the batch that produced the narrowings above.
        try {
        const requirementFile = path.join(workspace, 'evaluate.md');
        writeFileSync(requirementFile, REQUIREMENT, 'utf8');
        await factory(['feature', 'add', requirementFile, '--vault', vault.root]);

        const featureFile = vault.paths.featureNote(SLUG);
        await expect(vault.storage.readNote<FeatureFrontmatter>(featureFile)).resolves.toBeDefined();

        // --- the PM ------------------------------------------------------
        await cycles(1);
        let note = await vault.storage.readNote<FeatureFrontmatter>(featureFile);
        expect(
          note.frontmatter.status,
          `the PM run did not reach the checkpoint (status ${String(note.frontmatter.status)}, ` +
            `pause ${String(note.frontmatter.pause_reason)}: ${String(note.frontmatter.pause_detail)})`,
        ).toBe('needs_human');
        expect(note.frontmatter.pause_reason).toBe('checkpoint');

        const criteria = (sectionText(note.body, SECTION.acceptanceCriteria) ?? '')
          .split('\n')
          .filter((line) => line.trim().startsWith('-'));
        console.log(`[real-pipeline run ${run}] PM acceptance criteria:\n${criteria.join('\n')}`);
        expect(criteria.length, 'the PM wrote no acceptance criteria').toBeGreaterThan(0);

        await factory(['approve', FEATURE_ID, 'looks right', '--vault', vault.root]);

        // --- the TL, then the DL -----------------------------------------
        // Three cycles, not two. A transient agent failure (an `api_error`, a
        // dropped connection) leaves the feature where it was for the next
        // cycle to retry — that is the orchestrator working as designed, and a
        // two-cycle budget reports it as "the DL never ran", which is both
        // wrong and undiagnosable. The headroom does **not** make a retry
        // acceptable: `costs.length` is still asserted to be exactly three, so
        // any run that needed a second attempt still fails. It only moves the
        // failure to the assertion that can explain it.
        await cycles(3);
        note = await vault.storage.readNote<FeatureFrontmatter>(featureFile);
        expect(
          note.frontmatter.status,
          `the TL/DL runs did not reach the breakdown checkpoint (status ` +
            `${String(note.frontmatter.status)}, pause ${String(note.frontmatter.pause_detail)})`,
        ).toBe('needs_human');
        expect(note.frontmatter.resume_to).toBe('in_development');

        const techPlan = readFileSync(vault.paths.techPlan(SLUG), 'utf8');
        expect(techPlan.length, 'tech-plan.md is empty').toBeGreaterThan(200);

        await factory(['approve', FEATURE_ID, 'ship it', '--vault', vault.root]);
        note = await vault.storage.readNote<FeatureFrontmatter>(featureFile);
        expect(note.frontmatter.status).toBe('in_development');

        // --- cost, reported first --------------------------------------
        // Before any assertion below, deliberately. Real money has already been
        // spent by the time control reaches here, and an assertion that fires
        // first would take the only record of what it cost with it — which is
        // exactly what happened on the run that produced the narrowing recorded
        // in `ticketSelfContainment.ts`.
        const costs = runCosts();
        console.log(
          `[real-pipeline run ${run}] cost:\n` +
            costs
              .map(
                (entry) =>
                  `  ${entry.role.padEnd(8)} $${entry.costUsd.toFixed(4)}  ` +
                  `${(entry.durationMs / 1000).toFixed(0)}s  ok=${entry.ok}`,
              )
              .join('\n') +
            `\n  TOTAL    $${total(costs).toFixed(4)}`,
        );

        // --- payload size ------------------------------------------------
        const sizes = payloadSizes();
        console.log(
          `[real-pipeline run ${run}] payload sizes (warn at ${vault.config.payload_warn_chars}):\n` +
            sizes
              .map(
                (entry) =>
                  `  ${entry.role.padEnd(8)} ${String(entry.chars).padStart(6)} ch  ` +
                  `${entry.calls} StructuredOutput call(s)`,
              )
              .join('\n'),
        );

        // The Delivery Lead is the only role whose payload has ever come near
        // the cliff, and it is the one the trim targeted. Asserted, not merely
        // printed: this failure mode is invisible until it is total, so the size
        // has to be able to go red on its own rather than waiting for the run it
        // finally breaks.
        // The **accepted** payload, not the first one attempted.
        //
        // *(Corrected after batch B, and the bug is worth naming. A role that
        // needed a second orchestrator attempt leaves two transcripts —
        // `…-1-dl.log` and `…-2-dl.log` — and the first carries a payload of
        // zero characters, because that attempt returned nothing at all.
        // `.find()` took that one, so the assertion measured the run that
        // failed rather than the run whose tickets were actually written, and
        // reported "0 characters" as though it were the size that mattered.
        // Taking the last non-empty one measures what the orchestrator applied.)*
        const dlSizes = sizes.filter((entry) => entry.role === 'dl' && entry.chars > 0);
        const dlSize = dlSizes[dlSizes.length - 1];
        expect(dlSize, 'no dl transcript with a payload to measure').toBeDefined();
        // ============================================================================
        // A WARNING LINE AND A REGRESSION LINE ARE DIFFERENT THINGS
        // ============================================================================
        // This used to hard-fail at `config.payload_warn_chars`, which conflated
        // the two. `payload_warn_chars` is where an operator wants to be told
        // "the DL is running big again"; four of the six recorded runs sit above
        // it, and all four produced correct breakdowns. Failing there would fail
        // the normal case.
        //
        // The hard bar is a **trim-regression** alarm instead. Before the
        // Phase 7b trim the DL averaged ~18,700 characters and delivery failed
        // often; after it, ~12,700 and the largest accepted payload was 14,471.
        // 16,000 sits above anything this pipeline has ever successfully
        // produced and well below the band it was trimmed out of, so it goes red
        // if the prompt drifts back rather than on ordinary variation.
        //
        // It is explicitly **not** a safety line. Size does not predict delivery
        // failure — see the call-count note below.
        const dlChars = dlSize?.chars ?? 0;
        if (dlChars > vault.config.payload_warn_chars) {
          console.warn(
            `[real-pipeline run ${run}] WARNING: the DL payload is ${dlChars} characters, over the ` +
              `${vault.config.payload_warn_chars} warning line. Not a failure — but this is the ` +
              'band the trim moved the DL out of, and delivery failures were frequent above it.',
          );
        }
        expect(
          dlChars,
          `the DL payload is ${dlChars} characters. The Phase 7b trim brought the DL from ~18,700 ` +
            'to ~12,700, and 14,471 is the largest payload this pipeline has ever had accepted. ' +
            'Anything past 16,000 means the breakdown has drifted back toward the pre-trim size, ' +
            'where the CLI failed to deliver it far more often. Trim what tickets repeat — the ' +
            'conventions paragraph, the notes — never what makes them buildable.',
        ).toBeLessThanOrEqual(PAYLOAD_REGRESSION_CHARS);

        // How many times the CLI had to ask for the payload.
        //
        // ============================================================================
        // A WARNING, NOT AN ASSERTION — AND THE MEASUREMENT SAYS WHY
        // ============================================================================
        // This was `=== 1`, then `<= 2`. Both were guesses dressed as limits.
        // Measuring the argument the model actually sent on every rejected call,
        // across all six recorded runs, settles it:
        //
        //     smallest REJECTED call:   2,145 characters
        //     largest  ACCEPTED call:  14,471 characters
        //
        // Size does not discriminate. Neither does the call count: one recorded
        // run had its payload accepted on the **fifth** call and produced a
        // perfect three-ticket breakdown, while another was rejected on the
        // first at 10,189 characters. A hard bar on either number would fail
        // correct runs and pass broken ones.
        //
        // What is really happening is a parameter-boundary parsing fault. The
        // rejected calls carry the tickets array glued onto the end of the
        // previous string field:
        //
        //     …</notes_markdown>\n<parameter name="tickets">[…
        //
        // which is why the CLI reports `root: must have required property
        // 'tickets'` — the model did emit them, and the emission was mangled in
        // transit. That is not something the ticket count or the payload length
        // predicts, so it is reported loudly and left to the human.
        const dlCalls = dlSize?.calls ?? 0;
        if (dlCalls > 1) {
          console.warn(
            `[real-pipeline run ${run}] WARNING: the DL payload took ${dlCalls} StructuredOutput ` +
              'call(s) to land. The CLI rejected at least one and its own retry recovered. Check ' +
              'the tool_result in the kept transcript: `could not be parsed as JSON` and ' +
              '`must have required property` are the parameter-boundary fault; a named missing ' +
              'field is a real contract miss. See the plan\'s Phase 7b measurement section.',
          );
        }

        // --- the breakdown -----------------------------------------------
        const tickets = await vault.storage.listTickets(SLUG);
        console.log(
          `[real-pipeline run ${run}] ${tickets.length} tickets:\n` +
            tickets
              .map(
                (ticket) =>
                  `  ${ticket.frontmatter.id}  ${ticket.frontmatter.title}\n` +
                  `      depends_on: ${JSON.stringify(ticket.frontmatter.depends_on)}`,
              )
              .join('\n'),
        );

        expect(tickets.length, 'the DL returned fewer than three tickets').toBeGreaterThanOrEqual(3);

        // A valid DAG: no cycles, and every dependency names a real ticket.
        const nodes = tickets.map((ticket) => ({
          id: ticket.frontmatter.id,
          status: ticket.frontmatter.status,
          depends_on: ticket.frontmatter.depends_on,
        }));
        expect(detectCycles(nodes)).toEqual([]);
        const ids = new Set(nodes.map((node) => node.id));
        for (const node of nodes) {
          for (const dependency of node.depends_on) {
            expect(ids.has(dependency), `${node.id} depends on unknown ${dependency}`).toBe(true);
          }
        }

        // At least two parallelisable tickets (plan Phase 7b). "Parallelisable"
        // is what the scheduler would actually do: two tickets that become
        // actionable at the same moment, neither waiting on the other.
        const openable = resolveActionable(nodes);
        expect(
          openable.length,
          `only ${openable.length} ticket(s) can start at once — the DL produced a chain, not a ` +
            'graph, so nothing in Phase 9 can ever run in parallel',
        ).toBeGreaterThanOrEqual(2);

        // --- self-containment ---------------------------------------------
        const findings = findSelfContainmentProblems(tickets.map(asTicketLike));
        expect(describeSelfContainmentProblems(findings)).toBe('');

        // --- what a Developer would actually be handed ---------------------
        // Printed, not asserted: the judgement "could this be implemented from
        // this text alone" is not one a regex makes. This is the text a human
        // reviews, and printing it is what makes that review possible at all.
        const first = tickets[0];
        if (first !== undefined) {
          const built = await buildContext(recipeFor('developer'), {
            storage: vault.storage,
            paths: vault.paths,
            featureSlug: SLUG,
            ticketId: first.frontmatter.id,
            repoRoot: vault.config.target_repo,
            attempt: 1,
            maxChars: vault.config.context_warn_chars,
            task: 'Implement the ticket above.',
          });
          console.log(
            `[real-pipeline run ${run}] DEVELOPER CONTEXT for ${first.frontmatter.id} ` +
              `(${built.prompt.length} chars)\n${'='.repeat(70)}\n${built.prompt}\n${'='.repeat(70)}`,
          );
        }

        // --- the run count --------------------------------------------------
        //
        // ============================================================================
        // WHAT "CLEAN" MEANS HERE, AND WHY IT IS NOT "EXACTLY THREE RUNS"
        // ============================================================================
        // This block used to assert `costs.length === 3` with a message blaming
        // "the schema retry". Both halves were wrong, and the assertion had
        // never been executed against a real run when it was written.
        //
        // Wrong on the mechanism: **no `schema_retry` event exists in any of the
        // six recorded runs.** The extra agent run, when there is one, is an
        // `api_error` attempt-retry — the CLI failed to deliver the payload at
        // all, dispatch charged an attempt, and the next cycle re-ran the role.
        // That is a different mechanism from the Phase 7b schema rule, and
        // naming the wrong one sends the next reader to the wrong file.
        //
        // Wrong on the bar: two of six recorded runs produced **four**
        // `run_finished` events and both reached `in_development` with a valid,
        // fully self-contained three-ticket breakdown. Asserting three would
        // fail them for using the retry the orchestrator exists to provide.
        //
        // So the three things actually asserted are the ones the evidence
        // supports across all six runs:
        const okRuns = costs.filter((entry) => entry.ok).length;

        // 1. Exactly one successful run per role. More would mean a role
        //    succeeded twice, which no transition permits; fewer means the
        //    pipeline did not complete. 3 in all six recorded runs.
        expect(
          okRuns,
          `${okRuns} successful agent runs; the M2 pipeline needs exactly one each from pm, ` +
            'tl_plan and dl',
        ).toBe(3);

        // 2. The Phase 7b schema rule never had to fire. This is the check the
        //    old message *described* but did not perform: a `schema_retry` means
        //    the CLI accepted a payload that the orchestrator's own zod schema
        //    then rejected, i.e. the two validators disagree about the contract.
        //    0 in all six recorded runs.
        const schemaRetries = schemaRetryCount();
        expect(
          schemaRetries,
          `the schema-retry rule fired ${schemaRetries} time(s). The CLI validated a payload that ` +
            "the orchestrator's own schema then rejected, so `--json-schema` and " +
            'src/agents/schemas.ts disagree about the payload shape.',
        ).toBe(0);

        // 3. Attempt-retries are allowed but bounded. Observed maximum is four
        //    agent runs; five leaves one run of headroom before this reports.
        //    `max_attempts` is 3, so the ceiling this guards is a role failing
        //    delivery repeatedly rather than once.
        expect(
          costs.length,
          `${costs.length} agent runs for three roles. Up to two extra are the orchestrator ` +
            'retrying a role whose payload the CLI failed to deliver (`api_error`, ' +
            'terminalReason `structured_output_retry_exhausted`) — see the "Phase 7b measurement ' +
            'results" section of the plan. More than that means delivery is failing repeatedly.',
        ).toBeLessThanOrEqual(5);
        } finally {
          console.log(
            `[real-pipeline run ${run}] transcripts kept at ${keepTranscripts(`run-${run}`)}`,
          );
        }
      },
      60 * 60 * 1000,
    );
  }
});

// A compile-time nudge: the paid block above is the only consumer of these.
void validateAgentOutput;

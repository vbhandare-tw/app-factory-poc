/**
 * Fixtures for the Phase 9 developer → gates → review → QA loop.
 *
 * ============================================================================
 * THE ONE THING THAT MAKES THESE TESTS WORTH ANYTHING
 * ============================================================================
 * `MockRunner` returns a canned payload and touches nothing. That is exactly
 * right for the paper pipeline and useless here: this phase's whole guarantee is
 * about the **relationship** between what an agent left on disk and what the
 * orchestrator committed, and a runner that writes nothing makes the dirty tree
 * and the committed state trivially identical. Under that fixture, running the
 * gates before the commit and running them after it are indistinguishable.
 *
 * So `scriptedAgents` below drives a runner that really does write, delete and
 * modify files in the run's `cwd` — the worktree the workspace provider just
 * provisioned — and only then returns its payload. A script can therefore
 * construct a **deliberate divergence**: create a file the commit will not
 * carry, and the two orderings stop being the same experiment.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ChildProcessGateRunner } from '../../src/gates/runner.js';
import type { GateRunner } from '../../src/gates/runner.js';
import { ShellGit } from '../../src/git/git.js';
import type { Git } from '../../src/git/git.js';
import { reconcileWorktrees } from '../../src/git/reconcile.js';
import type { ReconcileReport } from '../../src/git/reconcile.js';
import { createFeatureWorkspaceProvider, createWorkspaceProvider } from '../../src/git/workspace.js';
import type { EventSink } from '../../src/log/events.js';
import type {
  FeatureWorkspaceProvider,
  WorkspaceProvider,
} from '../../src/orchestrator/dispatch.js';
import type { AgentRunResult, AgentRunSpec, Runner } from '../../src/runner/types.js';
import { SECTION } from '../../src/agents/context.js';
import { appendToSection } from '../../src/vault/storage.js';
import { makeFeature, makeTicket } from './notes.js';
import type { FactoryFixture } from './orchestratorFixtures.js';
import { factoryVault } from './orchestratorFixtures.js';
import { git as rawGit } from './toyRepo.js';

// ---------------------------------------------------------------------------
// A vault with a feature already in development.
// ---------------------------------------------------------------------------

export const SLUG = 'sample';
export const FEATURE_ID = 'FEAT-SAMPLE';
export const TICKET_ID = 'FEAT-SAMPLE-T001';

export interface DevVaultOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  /** Ticket state to start from. `ready` is the usual entry point. */
  readonly ticketStatus?: 'backlog' | 'ready' | 'in_progress' | 'gates' | 'code_review' | 'qa';
  readonly maxAttempts?: number | null;
  readonly attempts?: number;
}

/**
 * A vault whose feature is `in_development` with one ticket, plus a real toy
 * repo to build in.
 *
 * `setup_command` defaults to a no-op rather than `npm ci`: the toy app has zero
 * dependencies and all three of its gates are plain `node` invocations, so an
 * install would add a second per provisioning and prove nothing this phase is
 * about. Phase 8 already owns the evidence that provisioning installs.
 */
export async function devVault(options: DevVaultOptions = {}): Promise<FactoryFixture> {
  const fixture = factoryVault({
    config: {
      setup_command: 'node -e ""',
      ...(options.config ?? {}),
    },
  });

  mkdirSync(fixture.paths.ticketsDir(SLUG), { recursive: true });

  await fixture.storage.writeNote(
    fixture.paths.featureNote(SLUG),
    makeFeature(
      { id: FEATURE_ID, slug: SLUG, status: 'in_development', title: 'Add subtract' },
      '## History\n\n- 2026-09-01T09:00:00Z | ticketing → in_development | human\n',
    ),
  );

  writeFileSync(
    fixture.paths.techPlan(SLUG),
    '# Technical plan — Add subtract\n\nOne pure function in `src/calc.ts`.\n',
    'utf8',
  );

  let body = '';
  body = appendToSection(body, SECTION.rawRequirement, 'Add a `describe()` helper to the calculator.');
  body = appendToSection(body, SECTION.acceptanceCriteria, '- `describe("add")` returns a string');

  await fixture.storage.writeNote(
    fixture.paths.ticketPath(SLUG, TICKET_ID),
    makeTicket(
      {
        id: TICKET_ID,
        feature: SLUG,
        title: 'Add a describe helper',
        status: options.ticketStatus ?? 'ready',
        attempts: options.attempts ?? 0,
        max_attempts: options.maxAttempts ?? null,
      },
      body,
    ),
  );

  return fixture;
}

// ---------------------------------------------------------------------------
// The real git / worktree / gate capability.
// ---------------------------------------------------------------------------

export interface Capability {
  readonly git: Git;
  readonly gates: GateRunner;
  readonly workspace: WorkspaceProvider;
  readonly reconcile: () => Promise<ReconcileReport>;
  /**
   * Where the post-merge gates run (Phase 10).
   *
   * Built here so both suites share one construction, and deliberately **not**
   * forwarded to `Orchestrator.start` by `dev-loop.test.ts`: a dispatcher
   * without it leaves a verified ticket waiting at `merge`, which is the state
   * every Phase 9 case ends in and asserts on.
   */
  readonly featureWorkspace: FeatureWorkspaceProvider;
}

/** Everything `Orchestrator.start` needs to run the Phase 9 ticket loop for real. */
export function realCapability(
  fixture: FactoryFixture,
  options: { readonly events?: EventSink; readonly now?: () => string; readonly gates?: GateRunner } = {},
): Capability {
  const git = new ShellGit({ repoRoot: fixture.config.target_repo });
  return {
    git,
    gates: options.gates ?? new ChildProcessGateRunner(),
    workspace: createWorkspaceProvider({
      config: fixture.config,
      paths: fixture.paths,
      storage: fixture.storage,
      git,
      ...(options.events === undefined ? {} : { events: options.events }),
    }),
    featureWorkspace: createFeatureWorkspaceProvider({
      config: fixture.config,
      paths: fixture.paths,
      storage: fixture.storage,
      git,
      ...(options.events === undefined ? {} : { events: options.events }),
    }),
    reconcile: () =>
      reconcileWorktrees({
        git,
        config: fixture.config,
        paths: fixture.paths,
        storage: fixture.storage,
        now: options.now ?? ((): string => new Date().toISOString()),
        ...(options.events === undefined ? {} : { events: options.events }),
      }),
  };
}

// ---------------------------------------------------------------------------
// A runner that actually writes files.
// ---------------------------------------------------------------------------

/** What one scripted agent run does to the worktree, and what it then returns. */
export interface AgentStep {
  /** Files written, relative to the run's cwd. Parent directories are created. */
  readonly write?: Readonly<Record<string, string>>;
  /** Files or directories removed, relative to the run's cwd. */
  readonly remove?: readonly string[];
  /** Runs after the writes, so a step can inspect or mangle the tree itself. */
  readonly then?: (cwd: string) => void;
  readonly structured: unknown;
  readonly costUsd?: number;
}

export interface ScriptedRunner extends Runner {
  /** Every spec this runner was handed. The main assertion surface. */
  readonly calls: AgentRunSpec[];
  /** Roles invoked, in order. What "the reviewer never ran" is asserted on. */
  roles(): string[];
  /** Replace a step mid-test — e.g. to make attempt 2 succeed. */
  set(key: string, step: AgentStep): void;
}

/**
 * A `Runner` whose steps write real files into the run's working directory.
 *
 * Keyed by `<role>:<itemId>` then `<role>`, the same resolution order as
 * `MockRunner`, and an unmatched key **throws** for the same reason: a plausible
 * default would let a test pass while the wrong role ran.
 *
 * A key may map to a list, in which case successive runs of that key take
 * successive entries and the last one repeats. That is how a bounce-and-fix
 * scenario is expressed without a stateful closure in every test.
 */
export function scriptedAgents(
  script: Readonly<Record<string, AgentStep | readonly AgentStep[]>>,
): ScriptedRunner {
  const steps = new Map<string, AgentStep | readonly AgentStep[]>(Object.entries(script));
  const used = new Map<string, number>();
  const calls: AgentRunSpec[] = [];

  const resolve = (spec: AgentRunSpec): { key: string; step: AgentStep } => {
    for (const candidate of [`${spec.role}:${spec.itemId}`, spec.role]) {
      const entry = steps.get(candidate);
      if (entry === undefined) continue;
      const index = used.get(candidate) ?? 0;
      used.set(candidate, index + 1);
      if (Array.isArray(entry)) {
        const list = entry as readonly AgentStep[];
        const step = list[Math.min(index, list.length - 1)];
        if (step === undefined) break;
        return { key: candidate, step };
      }
      return { key: candidate, step: entry as AgentStep };
    }
    throw new Error(
      `scriptedAgents has no step for ${spec.role} on ${spec.itemId}. Tried ` +
        `${spec.role}:${spec.itemId}, ${spec.role}. Add one — a default would let this test ` +
        'pass while the wrong role ran.',
    );
  };

  return {
    calls,
    roles: (): string[] => calls.map((call) => call.role),
    set: (key, step): void => {
      steps.set(key, step);
      used.delete(key);
    },
    run(spec: AgentRunSpec): Promise<AgentRunResult> {
      calls.push(spec);
      const { step } = resolve(spec);

      for (const [relative, contents] of Object.entries(step.write ?? {})) {
        const target = path.join(spec.cwd, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      }
      for (const relative of step.remove ?? []) {
        rmSync(path.join(spec.cwd, relative), { recursive: true, force: true });
      }
      step.then?.(spec.cwd);

      return Promise.resolve({
        ok: true,
        structured: step.structured,
        rawStructured: step.structured,
        costUsd: step.costUsd ?? 0.05,
        numTurns: 2,
        durationMs: 5,
        sessionId: `scripted-${spec.runId}`,
        terminalReason: 'completed',
        permissionDenials: [],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Canned payloads.
// ---------------------------------------------------------------------------

const BASE = { outcome: 'ok', escalate_reason: null } as const;

export function developerPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown: 'Added the helper and a test for it.',
    summary: 'Added a describe() helper to the calculator.',
    files_changed: ['src/calc.ts'],
    commit_message: 'feat(calc): add a describe helper',
    tests_added: ['src/calc.test.ts'],
    ...overrides,
  };
}

export function reviewerPayload(
  verdict: 'approve' | 'request_changes',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown: 'Reviewed the change.',
    verdict,
    findings:
      verdict === 'approve'
        ? []
        : [
            {
              file: 'src/calc.ts',
              line: 12,
              severity: 'major',
              message: 'describe() does not handle an unknown operation.',
            },
          ],
    ...overrides,
  };
}

export function qaPayload(
  verdict: 'pass' | 'fail',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown: 'Checked the acceptance criteria.',
    verdict,
    criteria_results: [
      {
        criterion: '`describe("add")` returns a string',
        result: verdict,
        evidence_command: 'npm test',
        evidence_output: verdict === 'pass' ? 'ok 4 tests' : 'not ok 1 describe',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reading git back.
// ---------------------------------------------------------------------------

/** Subjects on `branch`, newest first. */
export function commitSubjects(repoPath: string, branch: string): string[] {
  return rawGit(repoPath, ['log', '--format=%s', branch])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `<author name>|<committer name>` for each commit on `branch`, newest first. */
export function commitAuthors(repoPath: string, branch: string): string[] {
  return rawGit(repoPath, ['log', '--format=%an|%cn', branch])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Files a commit touched. */
export function commitFiles(repoPath: string, ref: string): string[] {
  return rawGit(repoPath, ['show', '--name-only', '--format=', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/** The whole message of a commit, including its trailers. */
export function commitMessageOf(repoPath: string, ref: string): string {
  return rawGit(repoPath, ['log', '-1', '--format=%B', ref]);
}

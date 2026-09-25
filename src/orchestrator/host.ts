/**
 * Starting an orchestrator: everything `factory start` does from startup
 * validation through `Orchestrator.start`, shared with the dashboard (plan
 * Phase 1).
 *
 * ============================================================================
 * VALIDATION HAPPENS BEFORE A RUNNER EXISTS
 * ============================================================================
 * The `Runner` is constructed **after** `validateStartup` passes, and that
 * ordering is the point of a test the plan moved here from Phase 4: a vault
 * whose `target_repo` has been deleted must fail with a clear message and
 * **spawn no agent process**. The test asserts it by injecting a Runner factory
 * that throws if it is ever called — which only proves anything while the
 * factory is invoked below the validation, not above it.
 *
 * Building the runner eagerly would still "work": validation would fail, the
 * command would exit non-zero, and nobody would notice that a CLI process had
 * been spawned first. That is exactly the class of failure this ordering is
 * here to make impossible.
 *
 * ============================================================================
 * AND IT REFUSES TO START A REAL RUNNER WITHOUT WORKTREES
 * ============================================================================
 * `vault-template/config.yml` ships `runner: claude-code` and the schema
 * defaults the same way, so a plain `factory init` produces a claude-code
 * vault. If nothing can provision an isolated worktree, `resolveWorkspace`
 * falls back to `config.target_repo` — the operator's real checkout.
 *
 * **Phase 8 has landed, so production is no longer in that state**:
 * `processDeps()` supplies `workspaceFactory`, which builds a real provider
 * over `src/git/worktree.ts` once the vault's config is known, and the refusal
 * below does not fire. It stays as the guard it always was. A `CliDeps` built
 * without either seam — a hand-assembled bag, or a future build that drops the
 * factory — refuses to run real agents rather than pointing them at the
 * operator's own files.
 *
 * That is not a cosmetic gap. The OS sandbox confines an agent's writes to its
 * **working directory** (ADR-003, spec §4.2), so with no worktree the kernel
 * write fence is drawn around the operator's actual working tree. The only
 * thing left between a `tl_plan` or `dl` agent and those files is the tool
 * list — and ADR-003 exists precisely to say that the tool list is not a
 * filesystem boundary. Fourteen probes established that.
 *
 * So this refuses, loudly and at startup, rather than per dispatch. A
 * per-dispatch refusal fails halfway through a feature, after the PM has
 * already been paid for. `deps.workspace` is the seam Phase 8 fills; supplying
 * it lifts the refusal and nothing else changes.
 */
import type { FactoryConfig } from '../config/schema.js';
import { describeFailures, validateStartup } from '../config/validate.js';
import type { StartupFailure } from '../config/validate.js';
import { ChildProcessGateRunner } from '../gates/runner.js';
import type { Git } from '../git/git.js';
import type { ReconcileReport } from '../git/reconcile.js';
import { EventLog } from '../log/events.js';
import type { EventSink } from '../log/events.js';
import { RunRegistry } from '../log/runs.js';
import { ClaudeCodeRunner } from '../runner/claudeCode.js';
import { DemoRunner } from '../runner/demo.js';
import { MockRunner } from '../runner/mock.js';
import type { Runner } from '../runner/types.js';
import { VaultPaths } from '../vault/paths.js';
import { MarkdownStorage } from '../vault/storage.js';
import type { Storage } from '../vault/storage.js';
import type { FeatureWorkspaceProvider, WorkspaceProvider } from './dispatchTypes.js';
import { Orchestrator } from './loop.js';
import type { CycleReport } from './loop.js';

/** What starting an orchestrator reads from its caller. `CliDeps` extends it. */
export interface OrchestratorHostDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => string;
  readonly runner?: Runner | ((config: FactoryConfig) => Runner);
  readonly workspace?: WorkspaceProvider;
  readonly workspaceFactory?: WorkspaceFactory;
  /** Overrides `DEMO_STEP_DELAY_MS` for a `runner: demo` vault, so a test need not wait it out. */
  readonly demoStepDelayMs?: number;
}

/**
 * Everything a build that can do git worktrees provides.
 *
 * One object rather than two seams because the two halves must share a git
 * handle and a worktree root. A `WorkspaceProvider` that put worktrees
 * somewhere a `reconcileWorktrees` did not look would leak every worktree it
 * ever made, and nothing would go red.
 */
export interface WorktreeCapability {
  readonly workspace: WorkspaceProvider;
  /** Loop step 5. */
  readonly reconcile: () => Promise<ReconcileReport>;
  /**
   * The same git handle, exposed (Phase 9).
   *
   * The dispatcher commits the Developer's work and diffs the ticket branch for
   * the reviewer, and it must do both against the repository the worktrees were
   * cut from. Building a second `ShellGit` here would work today and would be a
   * quiet trap the moment anything about the handle is configured.
   */
  readonly git: Git;
  /**
   * Where the post-merge gates run (Phase 10).
   *
   * Part of the same object for the same reason as `git`: it cuts a worktree
   * from the same repository, under the same salted root, and a second handle
   * would put it somewhere reconciliation does not look.
   */
  readonly featureWorkspace: FeatureWorkspaceProvider;
}

/** What `runStart` calls once it knows which vault it is running. */
export type WorkspaceFactory = (input: {
  readonly config: FactoryConfig;
  readonly paths: VaultPaths;
  readonly storage: Storage;
  readonly now: () => string;
  readonly events?: EventSink;
}) => WorktreeCapability;

export interface StartOrchestratorInput {
  readonly vaultPath: string;
  readonly config: FactoryConfig;
  readonly deps: OrchestratorHostDeps;
  /** Aborting it cancels the agent run in flight, as `shutdown()` does. */
  readonly signal?: AbortSignal;
  /** Wraps the event log once, before anything is handed it (the dashboard's tee, plan Phase 5). */
  readonly eventSinkWrapper?: (log: EventSink) => EventSink;
}

export type RunOptions = NonNullable<Parameters<Orchestrator['run']>[0]>;

export interface OrchestratorHandle {
  /** The sink every consumer was given: the event log, or the wrapper around it. */
  readonly events: EventSink;
  readonly stopRequested: boolean;
  run(options?: RunOptions): Promise<CycleReport[]>;
  requestStop(): void;
  /** Abort runs in flight, release the instance lock, close the event log. */
  shutdown(): Promise<void>;
}

/** Refused before the event log was opened or any runner was built. */
export class StartupRefused extends Error {
  /** What `validateStartup` found. Empty for the no-worktrees refusal. */
  readonly failures: readonly StartupFailure[];

  constructor(message: string, failures: readonly StartupFailure[] = []) {
    super(message);
    this.name = 'StartupRefused';
    this.failures = failures;
  }
}

export async function startOrchestrator(
  input: StartOrchestratorInput,
): Promise<OrchestratorHandle> {
  const { vaultPath, config, deps } = input;

  const failures = validateStartup({ vaultPath, config }, { env: deps.env });
  if (failures.length > 0) {
    throw new StartupRefused(describeFailures(failures), failures);
  }

  const paths = new VaultPaths(vaultPath);
  const storage = new MarkdownStorage(paths);

  // See the header note. Checked here, before the event log is opened and
  // before anything is spawned, so a refused start leaves the vault untouched.
  //
  // `deps.workspace` is a ready-made provider (a test's own directory);
  // `deps.workspaceFactory` builds the real one now that the vault and its
  // config are known. Neither present and a real runner asked for is the
  // refusal.
  const canProvision = deps.workspace !== undefined || deps.workspaceFactory !== undefined;
  if (config.runner !== 'mock' && !canProvision) {
    throw new StartupRefused(noWorktreesMessage(vaultPath, config));
  }

  const log = await EventLog.open(paths.eventLog(), { now: deps.now });
  // Pass `events`, never `log`, to anything below: a consumer given `log` would
  // write lines the dashboard never hears about (plan Phase 5).
  const events = input.eventSinkWrapper?.(log) ?? log;
  const runs = new RunRegistry(paths);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (input.signal?.aborted === true) controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });

  let orchestrator: Orchestrator;
  try {
    // Built after the event log so worktree creation, removal, and every refusal
    // to remove lands in `logs/orchestrator.jsonl` — reconciliation's decisions
    // are the ones a human most needs a record of, because the alternative
    // evidence is a directory that quietly is or is not there.
    const capability =
      deps.workspace !== undefined
        ? { workspace: deps.workspace, reconcile: undefined, git: undefined, featureWorkspace: undefined }
        : deps.workspaceFactory?.({ config, paths, storage, now: deps.now, events });

    // Only now. See the header note.
    const runner = makeRunner(config, deps, { events, runs });

    orchestrator = await Orchestrator.start({
      paths,
      config,
      storage,
      runner,
      events,
      runs,
      now: deps.now,
      signal: controller.signal,
      ...(capability?.workspace === undefined ? {} : { workspace: capability.workspace }),
      ...(capability?.reconcile === undefined ? {} : { reconcile: capability.reconcile }),
      // Phase 9. Supplied together: `canRunTicketLoop` needs both before a
      // ticket may leave `ready`, because a ticket that reached `in_progress`
      // with no way to commit or gate would advance no further, forever.
      ...(capability?.git === undefined ? {} : { git: capability.git, gates: new ChildProcessGateRunner() }),
      // Phase 10. A third member of the same family: it is what lets the merge
      // verify itself, and without it a ticket waits at `merge` rather than
      // landing an unverified commit on a shared branch (`canMergeTickets`).
      ...(capability?.featureWorkspace === undefined
        ? {}
        : { featureWorkspace: capability.featureWorkspace }),
    });
  } catch (error) {
    input.signal?.removeEventListener('abort', forwardAbort);
    await events.close();
    throw error;
  }

  return {
    events,
    get stopRequested(): boolean {
      return orchestrator.stopRequested;
    },
    run: (options) => orchestrator.run(options),
    requestStop: () => orchestrator.requestStop(),
    shutdown: async () => {
      controller.abort();
      await orchestrator.shutdown();
      await events.close();
    },
  };
}

/**
 * The refusal message.
 *
 * Three things, in order: what is missing, why that is dangerous rather than
 * merely incomplete, and the one edit that lets the operator make progress
 * today. A refusal that only says no leaves someone guessing whether they
 * mistyped something.
 */
export function noWorktreesMessage(vaultPath: string, config: FactoryConfig): string {
  const configFile = new VaultPaths(vaultPath).configFile();
  return [
    `refusing to start: this vault is set to \`runner: ${config.runner}\`, but nothing here can`,
    'provision the isolated git worktrees that spec §4.3 requires for the tl_plan, dl,',
    'code_reviewer and developer roles. Worktree provisioning lives in src/git/worktree.ts',
    '(Phase 8) and this CliDeps has neither a `workspace` provider nor a `workspaceFactory`',
    'wired to it. `processDeps()` supplies one, so the real binary never sees this message.',
    '',
    `Without a worktree those agents would run with a working directory of ${config.target_repo}`,
    '— your real checkout. The OS sandbox fences an agent to its working directory (ADR-003),',
    'so that fence would be drawn around your own files, and the only thing left between the',
    'agent and them would be the tool list. ADR-003 exists to record that the tool list is not',
    'a filesystem boundary.',
    '',
    'To run the pipeline now against canned agent output, set:',
    '',
    '    runner: "mock"',
    '',
    `in ${configFile}. To run real agents, start through the factory binary, or pass a`,
    '`workspaceFactory` (see `realWorktrees` in src/cli/deps.ts).',
  ].join('\n');
}

/**
 * `config.runner` decides which implementation runs (spec §11).
 *
 * `deps.runner` overrides both, and is how the "spawns no agent process" test
 * injects something that throws on use.
 */
function makeRunner(
  config: FactoryConfig,
  deps: OrchestratorHostDeps,
  sinks: { readonly events: EventSink; readonly runs: RunRegistry },
): Runner {
  if (deps.runner !== undefined) {
    return typeof deps.runner === 'function' ? deps.runner(config) : deps.runner;
  }
  if (config.runner === 'mock') {
    // A vault configured for the mock runner and given no fixtures has nothing
    // to replay. Failing every run as `schema` is the honest outcome: it stops
    // the pipeline visibly rather than advancing anything on a null payload.
    return new MockRunner({
      fallback: { failure: 'schema' },
      runs: sinks.runs,
      events: sinks.events,
    });
  }
  if (config.runner === 'demo') {
    return new DemoRunner({
      runs: sinks.runs,
      events: sinks.events,
      now: deps.now,
      ...(deps.demoStepDelayMs === undefined ? {} : { stepDelayMs: deps.demoStepDelayMs }),
    });
  }
  return new ClaudeCodeRunner({
    config,
    repoRoot: config.target_repo,
    runs: sinks.runs,
    events: sinks.events,
    now: deps.now,
  });
}

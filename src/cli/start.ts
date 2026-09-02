/**
 * `factory start [project] [--vault <p>] [--once]` (spec §6).
 *
 * Startup validation, then the instance lock, then the poll loop in the
 * foreground.
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
import { loadConfig } from '../config/load.js';
import { nodeResolveView, resolveVault } from '../config/resolve.js';
import type { FactoryConfig } from '../config/schema.js';
import { describeFailures, validateStartup } from '../config/validate.js';
import { ChildProcessGateRunner } from '../gates/runner.js';
import { EventLog } from '../log/events.js';
import { RunRegistry } from '../log/runs.js';
import { InstanceLockHeldError } from '../orchestrator/lock.js';
import { Orchestrator } from '../orchestrator/loop.js';
import type { CycleReport } from '../orchestrator/loop.js';
import { ClaudeCodeRunner } from '../runner/claudeCode.js';
import { MockRunner } from '../runner/mock.js';
import type { Runner } from '../runner/types.js';
import { VaultPaths } from '../vault/paths.js';
import { MarkdownStorage } from '../vault/storage.js';
import type { CliDeps } from './deps.js';
import { CliError } from './deps.js';

export interface StartOptions {
  readonly project?: string | undefined;
  readonly vault?: string | undefined;
  /** Run exactly one cycle and exit. Useful for a cron-driven factory and tests. */
  readonly once?: boolean | undefined;
  /** Stop after this many cycles. Tests use it; there is no CLI flag. */
  readonly maxCycles?: number | undefined;
}

export interface StartResult {
  readonly vault: string;
  readonly cycles: readonly CycleReport[];
}

export async function runStart(options: StartOptions, deps: CliDeps): Promise<StartResult> {
  const registry = await deps.registry.read();
  const resolution = resolveVault(
    { vaultFlag: options.vault, projectName: options.project },
    nodeResolveView(deps.cwd, registry),
  );

  const config = await loadConfig(resolution.vaultPath);

  const failures = validateStartup({ vaultPath: resolution.vaultPath, config }, { env: deps.env });
  if (failures.length > 0) {
    throw new CliError(describeFailures(failures));
  }

  const paths = new VaultPaths(resolution.vaultPath);
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
    throw new CliError(noWorktreesMessage(resolution.vaultPath, config));
  }

  const events = await EventLog.open(paths.eventLog(), { now: deps.now });
  const runs = new RunRegistry(paths);

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
  const controller = new AbortController();

  let orchestrator: Orchestrator;
  try {
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
    await events.close();
    if (error instanceof InstanceLockHeldError) throw new CliError(error.message);
    throw error;
  }

  const drain = (): void => {
    deps.err('Stopping — finishing the run in flight, then exiting.');
    orchestrator.requestStop();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);

  deps.out(`factory started on ${resolution.vaultPath} (pid ${process.pid})`);

  try {
    const maxCycles = options.once === true ? 1 : options.maxCycles;
    const cycles = await orchestrator.run({
      ...(maxCycles === undefined ? {} : { maxCycles }),
    });
    return { vault: resolution.vaultPath, cycles };
  } finally {
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    controller.abort();
    await orchestrator.shutdown();
    await events.close();
    deps.out('factory stopped');
  }
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
  deps: CliDeps,
  sinks: { readonly events: EventLog; readonly runs: RunRegistry },
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
  return new ClaudeCodeRunner({
    config,
    repoRoot: config.target_repo,
    runs: sinks.runs,
    events: sinks.events,
    now: deps.now,
  });
}

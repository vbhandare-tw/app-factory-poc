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
 * vault. Until Phase 8 builds `src/git/worktree.ts` there is nothing to
 * provision an isolated worktree, and `resolveWorkspace` would fall back to
 * `config.target_repo` — the operator's real checkout.
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

  // Only now. See the header note.
  // See the header note. Checked here, before the event log is opened and
  // before anything is spawned, so a refused start leaves the vault untouched.
  if (config.runner !== 'mock' && deps.workspace === undefined) {
    throw new CliError(noWorktreesMessage(resolution.vaultPath, config));
  }

  const paths = new VaultPaths(resolution.vaultPath);
  const storage = new MarkdownStorage(paths);
  const events = await EventLog.open(paths.eventLog(), { now: deps.now });
  const runs = new RunRegistry(paths);

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
      ...(deps.workspace === undefined ? {} : { workspace: deps.workspace }),
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
    `refusing to start: this vault is set to \`runner: ${config.runner}\`, but this build cannot`,
    'provision the isolated git worktrees that spec §4.3 requires for the tl_plan, dl,',
    'code_reviewer and developer roles. Worktree provisioning is Phase 8 (src/git/worktree.ts)',
    'and it is not built yet.',
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
    `in ${configFile}. To run real agents, finish Phase 8.`,
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

/**
 * The poll loop — spec §9, steps 1 to 10.
 *
 * Two steps are deliberately absent and marked in place below: step 5's
 * worktree reconciliation is Phase 8, and the `gates` and `merge` dispatch
 * arms of step 9 are Phases 9 and 10. Everything else is here.
 *
 * ============================================================================
 * WHY ONE CYCLE CAN ADVANCE SEVERAL ITEMS
 * ============================================================================
 * Spec §9 step 8 says "claim the top item — `max_parallel_devs: 1`, so exactly
 * one". That number is a limit on *concurrency*, not on how much a cycle may
 * get through. Dispatch here is sequential and awaited, so at most one agent is
 * ever in flight, and the cycle then moves on to the next actionable item.
 *
 * The difference matters. Plan Phase 7a requires that an escalation on one
 * feature does not stop the rest of the pipeline, and asserts it by watching a
 * second feature advance **in the same cycle**. A cycle that stopped after one
 * item could satisfy the letter of step 8 while quietly serialising the whole
 * factory behind whatever went wrong first.
 *
 * An item is dispatched at most once per cycle, and the actionable set is
 * recomputed between dispatches from what is actually on disk. That is what
 * keeps a cycle bounded: an item that stays actionable is picked up next cycle,
 * not spun on in this one.
 *
 * ============================================================================
 * NOTHING HERE THROWS BECAUSE ONE ITEM FAILED
 * ============================================================================
 * A malformed note is quarantined by the scan; a dispatch that throws is caught,
 * logged as `dispatch_failed`, and the cycle continues. Plan Section E item 9
 * is a hard rule, and the way it gets broken is not a missing try/catch around
 * the scan — it is an exception on some *other* path that aborts the cycle
 * before the healthy items get their turn.
 */
import { existsSync } from 'node:fs';

import type { FactoryConfig } from '../config/schema.js';
import { resolveActionable } from '../domain/dag.js';
import { rankWorkItems } from '../domain/schedule.js';
import type { WorkItem } from '../domain/schedule.js';
import type { WorkItemState } from '../domain/states.js';
import { canTransition } from '../domain/transitions.js';
import type { TicketNote } from '../domain/types.js';
import type { EventSink } from '../log/events.js';
import type { RunSink } from '../log/runs.js';
import type { Runner } from '../runner/types.js';
import { sweepOrphanTemps } from '../vault/atomic.js';
import type { VaultPaths } from '../vault/paths.js';
import type { Storage } from '../vault/storage.js';
import { claimVerdict, forceReleaseClaim } from './claim.js';
import type { LivenessCheck } from './lock.js';
import { defaultLiveness, InstanceLock } from './lock.js';
import { dispatchItem, refreshViews, roleForFeatureState } from './dispatch.js';
import type { Actionable, DispatchHooks, DispatchOutcome, WorkspaceProvider } from './dispatch.js';
import { scanVault } from './scan.js';
import type { VaultScan } from './scan.js';

/** Orphan `.tmp` files older than this are swept at startup (spec §7.3). */
export const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface OrchestratorOptions {
  readonly paths: VaultPaths;
  readonly config: FactoryConfig;
  readonly storage: Storage;
  readonly runner: Runner;
  readonly events?: EventSink;
  readonly runs?: RunSink;
  readonly now?: () => string;
  readonly pid?: number;
  readonly host?: string;
  readonly isAlive?: LivenessCheck;
  readonly hooks?: DispatchHooks;
  readonly workspace?: WorkspaceProvider;
  /** Cancels in-flight agent runs. `factory stop` triggers it. */
  readonly signal?: AbortSignal;
}

export interface CycleReport {
  readonly cycle: number;
  readonly killed: boolean;
  readonly features: number;
  readonly tickets: number;
  readonly quarantined: readonly string[];
  readonly expired: readonly string[];
  readonly dispatched: readonly DispatchOutcome[];
  readonly errors: readonly { readonly itemId: string; readonly error: string }[];
  readonly durationMs: number;
}

export class Orchestrator {
  readonly paths: VaultPaths;
  readonly config: FactoryConfig;
  readonly storage: Storage;
  readonly lock: InstanceLock;

  private readonly options: OrchestratorOptions;
  private readonly now: () => string;
  private readonly isAlive: LivenessCheck;
  private counter = 0;
  private cycles = 0;
  private stopping = false;
  /**
   * Malformed notes already reported, path → the reason last reported.
   *
   * A bad note stays bad. Emitting `note_malformed` from every scan would put
   * one line per re-scan in the log, then repeat the lot every poll interval
   * for as long as the factory runs — which buries everything else. Reported
   * once per file, again only if the reason changes, and forgotten when the
   * file stops being malformed so a re-broken note is reported afresh.
   */
  private readonly reportedMalformed = new Map<string, string>();

  private constructor(options: OrchestratorOptions, lock: InstanceLock) {
    this.options = options;
    this.paths = options.paths;
    this.config = options.config;
    this.storage = options.storage;
    this.lock = lock;
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.isAlive = options.isAlive ?? defaultLiveness;
  }

  get ownerId(): string {
    return this.lock.ownerId;
  }

  /**
   * Take the instance lock and clean up after whatever ran here last.
   *
   * The recovery work all happens here rather than in the first cycle, because
   * a restart after a crash has to undo three separate kinds of leftover before
   * anything is safe to claim: the dead instance's lock, its `.runs` entries,
   * and its item claims. Doing that inside `runCycle` would mean a caller that
   * only ever calls `runCycle` once behaves differently from one that loops.
   */
  static async start(options: OrchestratorOptions): Promise<Orchestrator> {
    const now = options.now ?? ((): string => new Date().toISOString());

    const lock = await InstanceLock.acquire(options.paths, {
      pollIntervalSec: options.config.poll_interval,
      now,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.events === undefined ? {} : { events: options.events }),
    });

    const orchestrator = new Orchestrator(options, lock);

    await sweepOrphanTemps(options.paths.root, ORPHAN_TEMP_MAX_AGE_MS, {
      now: Date.parse(now()),
    });

    // `.runs/<id>.json` entries whose process is gone (spec §12). Their runs
    // died with the orchestrator that spawned them.
    if (options.runs !== undefined && hasSweep(options.runs)) {
      for (const swept of await options.runs.sweep()) {
        await options.events?.emit({ type: 'run_swept', runId: swept.runId, pid: swept.pid });
      }
    }

    // Item claims held by an instance that no longer exists. Without this a
    // crash mid-dispatch strands its item for the full `lock_ttl`.
    const startupScan = await scanVault(options.storage, options.paths);
    await orchestrator.reportMalformed(startupScan);
    await orchestrator.expireClaims(startupScan);

    return orchestrator;
  }

  /** Ask the loop to finish the item it is on and then stop. */
  requestStop(): void {
    this.stopping = true;
  }

  get stopRequested(): boolean {
    return this.stopping;
  }

  /** Release the instance lock. Idempotent. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.lock.release();
  }

  /**
   * Poll until `factory stop`, `factory kill` or `maxCycles`.
   *
   * `sleep` is injected so a test can drive many cycles without waiting out a
   * real `poll_interval`.
   */
  async run(options: { maxCycles?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<
    CycleReport[]
  > {
    const sleep = options.sleep ?? defaultSleep;
    const reports: CycleReport[] = [];

    while (!this.stopping) {
      if (options.maxCycles !== undefined && reports.length >= options.maxCycles) break;
      reports.push(await this.runCycle());
      if (this.stopping) break;
      if (options.maxCycles !== undefined && reports.length >= options.maxCycles) break;
      await sleep(this.config.poll_interval * 1000);
    }

    return reports;
  }

  /** One pass of spec §9. */
  async runCycle(): Promise<CycleReport> {
    const startedMs = Date.now();
    this.cycles += 1;
    const cycle = this.cycles;
    await this.options.events?.emit({ type: 'cycle_started', cycle });

    // --- step 1: the kill switch --------------------------------------------
    if (this.killed()) {
      await this.options.events?.emit({ type: 'kill_switch', file: this.paths.killFile() });
      const report = this.emptyReport(cycle, true, startedMs);
      await this.finishCycle(report);
      return report;
    }

    // --- step 2: heartbeat ----------------------------------------------------
    await this.lock.heartbeat();

    // --- step 3: scan, quarantining anything unreadable -----------------------
    let scan = await this.scan();
    await this.reportMalformed(scan);

    // --- step 4: expire stale item claims -------------------------------------
    const expired = await this.expireClaims(scan);
    if (expired.length > 0) scan = await this.scan();

    // --- step 5: reconcile worktrees ------------------------------------------
    // Phase 8. There are no worktrees to reconcile in 7a, and a stub here would
    // read as done work.

    const dispatched: DispatchOutcome[] = [];
    const errors: { itemId: string; error: string }[] = [];
    /**
     * `<id>@<stage>` pairs already dispatched this cycle.
     *
     * Keyed on the stage as well as the id so an item can take **several**
     * steps in one cycle — `intake → refining`, then the PM run — which is how
     * a second feature manages to advance in the same cycle that another one
     * escalated. Keying on the id alone would cap every item at one step per
     * poll interval and make a five-step feature take five cycles.
     *
     * Repeating the *same* pair is the only thing this excludes, and that is
     * exactly the shape an infinite loop would have.
     */
    const attempted = new Set<string>();

    for (;;) {
      if (this.stopping) break;
      // Re-checked before every claim, not only at the top of the cycle:
      // `factory kill` must stop *new* claims immediately while whatever is
      // already running finishes (spec §9 step 1).
      if (this.killed()) {
        await this.options.events?.emit({ type: 'kill_switch', file: this.paths.killFile() });
        break;
      }

      // --- steps 6 and 7: the actionable set, ranked -------------------------
      const candidates = actionableItems(scan, this.config).filter(
        (item) => !attempted.has(`${item.id}@${item.stage}`),
      );
      if (candidates.length === 0) break;

      const ranked = rankWorkItems(
        candidates.map((item): WorkItem & { item: Actionable } => ({
          id: item.id,
          stage: item.stage,
          item,
        })),
      );
      const next = ranked[0];
      if (next === undefined) break;
      attempted.add(`${next.item.id}@${next.item.stage}`);

      // --- steps 8, 9 and 10: claim, dispatch, persist -----------------------
      try {
        dispatched.push(
          await dispatchItem(
            {
              paths: this.paths,
              config: this.config,
              storage: this.storage,
              runner: this.options.runner,
              now: this.now,
              ownerId: this.ownerId,
              nextCounter: () => (this.counter += 1),
              ...(this.options.events === undefined ? {} : { events: this.options.events }),
              ...(this.options.runs === undefined ? {} : { runs: this.options.runs }),
              ...(this.options.hooks === undefined ? {} : { hooks: this.options.hooks }),
              ...(this.options.workspace === undefined ? {} : { workspace: this.options.workspace }),
              ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
            },
            next.item,
            { tickets: scan.tickets.map((entry) => entry.note) },
          ),
        );
      } catch (error) {
        // One item blowing up must not take the cycle with it. This is the
        // catch that plan Section E item 9 actually depends on: the scan
        // already tolerates a bad note, and what is left to protect is every
        // *other* way a single item can throw.
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ itemId: next.id, error: message });
        await this.options.events?.emit({ type: 'dispatch_failed', itemId: next.id, error: message });
      }

      // Re-scanned after every dispatch so the next candidate is chosen from
      // what is on disk, not from a snapshot.
      scan = await this.scan();
    }

    // Views are regenerated after each transition; this catches the cycle that
    // transitioned nothing, so a fresh vault still gets both documents.
    if (dispatched.length === 0) await refreshViews(this);

    const report: CycleReport = {
      cycle,
      killed: false,
      features: scan.features.length,
      tickets: scan.tickets.length,
      quarantined: scan.quarantined.map((entry) => entry.path),
      expired,
      dispatched,
      errors,
      durationMs: Date.now() - startedMs,
    };
    await this.finishCycle(report);
    return report;
  }

  private async finishCycle(report: CycleReport): Promise<void> {
    await this.options.events?.emit({
      type: 'cycle_finished',
      cycle: report.cycle,
      dispatched: report.dispatched.length,
      quarantined: report.quarantined.length,
      errors: report.errors.length,
      durationMs: report.durationMs,
    });
  }

  private emptyReport(cycle: number, killed: boolean, startedMs: number): CycleReport {
    return {
      cycle,
      killed,
      features: 0,
      tickets: 0,
      quarantined: [],
      expired: [],
      dispatched: [],
      errors: [],
      durationMs: Date.now() - startedMs,
    };
  }

  private killed(): boolean {
    return existsSync(this.paths.killFile());
  }

  private scan(): Promise<VaultScan> {
    return scanVault(this.storage, this.paths);
  }

  /** Emit `note_malformed` for anything newly broken. See `reportedMalformed`. */
  private async reportMalformed(scan: VaultScan): Promise<void> {
    const seen = new Set<string>();

    for (const entry of scan.quarantined) {
      seen.add(entry.path);
      if (this.reportedMalformed.get(entry.path) === entry.reason) continue;
      this.reportedMalformed.set(entry.path, entry.reason);
      await this.options.events?.emit({
        type: 'note_malformed',
        path: entry.path,
        reason: entry.reason,
      });
    }

    for (const path of [...this.reportedMalformed.keys()]) {
      if (!seen.has(path)) this.reportedMalformed.delete(path);
    }
  }

  /** Loop step 4, plus the dead-owner rule that makes crash recovery work. */
  private async expireClaims(scan: VaultScan): Promise<string[]> {
    const released: string[] = [];
    const nowMs = Date.parse(this.now());

    const entries = [
      ...scan.features.map((entry) => ({ path: entry.path, front: entry.note.frontmatter })),
      ...scan.tickets.map((entry) => ({ path: entry.path, front: entry.note.frontmatter })),
    ];

    for (const entry of entries) {
      const verdict = claimVerdict(entry.front, {
        nowMs,
        lockTtlSec: this.config.lock_ttl,
        isAlive: this.isAlive,
        ownerId: this.ownerId,
      });
      if (!verdict.expired) continue;

      await forceReleaseClaim(this.storage, entry.path);
      released.push(entry.front.id);
      await this.options.events?.emit({
        type: 'claim_expired',
        itemId: entry.front.id,
        reason: verdict.reason,
      });
    }

    return released;
  }
}

/**
 * Loop step 6: everything the transition table says could move right now.
 *
 * Features first, in the four states Phase 7a owns; then tickets whose whole
 * `depends_on` set is `done`, via the DAG resolver. An item another instance
 * still holds is left out — claiming it would fail anyway, and trying wastes a
 * write.
 */
export function actionableItems(scan: VaultScan, config: FactoryConfig): Actionable[] {
  const items: Actionable[] = [];

  for (const entry of scan.features) {
    const front = entry.note.frontmatter;
    if (front.locked_by !== null) continue;

    const stage = front.status;
    const owned = stage === 'intake' || roleForFeatureState(stage) !== null;
    if (!owned) continue;

    items.push({
      kind: 'feature',
      id: front.id,
      path: entry.path,
      slug: front.slug,
      note: entry.note,
      stage,
    });
  }

  const tickets: TicketNote[] = scan.tickets.map((entry) => entry.note);
  const pathById = new Map(scan.tickets.map((entry) => [entry.note.frontmatter.id, entry.path]));

  /**
   * A ticket only moves while its feature is in `in_development`.
   *
   * Without this a ticket would leave `backlog` the moment the DL wrote it —
   * while the feature is still parked at the `after_ticket_breakdown`
   * checkpoint, waiting for a human to say the breakdown is right. The
   * checkpoint exists to stop work starting before that answer, and a ticket
   * quietly advancing behind it makes the pause decorative.
   */
  const developing = new Set(
    scan.features
      .filter((entry) => entry.note.frontmatter.status === 'in_development')
      .map((entry) => entry.note.frontmatter.slug),
  );

  for (const ready of resolveActionable(
    tickets.map((ticket) => ({
      id: ticket.frontmatter.id,
      status: ticket.frontmatter.status,
      depends_on: ticket.frontmatter.depends_on,
    })),
  )) {
    const note = tickets.find((ticket) => ticket.frontmatter.id === ready.id);
    const file = pathById.get(ready.id);
    if (note === undefined || file === undefined) continue;
    if (note.frontmatter.locked_by !== null) continue;
    if (!developing.has(note.frontmatter.feature)) continue;

    // The DAG says the dependencies are met; the transition table is still the
    // authority on whether the move is allowed at all (ADR-004's spirit: one
    // rulebook, consulted, not two that agree by coincidence).
    const verdict = canTransition(note, 'ready', 'orchestrator', { tickets, defaultMaxAttempts: config.max_attempts });
    if (!verdict.ok) continue;

    items.push({
      kind: 'ticket',
      id: note.frontmatter.id,
      path: file,
      slug: note.frontmatter.feature,
      note,
      stage: note.frontmatter.status as WorkItemState,
    });
  }

  return items;
}

interface Sweepable {
  sweep(): Promise<{ runId: string; pid: number | null }[]>;
}

function hasSweep(runs: RunSink): runs is RunSink & Sweepable {
  return typeof (runs as Partial<Sweepable>).sweep === 'function';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

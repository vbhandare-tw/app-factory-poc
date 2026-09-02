/**
 * The orchestrator event log (spec §12).
 *
 * One JSONL line per decision in `<vault>/logs/orchestrator.jsonl`. Line
 * buffered rather than batched for the same reason as the transcript: M7 tails
 * it, and a crash must not take the last few decisions with it.
 *
 * `FactoryEvent` is a closed union on purpose. Later phases add their own
 * members here rather than passing free-form objects, so this file stays the
 * catalogue of everything the factory can say about itself. A `Record<string,
 * unknown>` escape hatch would make that catalogue decorative within one phase.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { WriteStream } from 'node:fs';

import type { GateName } from '../domain/states.js';
import type { Role } from '../domain/roles.js';
// Type-only, and the one import here that points "up" a layer. `AttemptFailure`
// is the orchestrator's vocabulary for what a failure cost an item, and spec
// §12 requires that number to be logged; re-declaring the union here would let
// the two drift, which is exactly what this file's closed-union rule exists to
// prevent.
import type { AttemptFailure } from '../orchestrator/attempts.js';
import type { AgentFailure } from '../runner/types.js';

/** Events emitted by the runner and run registry (Phase 5). */
export type RunEvent =
  | {
      readonly type: 'run_started';
      readonly runId: string;
      readonly role: Role;
      readonly itemId: string;
      readonly attempt: number;
      readonly model: string;
      readonly pid: number | null;
      readonly logPath: string;
    }
  | {
      readonly type: 'run_finished';
      readonly runId: string;
      readonly role: Role;
      readonly ok: boolean;
      readonly failure?: AgentFailure;
      readonly costUsd: number;
      readonly numTurns: number;
      readonly durationMs: number;
      readonly terminalReason: string;
    }
  | {
      /** A stream line that was not parseable JSON. Skipped, never fatal. */
      readonly type: 'run_stream_malformed';
      readonly runId: string;
      readonly line: string;
    }
  | {
      readonly type: 'run_stderr';
      readonly runId: string;
      readonly text: string;
    }
  | {
      readonly type: 'run_killed';
      readonly runId: string;
      readonly signal: string;
      readonly reason: 'timeout' | 'aborted' | 'grace_expired';
      readonly pid: number | null;
    }
  | {
      /** A `.runs` entry left behind by a crashed orchestrator, removed at startup. */
      readonly type: 'run_swept';
      readonly runId: string;
      readonly pid: number | null;
    };

/**
 * Events emitted by the orchestrator loop, its locks and its claims (Phase 7a).
 *
 * Spec §12 asks for "one line per decision: cycle start, scan results, claim
 * (with the ranking rule that decided), transition, gate result, lock expiry,
 * escalation, cost". Everything below is one of those, plus the two that phase
 * 7a discovered it needed: a quarantined note, and a dispatch that threw.
 */
export type LoopEvent =
  | { readonly type: 'lock_acquired'; readonly file: string; readonly pid: number; readonly host: string }
  | {
      readonly type: 'lock_reclaimed';
      readonly file: string;
      readonly reason: string;
      readonly previousPid: number | null;
    }
  | { readonly type: 'cycle_started'; readonly cycle: number }
  | {
      readonly type: 'cycle_finished';
      readonly cycle: number;
      readonly dispatched: number;
      readonly quarantined: number;
      readonly errors: number;
      readonly durationMs: number;
    }
  | { readonly type: 'kill_switch'; readonly file: string }
  | {
      /** A note that would not parse, or whose frontmatter is not a work item. */
      readonly type: 'note_malformed';
      readonly path: string;
      readonly reason: string;
    }
  | { readonly type: 'claim_won'; readonly itemId: string; readonly ownerId: string }
  | { readonly type: 'claim_lost'; readonly itemId: string; readonly reason: string }
  | { readonly type: 'claim_expired'; readonly itemId: string; readonly reason: string }
  | { readonly type: 'claim_released'; readonly itemId: string; readonly ownerId: string }
  | {
      readonly type: 'item_transitioned';
      readonly itemId: string;
      readonly from: string;
      readonly to: string;
      readonly actor: string;
      readonly note?: string;
    }
  | {
      readonly type: 'item_paused';
      readonly itemId: string;
      readonly pauseReason: string;
      readonly detail: string;
      readonly resumeTo: string | null;
      readonly rejectTo: string | null;
    }
  | {
      readonly type: 'attempt_consumed';
      readonly itemId: string;
      readonly failure: AttemptFailure;
      readonly attempts: number;
      readonly maxAttempts: number;
    }
  | {
      /** A failure the orchestrator decided not to charge to the item. */
      readonly type: 'attempt_forgiven';
      readonly itemId: string;
      readonly failure: AgentFailure;
      readonly reason: string;
    }
  | {
      /**
       * A validated payload came back larger than `config.payload_warn_chars`.
       *
       * Emitted **after** the payload has been accepted and applied — it is a
       * warning about the next run, not a refusal of this one. See the config
       * key's own note for why size is worth watching: the CLI's
       * `StructuredOutput` mechanism fails at roughly 20,000 characters, and it
       * fails either totally or by silently degrading to a minimal payload that
       * still validates. Neither is visible from the outcome.
       */
      readonly type: 'payload_large';
      readonly itemId: string;
      readonly role: Role;
      readonly chars: number;
      readonly limitChars: number;
    }
  | {
      /**
       * A first schema failure, re-run in place with the validator's own words
       * injected into the prompt (plan Phase 7b, `src/orchestrator/attempts.ts`).
       *
       * `attempts` is deliberately **not** a field: the whole point is that the
       * number did not move. What a human needs from this line is what the
       * agent got wrong and how much the free re-run cost, so both are here.
       */
      readonly type: 'schema_retry';
      readonly itemId: string;
      readonly role: Role;
      readonly attempt: number;
      readonly issues: readonly string[];
      readonly costUsd: number;
    }
  | {
      readonly type: 'context_truncated';
      readonly itemId: string;
      readonly role: Role;
      readonly dropped: readonly string[];
    }
  | { readonly type: 'tickets_created'; readonly featureId: string; readonly ticketIds: readonly string[] }
  | {
      /**
       * A new breakdown replaced an earlier one, deleting its ticket notes.
       * Emitted with the ids that went, because the previous contents are then
       * only recoverable from git and a human needs to know to look.
       */
      readonly type: 'tickets_replaced';
      readonly featureId: string;
      readonly removed: readonly string[];
    }
  | { readonly type: 'cost_recorded'; readonly itemId: string; readonly costUsd: number; readonly totalUsd: number }
  | { readonly type: 'dispatch_failed'; readonly itemId: string; readonly error: string }
  | {
      /**
       * A repo-touching role was dispatched without a provisioned worktree.
       *
       * **This is a record, not a safeguard.** The safeguard is
       * `src/cli/start.ts`, which refuses to start a non-mock runner at all
       * while `deps.workspace` is absent. An event line nothing reads would
       * stop nothing. This exists so that a `MockRunner` cycle — where running
       * in the target repo is harmless because no child process is spawned —
       * still says in the log which runs happened before Phase 8 landed.
       */
      readonly type: 'workspace_unprovisioned';
      readonly itemId: string;
      readonly role: Role;
      readonly cwd: string;
    };

/**
 * Worktree lifecycle (Phase 8, spec §9 step 5, §10).
 *
 * Two of these are records of a **refusal to act**, and they matter more than
 * the ones that record an action. Reconciliation removing a worktree whose
 * ticket is genuinely mid-run destroys uncommitted agent work — agents never
 * commit (ADR-003), so the working tree is the only copy. When reconciliation
 * declines to remove something, that decision has to be visible, or the only
 * evidence of a near-miss is a directory nobody noticed.
 */
export type WorktreeEvent =
  | {
      readonly type: 'worktree_created';
      readonly path: string;
      readonly itemId: string;
      readonly branch: string;
    }
  | { readonly type: 'worktree_removed'; readonly path: string; readonly reason: string }
  | {
      /** Under our root, but no scanned ticket claims it. Left in place. */
      readonly type: 'worktree_unaccounted';
      readonly path: string;
      readonly detail: string;
    }
  | {
      /** Its ticket says orphan, but the tree holds uncommitted work. Left in place. */
      readonly type: 'worktree_retained_dirty';
      readonly path: string;
      readonly itemId: string;
      readonly status: string;
    }
  | {
      readonly type: 'feature_branch_created';
      readonly slug: string;
      readonly branch: string;
      readonly fromRef: string;
    }
  | {
      readonly type: 'worktrees_reconciled';
      readonly cycle: number;
      readonly kept: number;
      readonly created: number;
      readonly removed: number;
      readonly unaccounted: number;
      readonly retainedDirty: number;
      readonly failed: number;
    }
  | {
      /** Step 5 threw. The cycle continues; nothing else may depend on it. */
      readonly type: 'worktree_reconcile_failed';
      readonly cycle: number;
      readonly error: string;
    };

/**
 * Gates and the orchestrator's own commits (Phase 9, spec §8.2, §12, ADR-004).
 *
 * Spec §12 asks for a "gate result" line, and this is it — one per gate, plus a
 * verdict for the run. `commit_created` and `commit_refused` are here because
 * resolution A6 moved commits from the agent to the orchestrator: the event log
 * is now the only narrative record of who wrote git history and why, and
 * `commit_refused` in particular is the trace of an attempt that was spent
 * without producing anything.
 */
export type GateEvent =
  | {
      readonly type: 'gate_result';
      readonly itemId: string;
      readonly gate: GateName;
      readonly status: 'pass' | 'fail' | 'skipped';
      readonly exitCode: number;
      readonly durationMs: number;
      readonly logPath: string;
    }
  | {
      readonly type: 'gates_finished';
      readonly itemId: string;
      readonly attempt: number;
      readonly green: boolean;
      /** The commit the gates ran against — the ordering guarantee, logged. */
      readonly commitSha: string | null;
      readonly detail: string;
    }
  | {
      readonly type: 'commit_created';
      readonly itemId: string;
      readonly sha: string;
      readonly branch: string | null;
      readonly files: readonly string[];
      /** Ignored paths the agent produced, removed rather than committed. */
      readonly prunedIgnored: readonly string[];
    }
  | {
      readonly type: 'commit_refused';
      readonly itemId: string;
      readonly reason: string;
      readonly detail: string;
    };

/**
 * The ticket merge (Phase 10, spec §10, ADR-004).
 *
 * `merge_reverted` and `merge_revert_failed` are the two lines that matter most
 * here, and they exist because of the failure `src/orchestrator/merge.ts` is
 * shaped around: a merge commit cannot be un-merged by `git merge --abort`, so a
 * red post-merge gate has to move the feature branch back by force. That is the
 * only place in the system where a committed ref is rewound, and it must never
 * be something a human has to infer from a SHA that quietly changed.
 */
export type MergeEvent =
  | {
      readonly type: 'merge_started';
      readonly itemId: string;
      readonly into: string;
      readonly from: string;
      /** Where the feature branch was before, i.e. where a revert would put it. */
      readonly beforeSha: string;
    }
  | {
      readonly type: 'merge_completed';
      readonly itemId: string;
      readonly into: string;
      readonly from: string;
      readonly sha: string;
      readonly branchDeleted: boolean;
    }
  | {
      readonly type: 'merge_conflict';
      readonly itemId: string;
      readonly into: string;
      readonly from: string;
      readonly conflicts: readonly string[];
      readonly detail: string;
    }
  | {
      /** A merge that landed and was then undone, because its own gates failed. */
      readonly type: 'merge_reverted';
      readonly itemId: string;
      readonly branch: string;
      readonly toSha: string;
      readonly reason: string;
    }
  | {
      /** The revert itself failed: the feature branch still carries the bad merge. */
      readonly type: 'merge_revert_failed';
      readonly itemId: string;
      readonly branch: string;
      readonly toSha: string;
      readonly error: string;
    }
  | {
      /** Nothing was merged. The repository was not touched at all. */
      readonly type: 'merge_refused';
      readonly itemId: string;
      readonly detail: string;
    }
  | { readonly type: 'ticket_branch_deleted'; readonly itemId: string; readonly branch: string }
  | {
      /** The merge succeeded; tidying up after it did not. Never fatal. */
      readonly type: 'merge_cleanup_failed';
      readonly itemId: string;
      readonly detail: string;
    };

/**
 * Everything the factory can log.
 *
 * Later phases widen this union — `| FeatureCloseEvent | ...` — rather than
 * loosening the type.
 */
export type FactoryEvent = RunEvent | LoopEvent | WorktreeEvent | GateEvent | MergeEvent;

/** The written line: the event plus the timestamp the log adds. */
export type LoggedEvent = FactoryEvent & { readonly ts: string };

export interface EventSink {
  emit(event: FactoryEvent): Promise<void>;
  close(): Promise<void>;
}

export interface EventLogOptions {
  /** Injected so recorded times are deterministic in tests (as `CliDeps.now` is). */
  readonly now?: () => string;
}

export class EventLog implements EventSink {
  readonly path: string;
  private readonly stream: WriteStream;
  private readonly now: () => string;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, stream: WriteStream, now: () => string) {
    this.path = filePath;
    this.stream = stream;
    this.now = now;
  }

  static async open(filePath: string, options: EventLogOptions = {}): Promise<EventLog> {
    const resolved = path.resolve(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const stream = createWriteStream(resolved, { flags: 'a', encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
    return new EventLog(resolved, stream, options.now ?? ((): string => new Date().toISOString()));
  }

  emit(event: FactoryEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`event log ${this.path} is already closed`));
    }
    const line = `${JSON.stringify({ ts: this.now(), ...event })}\n`;
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/** In-memory sink for tests and for runners constructed without a vault. */
export class MemoryEventLog implements EventSink {
  readonly events: LoggedEvent[] = [];
  private readonly now: () => string;

  constructor(now: () => string = (): string => new Date().toISOString()) {
    this.now = now;
  }

  emit(event: FactoryEvent): Promise<void> {
    this.events.push({ ts: this.now(), ...event } as LoggedEvent);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  ofType<T extends FactoryEvent['type']>(type: T): Extract<LoggedEvent, { type: T }>[] {
    return this.events.filter((event) => event.type === type) as Extract<LoggedEvent, { type: T }>[];
  }
}

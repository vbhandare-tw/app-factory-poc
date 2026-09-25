/**
 * `runId → run` and `gateLogId → gate log`, replayed from `orchestrator.jsonl`
 * (plan A10). Recorded paths are untrusted: readers must `confine()` them.
 */
import { readFile } from 'node:fs/promises';

export interface RunRecord {
  readonly runId: string;
  readonly role: string;
  readonly itemId: string;
  readonly attempt: number;
  readonly model: string;
  readonly logPath: string;
  readonly startedAt: string | null;
  readonly finished: boolean;
  readonly ok: boolean | null;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
}

export interface GateLogRecord {
  /** `<itemId>:<gate>:<n>`, `n` counting that item's runs of that gate from 1. */
  readonly gateLogId: string;
  readonly itemId: string;
  readonly gate: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly logPath: string;
  readonly at: string | null;
}

type Fields = Record<string, unknown>;

export class RunIndex {
  private readonly runs = new Map<string, RunRecord>();
  private readonly gateLogs = new Map<string, GateLogRecord>();
  private readonly gateCounts = new Map<string, number>();

  /** A missing event log is an empty index. */
  static async load(eventLog: string): Promise<RunIndex> {
    let text: string;
    try {
      text = await readFile(eventLog, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new RunIndex();
      throw error;
    }
    return RunIndex.fromText(text);
  }

  /** `load`, plus the byte offset just past the last complete line: where a live tail picks up. */
  static async loadWithOffset(eventLog: string): Promise<{ index: RunIndex; offset: number }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(eventLog);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { index: new RunIndex(), offset: 0 };
      throw error;
    }
    const offset = bytes.lastIndexOf(0x0a) + 1;
    return { index: RunIndex.fromText(bytes.subarray(0, offset).toString('utf8')), offset };
  }

  static fromText(text: string): RunIndex {
    const index = new RunIndex();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        index.apply(JSON.parse(line));
      } catch {
        // A torn or hand-edited line is skipped; the rest of the log still counts.
      }
    }
    return index;
  }

  /** Ignores anything that is not a well-formed `run_started`, `run_finished` or `gate_result`. */
  apply(event: unknown): void {
    if (event === null || typeof event !== 'object') return;
    const e = event as Fields;
    switch (e['type']) {
      case 'run_started':
        this.applyStarted(e);
        return;
      case 'run_finished':
        this.applyFinished(e);
        return;
      case 'gate_result':
        this.applyGate(e);
        return;
      default:
        return;
    }
  }

  run(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  gateLog(gateLogId: string): GateLogRecord | undefined {
    return this.gateLogs.get(gateLogId);
  }

  allRuns(): RunRecord[] {
    return [...this.runs.values()];
  }

  byItem(itemId: string): { runs: RunRecord[]; gateLogs: GateLogRecord[] } {
    return {
      runs: [...this.runs.values()].filter((run) => run.itemId === itemId),
      gateLogs: [...this.gateLogs.values()].filter((log) => log.itemId === itemId),
    };
  }

  private applyStarted(e: Fields): void {
    const runId = nonEmpty(e['runId']);
    const role = nonEmpty(e['role']);
    const itemId = nonEmpty(e['itemId']);
    const logPath = nonEmpty(e['logPath']);
    const attempt = e['attempt'];
    if (runId === null || role === null || itemId === null || logPath === null) return;
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) return;

    // The run counter is per process, so a restarted orchestrator can reuse an id;
    // the newer run's metadata wins. Both point at the same appended log file.
    this.runs.delete(runId);
    this.runs.set(runId, {
      runId,
      role,
      itemId,
      attempt,
      model: typeof e['model'] === 'string' ? e['model'] : '',
      logPath,
      startedAt: typeof e['ts'] === 'string' ? e['ts'] : null,
      finished: false,
      ok: null,
      costUsd: null,
      durationMs: null,
    });
  }

  private applyFinished(e: Fields): void {
    const runId = nonEmpty(e['runId']);
    const existing = runId === null ? undefined : this.runs.get(runId);
    if (runId === null || existing === undefined) return;
    this.runs.set(runId, {
      ...existing,
      finished: true,
      ok: typeof e['ok'] === 'boolean' ? e['ok'] : null,
      costUsd: finite(e['costUsd']),
      durationMs: finite(e['durationMs']),
    });
  }

  private applyGate(e: Fields): void {
    const itemId = nonEmpty(e['itemId']);
    const gate = nonEmpty(e['gate']);
    const logPath = nonEmpty(e['logPath']);
    const status = nonEmpty(e['status']);
    if (itemId === null || gate === null || logPath === null || status === null) return;

    const key = `${itemId}:${gate}`;
    const n = (this.gateCounts.get(key) ?? 0) + 1;
    this.gateCounts.set(key, n);
    const gateLogId = `${key}:${n}`;
    this.gateLogs.set(gateLogId, {
      gateLogId,
      itemId,
      gate,
      status,
      exitCode: finite(e['exitCode']),
      durationMs: finite(e['durationMs']),
      logPath,
      at: typeof e['ts'] === 'string' ? e['ts'] : null,
    });
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The read API (tech spec §5, plan Phase 3). Transcripts and gate logs are
 * addressed by id through `RunIndex`; the client never sends a path.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

import type { VaultScope } from '../../cli/resolve.js';
import { buildStatusReport } from '../../cli/status.js';
import type { StartupFailure } from '../../config/validate.js';
import type { AnyNote } from '../../domain/types.js';
import { featureBranchName } from '../../git/paths.js';
import { GitCommandError } from '../../git/git.js';
import type { Git } from '../../git/git.js';
import { findItem } from '../../orchestrator/actions.js';
import { defaultLiveness, readInstanceLock } from '../../orchestrator/lock.js';
import type { LivenessCheck } from '../../orchestrator/lock.js';
import { scanVault } from '../../orchestrator/scan.js';
import type { VaultScan } from '../../orchestrator/scan.js';
import { collectNeedsHuman } from '../../orchestrator/views.js';
import { JsonlLineSplitter } from '../../runner/streamParse.js';
import { VaultPathError, VaultPaths } from '../../vault/paths.js';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  GATE_LOG_CAP_BYTES,
  TRANSCRIPT_PAGE_LINES,
} from '../constants.js';
import { summariseEvent } from '../labels.js';
import { HttpError, Router } from '../router.js';
import type { HandlerResult, ParsedRequest } from '../router.js';
import type { GateLogRecord, RunRecord } from '../runIndex.js';
import type { RunIndex } from '../runIndex.js';
import { parseHistory, splitSections } from '../sections.js';
import { confine } from '../security.js';
import { pageLines, toSteps } from '../transcriptView.js';

export type DashboardMode = 'hosted' | 'external' | 'stopped';

export interface LockView {
  readonly mode: DashboardMode;
  readonly pid: number | null;
  readonly heartbeatAt: string | null;
}

/** What the dashboard host knows beyond the lock file (plan Phase 4). */
export interface HostStatusView {
  readonly lastError: string | null;
  readonly startupFailures: readonly StartupFailure[];
  readonly stopping: boolean;
}

export interface ReadContext {
  readonly scope: VaultScope;
  readonly lockView: () => Promise<LockView>;
  readonly git: Pick<Git, 'logRange' | 'diffNumstat'>;
  readonly runIndex: RunIndex;
  readonly demo?: boolean;
  readonly nowMs?: () => number;
  readonly hostStatus?: () => HostStatusView;
}

const NO_HOST_STATUS: HostStatusView = { lastError: null, startupFailures: [], stopping: false };

export type ReadHandlers = Record<
  'state' | 'feature' | 'item' | 'itemRuns' | 'activeRuns' | 'transcript' | 'gateLog' | 'delivery' | 'activity',
  (req: ParsedRequest) => Promise<HandlerResult>
>;

const NO_TRANSCRIPT = 'no transcript for this run (it may not have started)';

/** A live PID is authoritative for `external`; heartbeat age never decides mode (plan A8). */
export async function readLockView(
  paths: VaultPaths,
  options: { readonly selfPid?: number; readonly isAlive?: LivenessCheck } = {},
): Promise<LockView> {
  const { record } = await readInstanceLock(paths.instanceLock());
  if (record === null) return { mode: 'stopped', pid: null, heartbeatAt: null };
  const selfPid = options.selfPid ?? process.pid;
  const isAlive = options.isAlive ?? defaultLiveness;
  const mode: DashboardMode = record.pid === selfPid ? 'hosted' : isAlive(record.pid) ? 'external' : 'stopped';
  return { mode, pid: record.pid, heartbeatAt: record.heartbeatAt };
}

export function readRouter(ctx: ReadContext): Router {
  const router = new Router();
  registerReadRoutes(router, ctx);
  return router;
}

export function registerReadRoutes(router: Router, ctx: ReadContext): void {
  const h = readHandlers(ctx);
  router.add('GET', '/api/state', h.state);
  router.add('GET', '/api/features/:slug', h.feature);
  router.add('GET', '/api/features/:slug/delivery', h.delivery);
  router.add('GET', '/api/items/:id', h.item);
  router.add('GET', '/api/items/:id/runs', h.itemRuns);
  router.add('GET', '/api/runs/active', h.activeRuns);
  router.add('GET', '/api/runs/:runId/transcript', h.transcript);
  router.add('GET', '/api/gate-logs/:gateLogId', h.gateLog);
  router.add('GET', '/api/activity', h.activity);
}

export function readHandlers(ctx: ReadContext): ReadHandlers {
  const { paths, storage } = ctx.scope;
  const nowMs = ctx.nowMs ?? Date.now;

  const findFeature = async (slug: string): Promise<{ scan: VaultScan; note: AnyNote }> => {
    const scan = await scanVault(storage, paths);
    const entry = scan.features.find((f) => f.note.frontmatter.slug === slug);
    if (entry === undefined || (await confine(entry.path, [paths.featuresDir()])) === null) {
      throw new HttpError(404, `no feature named ${JSON.stringify(slug)}`);
    }
    return { scan, note: entry.note };
  };

  return {
    async state() {
      const report = await buildStatusReport(ctx.scope.resolution);
      const scan = await scanVault(storage, paths);
      const parked = new Map(collectNeedsHuman(paths, scan).map((item) => [item.id, item]));
      const lock = await ctx.lockView();
      const cost = [...scan.features, ...scan.tickets].reduce((sum, e) => sum + e.note.frontmatter.cost_usd, 0);

      return ok({
        ...report,
        mode: lock.mode,
        ...(ctx.hostStatus?.() ?? NO_HOST_STATUS),
        lock: { pid: lock.pid, heartbeatAt: lock.heartbeatAt },
        demo: ctx.demo ?? false,
        killed: existsSync(paths.killFile()),
        totalCostUsd: Math.round(cost * 1e6) / 1e6,
        needs_human: report.needs_human.map((item) => {
          const extra = parked.get(item.id);
          return {
            ...item,
            kind: extra?.kind ?? null,
            resume_to: extra?.resume_to ?? null,
            reject_to: extra?.reject_to ?? null,
            paused_at: extra?.paused_at ?? null,
          };
        }),
      });
    },

    async feature(req) {
      const slug = safeParam(req, 'slug', 'feature slug');
      const { scan, note } = await findFeature(slug);
      const tickets = [];
      for (const entry of scan.ticketsBySlug.get(slug) ?? []) {
        if ((await confine(entry.path, [paths.featuresDir()])) === null) continue;
        const t = entry.note.frontmatter;
        tickets.push({
          id: t.id,
          title: t.title,
          status: t.status,
          ordinal: t.ordinal,
          depends_on: t.depends_on,
          pause_reason: t.pause_reason,
        });
      }
      const planFile = await confine(paths.techPlan(slug), [paths.featuresDir()]);
      return ok({
        ...noteView(note),
        tickets,
        techPlan: planFile === null ? null : await readFile(planFile, 'utf8'),
      });
    },

    async item(req) {
      const id = safeParam(req, 'id', 'item id');
      const found = findItem(await scanVault(storage, paths), id);
      if (found === null || (await confine(found.path, [paths.featuresDir()])) === null) {
        throw new HttpError(404, `no item with id ${JSON.stringify(id)}`);
      }
      return ok({ kind: found.kind, ...noteView(found.note) });
    },

    async itemRuns(req) {
      const id = safeParam(req, 'id', 'item id');
      const { runs, gateLogs } = ctx.runIndex.byItem(id);
      return ok({ runs: runs.map(runView), gateLogs: gateLogs.map(gateLogView) });
    },

    async activeRuns() {
      return ok({ runs: await readActiveRuns(paths, nowMs()) });
    },

    async transcript(req) {
      const run = ctx.runIndex.run(req.params['runId'] ?? '');
      const before = optionalInteger(req.query, 'before', 0);
      if (run === undefined) throw new HttpError(404, NO_TRANSCRIPT);
      const text = await readConfined(run.logPath, paths.logsDir());
      if (text === null) throw new HttpError(404, NO_TRANSCRIPT);

      const splitter = new JsonlLineSplitter();
      const lines = [...splitter.push(text), ...splitter.flush()];
      const page = pageLines(lines, before, TRANSCRIPT_PAGE_LINES);
      const lastLine = before === undefined ? lines.length : Math.min(before, lines.length);
      return ok({
        steps: toSteps(page),
        ...(req.query.get('raw') === '1' ? { rawLines: page } : {}),
        firstLine: lastLine - page.length,
        lastLine,
        totalLines: lines.length,
        finished: run.finished,
      });
    },

    async gateLog(req) {
      const log = ctx.runIndex.gateLog(req.params['gateLogId'] ?? '');
      const missing = new HttpError(404, 'no output recorded for this gate run');
      if (log === undefined) throw missing;
      const file = await confine(log.logPath, [paths.logsDir()]);
      if (file === null) throw missing;
      const bytes = await readFile(file).catch(() => null);
      if (bytes === null) throw missing;

      const omitted = Math.max(0, bytes.length - GATE_LOG_CAP_BYTES);
      const tail = bytes.subarray(omitted).toString('utf8');
      return {
        status: 200,
        text: omitted > 0 ? `[… ${omitted} earlier bytes omitted]\n${tail}` : tail,
        contentType: 'text/plain; charset=utf-8',
      };
    },

    async delivery(req) {
      const slug = safeParam(req, 'slug', 'feature slug');
      const { note } = await findFeature(slug);
      const front = note.frontmatter;
      const featureBranch =
        front.type === 'feature' && front.feature_branch !== null ? front.feature_branch : featureBranchName(slug);
      const baseBranch = ctx.scope.config.base_branch;
      try {
        const [commits, diffstat] = await Promise.all([
          ctx.git.logRange(baseBranch, featureBranch),
          ctx.git.diffNumstat(baseBranch, featureBranch),
        ]);
        return ok({
          baseBranch,
          featureBranch,
          commits,
          diffstat,
          gateResults: ctx.runIndex.byItem(front.id).gateLogs.map(gateLogView),
        });
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error;
        throw new HttpError(404, `the branch ${featureBranch} cannot be compared with ${baseBranch}`);
      }
    },

    async activity(req) {
      const limit = optionalInteger(req.query, 'limit', 1) ?? ACTIVITY_DEFAULT_LIMIT;
      if (limit > ACTIVITY_MAX_LIMIT) throw new HttpError(400, `limit must be at most ${ACTIVITY_MAX_LIMIT}`);
      let text: string;
      try {
        text = await readFile(paths.eventLog(), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ok({ events: [] });
        throw error;
      }

      const events: Record<string, unknown>[] = [];
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
        const event = parseEvent(lines[i] ?? '');
        if (event !== null) events.push({ ...event, summary: summariseEvent(event) });
      }
      return ok({ events });
    },
  };
}

function ok(json: unknown): HandlerResult {
  return { status: 200, json };
}

function safeParam(req: ParsedRequest, name: string, label: string): string {
  const value = req.params[name] ?? '';
  if (!VaultPaths.isSafeSegment(value)) throw new HttpError(400, `not a valid ${label}: ${JSON.stringify(value)}`);
  return value;
}

/** `undefined` when absent; 400 unless a whole number ≥ `min`. */
function optionalInteger(query: URLSearchParams, name: string, min: number): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new HttpError(400, `${name} must be a whole number of at least ${min}`);
  }
  return value;
}

async function readConfined(file: string, root: string): Promise<string | null> {
  const real = await confine(file, [root]);
  if (real === null) return null;
  return readFile(real, 'utf8').catch(() => null);
}

function noteView(note: AnyNote): Record<string, unknown> {
  const sections = splitSections(note.body);
  const history = sections.find((s) => s.heading === 'History');
  return {
    frontmatter: note.frontmatter,
    sections,
    history: history === undefined ? [] : parseHistory(history.markdown),
  };
}

function runView(run: RunRecord): Omit<RunRecord, 'logPath' | 'itemId'> {
  const { logPath: _path, itemId: _item, ...rest } = run;
  return rest;
}

function gateLogView(log: GateLogRecord): Omit<GateLogRecord, 'logPath' | 'itemId'> {
  const { logPath: _path, itemId: _item, ...rest } = log;
  return rest;
}

function parseEvent(line: string): ({ type: string } & Record<string, unknown>) | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record['type'] === 'string' ? (record as { type: string } & Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readActiveRuns(paths: VaultPaths, now: number): Promise<Record<string, unknown>[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.runsDir());
  } catch {
    return [];
  }

  const runs: Record<string, unknown>[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const runId = entry.slice(0, -'.json'.length);
    const empty = { runId, role: null, itemId: null, feature: null, attempt: null, pid: null, startedAt: null, elapsedMs: null };
    let file: string;
    try {
      file = paths.runFile(runId);
    } catch (error) {
      if (!(error instanceof VaultPathError)) throw error;
      continue;
    }
    try {
      const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : null;
      const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
      runs.push({
        runId,
        role: typeof record['role'] === 'string' ? record['role'] : null,
        itemId: typeof record['ticket'] === 'string' ? record['ticket'] : null,
        feature: typeof record['feature'] === 'string' ? record['feature'] : null,
        attempt: typeof record['attempt'] === 'number' ? record['attempt'] : null,
        pid: typeof record['pid'] === 'number' ? record['pid'] : null,
        startedAt,
        elapsedMs: Number.isNaN(started) ? null : Math.max(0, now - started),
      });
    } catch {
      runs.push(empty);
    }
  }
  return runs;
}

/**
 * Display formatting. The label tables and state orders mirror
 * src/dashboard/labels.ts and src/domain/states.ts (the browser cannot import
 * TypeScript); test/unit/dashboard-ui/format.test.ts fails if they drift.
 */

export const STAGE_LABELS = {
  intake: 'Intake',
  refining: 'Refining',
  planning: 'Planning',
  ticketing: 'Ticketing',
  in_development: 'In development',
  awaiting_feature_close: 'Final check',
  needs_human: 'Needs you',
  done: 'Done',
  blocked: 'Blocked',
  regression: 'Regression',
  pm_review: 'PM review',
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  gates: 'Checks',
  code_review: 'Review',
  qa: 'QA',
  merge: 'Merge',
};

export const ROLE_LABELS = {
  pm: 'Product Manager',
  tl_plan: 'Tech Lead',
  dl: 'Delivery Lead',
  developer: 'Developer',
  code_reviewer: 'Code Reviewer',
  qa: 'QA',
};

export const PAUSE_REASON_LABELS = {
  checkpoint: 'Waiting for review',
  escalation: 'Escalated',
  attempts_exhausted: 'Failed 3 times',
  timeout: 'Timed out',
  merge_conflict: 'Merge conflict',
  malformed_output: 'Malformed output',
};

export const TICKET_COLUMNS = [
  'backlog',
  'ready',
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
  'done',
  'needs_human',
];

export const FEATURE_STRIP = [
  'intake',
  'refining',
  'planning',
  'ticketing',
  'in_development',
  'awaiting_feature_close',
  'done',
];

export const TONES = ['waiting', 'failed', 'done', 'running', 'idle', 'neutral'];

const STAGE_TONES = {
  intake: 'idle',
  backlog: 'idle',
  ready: 'idle',
  refining: 'running',
  planning: 'running',
  ticketing: 'running',
  in_development: 'running',
  awaiting_feature_close: 'running',
  pm_review: 'running',
  in_progress: 'running',
  gates: 'running',
  code_review: 'running',
  qa: 'running',
  merge: 'running',
  needs_human: 'waiting',
  done: 'done',
  blocked: 'failed',
  regression: 'failed',
};

function lookup(table, key) {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

export function stageLabel(stage) {
  return lookup(STAGE_LABELS, stage) ?? String(stage ?? '');
}

export function roleLabel(role) {
  return lookup(ROLE_LABELS, role) ?? String(role ?? '');
}

export function pauseLabel(reason) {
  return lookup(PAUSE_REASON_LABELS, reason) ?? String(reason ?? '');
}

/** Who made a `## History` step: an agent role, the factory, or the person at the keyboard. */
export function actorLabel(actor) {
  if (actor === 'orchestrator') return 'Factory';
  if (actor === 'human') return 'You';
  return roleLabel(actor);
}

export function stageClass(stage) {
  return `tone-${lookup(STAGE_TONES, stage) ?? 'neutral'}`;
}

export function money(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function relativeTime(iso, nowMs = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Local wall-clock time for timelines, e.g. "24 Sep, 14:03:07". */
export function clockTime(iso) {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return String(iso ?? '');
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const RUN_ID = new RegExp(`^(.+)-(${Object.keys(ROLE_LABELS).join('|')})-a(\\d+)-\\d+$`);

/** `<itemId>-<role>-a<attempt>-<n>` (src/domain/ids.ts `runId`), or null. */
export function parseRunId(runId) {
  const m = RUN_ID.exec(String(runId ?? ''));
  return m === null ? null : { itemId: m[1], role: m[2], attempt: Number(m[3]) };
}

/**
 * Which strip step is lit, and whether it waits on you. A checkpoint parks a
 * feature at the stage before the one it resumes into (src/orchestrator/checkpoints.ts).
 */
export function stripPosition(status, resumeTo, pauseReason) {
  if (status !== 'needs_human') return { at: FEATURE_STRIP.indexOf(status), waiting: false };
  const next = FEATURE_STRIP.indexOf(resumeTo);
  if (next < 0) return { at: -1, waiting: true };
  return { at: pauseReason === 'checkpoint' ? next - 1 : next, waiting: true };
}

/** The `cwd` of a stream-json `system`/`init` line, or null. */
export function cwdFromInitLine(line) {
  try {
    const event = JSON.parse(String(line));
    return event?.type === 'system' && event.subtype === 'init' && typeof event.cwd === 'string' && event.cwd !== ''
      ? event.cwd
      : null;
  } catch {
    return null;
  }
}

const WORKTREE_PREFIX = /(?:\/[^\s/'"`]+)*\/\.factory-worktrees\/[^\s/'"`]+\/[^\s/'"`]+\//g;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Paths under the run's working directory, shown relative to it; without one, a factory worktree prefix is dropped. */
export function relativizePaths(text, cwd) {
  const out = String(text ?? '');
  if (typeof cwd !== 'string' || cwd === '') return out.replace(WORKTREE_PREFIX, '');
  const root = escapeRegExp(cwd.replace(/\/+$/, ''));
  return out.replace(new RegExp(`${root}/`, 'g'), '').replace(new RegExp(`${root}(?![\\w./-])`, 'g'), '.');
}

/** Bookkeeping events hidden from the feed unless "Show all activity" is on. */
export function isRoutineEvent(event) {
  switch (event?.type) {
    case 'claim_won':
    case 'claim_released':
    case 'cycle_started':
      return true;
    case 'worktrees_reconciled':
      return !(event.created > 0) && !(event.removed > 0);
    case 'cycle_finished':
      return !(event.dispatched > 0) && !(event.errors > 0) && !(event.quarantined > 0);
    case 'cost_recorded':
      return event.costUsd === 0;
    default:
      return false;
  }
}

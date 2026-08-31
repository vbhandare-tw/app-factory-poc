import {
  allDependenciesDone,
  allTicketsDone,
  gatesAllGreen,
  mergeVerified,
  refuse,
} from './guards.js';
import type { GuardResult, TransitionContext } from './guards.js';
import { ACTORS } from './roles.js';
import type { Actor } from './roles.js';
import type { FeatureState, TicketState, WorkItemState } from './states.js';
import type { AnyNote, FeatureNote, HistoryLine, IsoTimestamp, TicketNote } from './types.js';

export type { GuardResult, TransitionContext } from './guards.js';

export const HISTORY_HEADING = '## History';

/**
 * One row of the transition table.
 *
 * Everything the state machine allows is declared here as data, not scattered
 * through `if` statements in the orchestrator. If a move is not in this table,
 * it cannot happen.
 */
export interface TransitionRule<S extends string> {
  readonly from: S;
  readonly to: S;
  /** Who may cause this move. Recorded verbatim in `## History`. */
  readonly actors: readonly Actor[];
  readonly guard?: (note: AnyNote, ctx: TransitionContext) => GuardResult;
  readonly description: string;
}

const ORCHESTRATOR: readonly Actor[] = ['orchestrator'];
const HUMAN: readonly Actor[] = ['human'];
/** Anything may escalate: an agent that is stuck, or the orchestrator on a failure. */
const ANYONE: readonly Actor[] = ACTORS;

const asTicket = (note: AnyNote): TicketNote => note as TicketNote;
const asFeature = (note: AnyNote): FeatureNote => note as FeatureNote;

/** Ticket states an escalation may fire from — everything except the terminals. */
const TICKET_ESCALATABLE: readonly TicketState[] = [
  'backlog',
  'ready',
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
];

/** Where a human may send a paused ticket. `done` is not one of them. */
const TICKET_RESUMABLE: readonly TicketState[] = [
  'backlog',
  'ready',
  'in_progress',
  'gates',
  'code_review',
  'qa',
  'merge',
];

const FEATURE_ESCALATABLE: readonly FeatureState[] = [
  'intake',
  'refining',
  'planning',
  'ticketing',
  'in_development',
  'awaiting_feature_close',
];

const FEATURE_RESUMABLE: readonly FeatureState[] = [
  'refining',
  'planning',
  'ticketing',
  'in_development',
  'awaiting_feature_close',
];

export const TICKET_TRANSITIONS: readonly TransitionRule<TicketState>[] = [
  {
    from: 'backlog',
    to: 'ready',
    actors: ORCHESTRATOR,
    guard: (note, ctx) => allDependenciesDone(asTicket(note), ctx),
    description: 'Every dependency is done, so the ticket can be picked up.',
  },
  {
    from: 'ready',
    to: 'in_progress',
    actors: ORCHESTRATOR,
    description: 'Claimed and handed to a Developer agent.',
  },
  {
    from: 'in_progress',
    to: 'gates',
    actors: ORCHESTRATOR,
    description: 'The Developer exited and the orchestrator committed its work.',
  },
  {
    from: 'gates',
    to: 'code_review',
    actors: ORCHESTRATOR,
    guard: (note) => gatesAllGreen(asTicket(note)),
    description: 'Hard gate — tests, lint and build all passed (ADR-004).',
  },
  {
    from: 'gates',
    to: 'in_progress',
    actors: ORCHESTRATOR,
    description: 'A gate went red; the ticket bounces back to the Developer.',
  },
  {
    from: 'code_review',
    to: 'qa',
    actors: ['code_reviewer'],
    description: 'Reviewer verdict: approve.',
  },
  {
    from: 'code_review',
    to: 'in_progress',
    actors: ['code_reviewer'],
    description: 'Reviewer verdict: request_changes.',
  },
  {
    from: 'qa',
    to: 'merge',
    actors: ['qa'],
    description: 'QA verdict: pass.',
  },
  {
    from: 'qa',
    to: 'in_progress',
    actors: ['qa'],
    description: 'QA verdict: fail.',
  },
  {
    from: 'merge',
    to: 'done',
    actors: ORCHESTRATOR,
    guard: (note, ctx) => mergeVerified(asTicket(note), ctx),
    description: 'Merged --no-ff into the feature branch and the branch gates are green.',
  },
  ...TICKET_ESCALATABLE.map(
    (from): TransitionRule<TicketState> => ({
      from,
      to: 'needs_human',
      actors: ANYONE,
      description: 'Escalation, attempt limit, timeout, merge conflict or malformed output.',
    }),
  ),
  ...TICKET_RESUMABLE.map(
    (to): TransitionRule<TicketState> => ({
      from: 'needs_human',
      to,
      actors: HUMAN,
      description: 'factory approve / factory reject resolves the pause to resume_to / reject_to.',
    }),
  ),
];

export const FEATURE_TRANSITIONS: readonly TransitionRule<FeatureState>[] = [
  {
    from: 'intake',
    to: 'refining',
    actors: ORCHESTRATOR,
    description: 'Picked up for PM refinement.',
  },
  {
    from: 'refining',
    to: 'planning',
    actors: ORCHESTRATOR,
    description: 'PM finished and the after_pm_refinement checkpoint is disabled.',
  },
  {
    from: 'planning',
    to: 'ticketing',
    actors: ORCHESTRATOR,
    description: 'The TL produced a tech plan.',
  },
  {
    from: 'planning',
    to: 'refining',
    actors: ['tl_plan'],
    description: 'The TL asked for refinement; its questions go back to the PM.',
  },
  {
    from: 'ticketing',
    to: 'in_development',
    actors: ORCHESTRATOR,
    description: 'The DL produced tickets and the after_ticket_breakdown checkpoint is disabled.',
  },
  {
    from: 'in_development',
    to: 'awaiting_feature_close',
    actors: ORCHESTRATOR,
    guard: (note, ctx) => allTicketsDone(asFeature(note), ctx),
    description: 'Every ticket is done.',
  },
  {
    from: 'awaiting_feature_close',
    to: 'done',
    actors: HUMAN,
    description: 'Final acceptance approved: merged into base and tagged.',
  },
  {
    from: 'awaiting_feature_close',
    to: 'in_development',
    actors: HUMAN,
    description: 'Final acceptance rejected.',
  },
  ...FEATURE_ESCALATABLE.map(
    (from): TransitionRule<FeatureState> => ({
      from,
      to: 'needs_human',
      actors: ANYONE,
      description: 'A checkpoint fired, or an agent escalated.',
    }),
  ),
  ...FEATURE_RESUMABLE.map(
    (to): TransitionRule<FeatureState> => ({
      from: 'needs_human',
      to,
      actors: HUMAN,
      description: 'factory approve / factory reject resolves the pause.',
    }),
  ),
  {
    from: 'needs_human',
    to: 'done',
    actors: HUMAN,
    description: 'Final acceptance approved from the checkpoint pause.',
  },
];

export class TransitionError extends Error {
  readonly from: WorkItemState;
  readonly to: WorkItemState;
  readonly actor: Actor;

  constructor(from: WorkItemState, to: WorkItemState, actor: Actor, reason: string) {
    super(reason);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
    this.actor = actor;
  }
}

function rulesFor(note: AnyNote): readonly TransitionRule<WorkItemState>[] {
  return note.frontmatter.type === 'ticket'
    ? (TICKET_TRANSITIONS as readonly TransitionRule<WorkItemState>[])
    : (FEATURE_TRANSITIONS as readonly TransitionRule<WorkItemState>[]);
}

/**
 * Can `actor` move `note` to `to` right now?
 *
 * Pure: everything a guard needs arrives in `ctx`. Nothing here reads a clock,
 * a disk, or a global.
 */
export function canTransition(
  note: AnyNote,
  to: WorkItemState,
  actor: Actor,
  ctx: TransitionContext = {},
): GuardResult {
  const kind = note.frontmatter.type;
  const from = note.frontmatter.status as WorkItemState;

  const matching = rulesFor(note).filter((rule) => rule.from === from && rule.to === to);
  if (matching.length === 0) {
    return refuse(`no ${kind} transition ${from} → ${to}`);
  }

  const permitted = matching.filter((rule) => rule.actors.includes(actor));
  if (permitted.length === 0) {
    const allowed = [...new Set(matching.flatMap((rule) => [...rule.actors]))].join(', ');
    return refuse(`actor '${actor}' may not move a ${kind} ${from} → ${to}; allowed: ${allowed}`);
  }

  let firstRefusal: GuardResult | undefined;
  for (const rule of permitted) {
    if (rule.guard === undefined) return { ok: true };
    const result = rule.guard(note, ctx);
    if (result.ok) return result;
    firstRefusal ??= result;
  }
  return firstRefusal ?? refuse(`no rule permitted ${from} → ${to}`);
}

export interface ApplyTransitionOptions {
  /**
   * The transition timestamp, supplied by the caller.
   *
   * Required rather than defaulted so this function stays a pure function of
   * its arguments — the same inputs always produce the same note.
   */
  readonly now: IsoTimestamp;
  /** Free text recorded in the history line. */
  readonly note?: string;
  readonly ctx?: TransitionContext;
}

/**
 * Apply a transition, returning a **new** note.
 *
 * Persistence is the caller's job (ADR-002: the orchestrator is the only
 * writer). This function never touches the input note.
 */
export function applyTransition(
  note: TicketNote,
  to: TicketState,
  actor: Actor,
  options: ApplyTransitionOptions,
): TicketNote;
export function applyTransition(
  note: FeatureNote,
  to: FeatureState,
  actor: Actor,
  options: ApplyTransitionOptions,
): FeatureNote;
export function applyTransition(
  note: AnyNote,
  to: WorkItemState,
  actor: Actor,
  options: ApplyTransitionOptions,
): AnyNote {
  const from = note.frontmatter.status as WorkItemState;
  const verdict = canTransition(note, to, actor, options.ctx ?? {});
  if (!verdict.ok) {
    throw new TransitionError(from, to, actor, verdict.reason);
  }

  const line: HistoryLine = {
    timestamp: options.now,
    from,
    to,
    actor,
    note: options.note,
  };

  return {
    frontmatter: {
      ...note.frontmatter,
      status: to,
      updated_at: options.now,
    },
    body: appendHistoryLine(note.body, line),
  } as AnyNote;
}

/** `timestamp | from → to | actor | note`, always on a single line. */
export function formatHistoryLine(line: HistoryLine): string {
  const head = `${line.timestamp} | ${line.from} → ${line.to} | ${line.actor}`;
  const note = line.note?.replace(/\s*\r?\n\s*/g, ' ').trim();
  return note !== undefined && note.length > 0 ? `${head} | ${note}` : head;
}

const HISTORY_BULLET = '- ';
const HEADING_PATTERN = /^#{1,6}\s/;

/** Read back the history entries in a body, bullets stripped. */
export function historyLines(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === HISTORY_HEADING);
  if (start === -1) return [];

  const entries: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (HEADING_PATTERN.test(line)) break;
    if (line.startsWith(HISTORY_BULLET)) entries.push(line.slice(HISTORY_BULLET.length));
  }
  return entries;
}

/**
 * Append one entry to the `## History` section, creating the section if the
 * body does not have one yet. Everything else in the body is left alone.
 */
export function appendHistoryLine(body: string, line: HistoryLine): string {
  const entry = `${HISTORY_BULLET}${formatHistoryLine(line)}`;
  const lines = body.split('\n');
  const headingIndex = lines.findIndex((candidate) => candidate.trim() === HISTORY_HEADING);

  if (headingIndex === -1) {
    const trimmed = body.replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    return `${prefix}${HISTORY_HEADING}\n\n${entry}\n`;
  }

  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (HEADING_PATTERN.test(lines[index] ?? '')) {
      sectionEnd = index;
      break;
    }
  }

  let insertAt = sectionEnd;
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1;
  }

  const inserted =
    insertAt === headingIndex + 1 ? ['', entry] : [entry];

  return [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n');
}

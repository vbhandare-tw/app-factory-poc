import {
  allDependenciesDone,
  allTicketsDone,
  featureCloseVerified,
  gatesAllGreen,
  mergeVerified,
  refuse,
} from './guards.js';
import type { GuardResult, TransitionContext } from './guards.js';
import { findHeading, scanMarkdown, sectionEnd } from './markdown.js';
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
    // ========================================================================
    // THE AUTO-CLOSE ROUTE — `final_acceptance: false` (Phase 11)
    // ========================================================================
    // `ORCHESTRATOR` is here so that the **actor field tells the truth**. This
    // rule is only ever taken when the `final_acceptance` checkpoint is
    // switched off in config, and a disabled checkpoint is skipped entirely:
    // the feature never pauses and never touches `needs_human`, so the close
    // happens inside a dispatch with no person involved. Recording that as
    // `human` — which is what this rule forced before the actor was widened —
    // writes a false audit trail, and `actor` is the machine-readable field a
    // later query would trust.
    //
    // `HUMAN` is kept alongside it: a human taking this route still has to
    // satisfy the guard, which means a real merge and a real tag.
    //
    // **Widening this does not make the checkpoint decorative**, and the reason
    // is not in this table — see `featureCloseVerified` and
    // `src/orchestrator/featureClose.ts`. With the checkpoint *enabled* the
    // dispatcher pauses **before** any base-branch write, so the two facts this
    // rule's guard demands are never produced; and from the pause the only
    // route on the human takes *directly* is `needs_human → done`, which stays
    // human-only below.
    //
    // There is **one** case where this rule is taken with the checkpoint
    // enabled, and it records `human` when it is: a standing approval. A person
    // approved this feature, the base branch had moved before the merge could
    // happen, and `factory approve` recorded their answer and handed the
    // feature back to the loop to gate the base branch — see `approved_sha`.
    // The loop then closes on that approval, so a person really did take this
    // move and `human` is what the audit trail should say. It is honoured only
    // when it names the commit the gates have just verified.
    //
    // So the full set of routes out of the checkpoint pause is
    // `needs_human → done` (the human approves and the merge happens there) and
    // `needs_human → awaiting_feature_close → done` (the human approves, the
    // base branch had moved, the loop gates it and closes on their approval).
    // Both begin with a person; neither is reachable without one.
    //
    // **And that property does not rest on this table alone.** It rests on the
    // table *and* on `approved_sha` having exactly one non-null writer —
    // `recordStandingApproval`, reachable only from `factory approve`. Widening
    // the actor list here is safe because of both facts together, and a second
    // writer of `approved_sha` added later would break the guarantee without
    // changing a line of this file.
    actors: [...ORCHESTRATOR, ...HUMAN],
    guard: (note, ctx) => featureCloseVerified(asFeature(note), ctx),
    description:
      'Final acceptance: merged into base and tagged. Taken by the orchestrator when the ' +
      'final_acceptance checkpoint is disabled in config, and by the human when they have ' +
      'already approved this commit and the loop is completing that approval.',
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
    // ========================================================================
    // HUMAN-ONLY, AND THAT IS THE CHECKPOINT'S TABLE-LEVEL LOCK
    // ========================================================================
    // The route `factory approve` takes when it can merge there and then: the
    // `final_acceptance` checkpoint parks the feature here with
    // `resume_to: done`. Guarding only the rule above would leave the reachable
    // one wide open — see `featureCloseVerified`.
    //
    // **`ORCHESTRATOR` must never be added here.** The rule above was widened
    // in Phase 11 so that an auto-close records a truthful actor; this rule is
    // **part of** the reason that widening cannot make the human checkpoint
    // decorative. A feature parked at the checkpoint is waiting for a person,
    // and if the orchestrator could resolve that pause itself the approval the
    // checkpoint exists to demand would be optional.
    // `test/unit/domain/transitions.test.ts` pins it, and `featureClose.ts`
    // never asks for this transition at all.
    //
    // **It is not the whole reason, and it stopped being the whole reason when
    // the standing approval landed.** A feature can now leave this pause for
    // `awaiting_feature_close` and close from there — see the rule above. What
    // makes *that* route safe is not this table but `approved_sha` having
    // exactly one non-null writer, `recordStandingApproval`, which is reachable
    // only from `factory approve`. The checkpoint is non-decorative because of
    // the two facts together.
    actors: HUMAN,
    guard: (note, ctx) => featureCloseVerified(asFeature(note), ctx),
    description: 'Final acceptance approved from the checkpoint pause: merged into base and tagged.',
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

/**
 * Read back the history entries in a body, bullets stripped.
 *
 * Fence-aware via the shared scan: a `- ` line inside a fenced code block is
 * sample text, not a history entry, and a `## History` inside a fence is not
 * the History section.
 */
export function historyLines(body: string): string[] {
  const lines = body.split('\n');
  const scan = scanMarkdown(lines);
  const start = findHeading(lines, scan, HISTORY_HEADING);
  if (start === -1) return [];

  const end = sectionEnd(scan, start, lines.length);
  const entries: string[] = [];
  for (let index = start + 1; index < end; index += 1) {
    if (scan.fenced[index] === true) continue;
    const line = lines[index] ?? '';
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
  const scan = scanMarkdown(lines);
  const headingIndex = findHeading(lines, scan, HISTORY_HEADING);

  if (headingIndex === -1) {
    const trimmed = body.replace(/\s+$/, '');
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
    return `${prefix}${HISTORY_HEADING}\n\n${entry}\n`;
  }

  let insertAt = sectionEnd(scan, headingIndex, lines.length);
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1;
  }

  const inserted =
    insertAt === headingIndex + 1 ? ['', entry] : [entry];

  return [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n');
}

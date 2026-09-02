/**
 * Per-role effects: the agent's validated payload turned into a note update.
 *
 * One builder per role, each returning a `RoleEffect` — sections to append,
 * where the item goes, which actor moved it, side files to write, a bounce
 * instead of an advance. Nothing here writes to disk except the Developer's
 * commit, which `./commit.ts` performs; `./dispatch.ts` applies everything else
 * in its single note write.
 *
 * Split out of `./dispatch.ts`. The markdown helpers moved with it because
 * every one of them exists to render agent output into a `## ` section, which
 * is what these builders do; `./dispatch.ts` imports `notesSection` back for
 * the escalation path.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { SECTION } from '../agents/context.js';
import type {
  CodeReviewerOutput,
  DeveloperOutput,
  DlOutput,
  PmOutput,
  QaOutput,
  TlPlanOutput,
} from '../agents/schemas.js';
import { featureId as toFeatureId, ticketId as makeTicketId } from '../domain/ids.js';
import { fenceIfHeadings, fencedBlock } from '../domain/markdown.js';
import type { Role } from '../domain/roles.js';
import type { TicketState } from '../domain/states.js';
import type { TicketFrontmatter, TicketNote } from '../domain/types.js';
import { findWorktree } from '../git/worktree.js';
import { FRONTMATTER_ORDER } from '../vault/note.js';
import { appendToSection } from '../vault/storage.js';
import { commitAgentWork } from './commit.js';
import type { Actionable, DispatchDeps, RoleEffect, RunContext } from './dispatchTypes.js';

export async function effectFor(
  deps: DispatchDeps,
  item: Actionable,
  role: Role,
  structured: unknown,
  run: RunContext,
): Promise<RoleEffect> {
  switch (role) {
    case 'pm':
      return pmEffect(structured as PmOutput);
    case 'tl_plan':
      return tlPlanEffect(deps, item, structured as TlPlanOutput);
    case 'dl':
      return dlEffect(deps, item, structured as DlOutput, await readExistingTickets(deps, item.slug));
    case 'developer':
      return await developerEffect(deps, item, structured as DeveloperOutput, run);
    case 'code_reviewer':
      return codeReviewerEffect(item, structured as CodeReviewerOutput);
    case 'qa':
      return qaEffect(item, structured as QaOutput);
    default: {
      const unreachable: never = role;
      throw new Error(`no note-writing effect for role ${String(unreachable)}`);
    }
  }
}

function pmEffect(payload: PmOutput): RoleEffect {
  const refined = [
    sectionBody(payload.refined_requirement),
    bulletBlock('In scope', payload.scope_in),
    bulletBlock('Out of scope', payload.scope_out),
    bulletBlock('Questions for the Tech Lead', payload.questions_for_tl),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    sections: [
      [SECTION.refinedRequirement, refined],
      [SECTION.acceptanceCriteria, bullets(payload.acceptance_criteria)],
      ...notesSection(payload.notes_markdown),
    ],
    to: 'planning',
    actor: 'orchestrator',
    checkpoint: 'after_pm_refinement',
  };
}

/**
 * The Tech Lead's `notes_markdown` becomes `tech-plan.md`.
 *
 * `prompts/tl_plan.md` tells the agent so in as many words, and spec §5 and
 * §6.2 never say where `tech-plan.md` comes from. Writing it from anything else
 * would leave the TL instructed to put its plan in a field nobody reads, so the
 * prompt's contract is honoured here rather than rewritten. It is a full
 * overwrite at a fixed path, so a re-run after a crash rewrites it rather than
 * appending to a half-finished one.
 */
function tlPlanEffect(deps: DispatchDeps, item: Actionable, payload: TlPlanOutput): RoleEffect {
  const summary = [
    sectionBody(payload.feasibility),
    bulletBlock('Risks', payload.risks),
    bulletBlock('Phases', payload.phases),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  if (payload.request_refinement) {
    // Straight back to the PM. The questions go in `## Notes`, which is part of
    // the feature body every recipe injects, so the PM's next run reads them.
    const questions = [
      bulletBlock('The Tech Lead asked for refinement', payload.questions_for_pm),
      sectionBody(payload.notes_markdown),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    return {
      sections: [
        [SECTION.techPlan, summary],
        [SECTION.notes, questions],
      ],
      to: 'refining',
      actor: 'tl_plan',
      historyNote: 'the Tech Lead requested refinement',
    };
  }

  return {
    files: [[deps.paths.techPlan(item.slug), techPlanDocument(item, payload)]],
    sections: [[SECTION.techPlan, summary]],
    to: 'ticketing',
    actor: 'orchestrator',
  };
}

function techPlanDocument(item: Actionable, payload: TlPlanOutput): string {
  const header = `# Technical plan — ${item.note.frontmatter.title}\n\n` +
    `_Written by the Tech Lead agent for ${item.id}. The orchestrator wrote this file; ` +
    'the next write overwrites it._\n\n';
  return `${header}${payload.notes_markdown.trim()}\n`;
}

/**
 * The ticket files already sitting under a feature.
 *
 * Enumerated as **files**, not through `listTickets`, for two reasons. A ticket
 * note a human broke in Obsidian would make `listTickets` throw, and it is
 * precisely the file most likely to be left behind by a replacement that only
 * knew about the notes it could parse. And a leftover whose id the new
 * breakdown does not reproduce has to be found by its path, because there is
 * nothing else left to find it by.
 */
interface ExistingTickets {
  /** Every `.md` under the feature's tickets directory. */
  readonly files: readonly string[];
  /** The ones that parsed, by id. */
  readonly byId: ReadonlyMap<string, TicketNote>;
  /** Ids of tickets that have left `backlog` — real work, not a draft. */
  readonly started: readonly string[];
}

async function readExistingTickets(
  deps: DispatchDeps,
  slug: string,
): Promise<ExistingTickets> {
  const directory = deps.paths.ticketsDir(slug);

  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { files: [], byId: new Map(), started: [] };
    }
    throw error;
  }

  const files = names.map((name) => path.join(directory, name));
  const byId = new Map<string, TicketNote>();
  const started: string[] = [];

  for (const file of files) {
    let note: TicketNote;
    try {
      note = await deps.storage.readNote<TicketFrontmatter>(file);
    } catch {
      // Unparseable. It is still deleted along with the rest — leaving it would
      // leave an orphan the scan quarantines every cycle forever — but it
      // cannot be inspected, so it counts towards nothing below.
      continue;
    }
    byId.set(note.frontmatter.id, note);
    if (note.frontmatter.status !== 'backlog') started.push(note.frontmatter.id);
  }

  started.sort();
  return { files, byId, started };
}

/**
 * Turn the DL's payload into ticket notes.
 *
 * `depends_on` in the payload carries ticket **titles**, not ids, because real
 * ids do not exist until this function assigns them (Phase 6 ledger row). The
 * schema already guarantees titles are unique within the payload and that every
 * dependency names one of them, so the mapping below can rely on that and on
 * nothing else — a title it cannot resolve is a bug in the schema, not
 * something to paper over.
 *
 * Ordinals start at 1 **for the payload**, so the same payload always produces
 * the same ids at the same paths. A crash after two of four tickets were
 * written is repaired by the re-run overwriting all four, rather than appending
 * four more with fresh ordinals.
 *
 * ============================================================================
 * A BREAKDOWN REPLACES THE PREVIOUS BREAKDOWN WHOLE
 * ============================================================================
 * The DL runs more than once. A crash re-runs it, and so does `factory reject`
 * at the `after_ticket_breakdown` checkpoint — which is the point of that
 * checkpoint, and the second time the payload is deliberately *different*.
 *
 * Overwriting by id alone is not enough there. A new breakdown with three
 * tickets where the old had four leaves T004 on disk: nothing deletes it, the
 * DAG still sees it, and once the feature reaches `in_development` it becomes
 * schedulable work whose `depends_on` points at a plan nobody is building.
 * Nothing throws, and the only symptom is a ticket the human does not
 * recognise. So every existing ticket file goes, and the new breakdown is
 * written in its place.
 *
 * Two things temper that:
 *
 * - **A ticket that has left `backlog` is real work**, and replacing it would
 *   throw away a branch, a worktree, gate results and an attempt history.
 *   There is no transition into `ticketing` from `in_development`, so finding
 *   one means something is wrong that an orchestrator should not resolve on
 *   its own. It refuses and asks a human.
 * - **A human's own frontmatter keys are carried across** for any ticket the
 *   new breakdown reproduces. `Note<T>` has no slot for them, and this phase's
 *   whole invariant is that they survive a write; a replacement that silently
 *   dropped `owner:` would break that invariant on the one path the
 *   unknown-key test did not walk. Body edits are not carried — the body *is*
 *   the breakdown being replaced — and the replacement is recorded in the
 *   feature's `## Notes` and as a `tickets_replaced` event so a human can find
 *   the old content in git rather than discovering the loss later.
 */
function dlEffect(
  deps: DispatchDeps,
  item: Actionable,
  payload: DlOutput,
  existing: ExistingTickets,
): RoleEffect {
  const featureIdentifier = toFeatureId(item.slug);
  const now = deps.now();

  if (existing.started.length > 0) {
    return refusal(
      `refusing to replace the ticket breakdown for ${item.id}: ` +
        `${existing.started.join(', ')} ${existing.started.length === 1 ? 'has' : 'have'} already ` +
        'left backlog, and a new breakdown would delete work that has started — its branch, its ' +
        'gate results and its attempt history. Move those tickets back to backlog, or delete ' +
        'them, and approve this item to re-run the Delivery Lead.',
    );
  }

  const idByTitle = new Map<string, string>();
  payload.tickets.forEach((ticket, index) => {
    idByTitle.set(ticket.title.trim(), makeTicketId(featureIdentifier, index + 1));
  });

  const tickets: TicketNote[] = payload.tickets.map((ticket, index) => {
    const id = makeTicketId(featureIdentifier, index + 1);
    const dependsOn = ticket.depends_on.map((title) => {
      const resolved = idByTitle.get(title.trim());
      if (resolved === undefined) {
        throw new Error(
          `ticket ${JSON.stringify(ticket.title)} depends on ${JSON.stringify(title)}, which is ` +
            'not a title in this payload. The DL schema is supposed to make that impossible.',
        );
      }
      return resolved;
    });

    // A fresh breakdown, so the body and every known field come from the
    // payload. The one thing carried across from a ticket this replaces is a
    // human's own frontmatter keys — see the header note.
    const carried = carriedKeys(existing.byId.get(id));

    const frontmatter: TicketFrontmatter = {
      type: 'ticket',
      id,
      title: ticket.title.trim(),
      status: 'backlog' satisfies TicketState,
      feature: item.slug,
      ordinal: index + 1,
      depends_on: dependsOn,
      attempts: 0,
      max_attempts: null,
      cost_usd: 0,
      branch: null,
      worktree: null,
      gate_results: null,
      created_at: now,
      updated_at: now,
      locked_by: null,
      locked_at: null,
      pause_reason: null,
      pause_detail: null,
      resume_to: null,
      reject_to: null,
      paused_at: null,
      ...carried,
    };

    let body = '';
    body = appendToSection(body, SECTION.rawRequirement, sectionBody(ticket.description_md));
    body = appendToSection(body, SECTION.acceptanceCriteria, bullets(ticket.acceptance_criteria));
    if (ticket.technical_notes_md.trim().length > 0) {
      body = appendToSection(body, SECTION.techPlan, sectionBody(ticket.technical_notes_md));
    }

    return { frontmatter, body };
  });

  const replaced = [...existing.byId.keys()].sort();
  const notes = [
    payload.notes_markdown.trim(),
    replaced.length === 0
      ? ''
      : `_The orchestrator replaced a previous breakdown: ${replaced.join(', ')}. ` +
        'Their previous contents are in git history._',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    tickets,
    removeTicketFiles: existing.files,
    sections: notesSection(notes),
    to: 'in_development',
    actor: 'orchestrator',
    checkpoint: 'after_ticket_breakdown',
  };
}

function refusal(detail: string): RoleEffect {
  return { refuse: detail, sections: [], to: 'needs_human', actor: 'orchestrator' };
}

/**
 * A replaced ticket's unknown frontmatter keys — the ones `Note<T>` has no slot
 * for, which is exactly why they need naming explicitly here.
 *
 * `FRONTMATTER_ORDER` is the full set of keys the domain knows about, so
 * anything outside it was put there by a human.
 */
function carriedKeys(previous: TicketNote | undefined): Record<string, unknown> {
  if (previous === undefined) return {};
  const known = new Set<string>(FRONTMATTER_ORDER);
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous.frontmatter as unknown as Record<string, unknown>)) {
    if (known.has(key)) continue;
    carried[key] = value;
  }
  return carried;
}

/**
 * The Developer's output, applied.
 *
 * The agent's `outcome: 'ok'` gets it exactly this far: a commit, and a gate run
 * queued behind it. Nothing here reads the agent's opinion of whether the work
 * is correct, and there is nowhere for that opinion to be read — the only route
 * out of `gates` is `gatesAllGreen` (spec §5 rule 2, ADR-004).
 *
 * The commit happens **inside the effect**, before the note write, for the same
 * reason `tech-plan.md` is written there: it is a side effect at a deterministic
 * location that a re-run repeats safely. A crash between the commit and the note
 * write leaves the ticket in `in_progress` with a commit on its branch; the
 * re-run's snapshot then sees a clean tree, finds nothing to commit, and reports
 * a failed attempt — which is wrong-ish but safe, and is why `after_run` is a
 * crash point the recovery tests exercise.
 */
async function developerEffect(
  deps: DispatchDeps,
  item: Actionable,
  payload: DeveloperOutput,
  run: RunContext,
): Promise<RoleEffect> {
  const ticket = item.note as TicketNote;
  const attempt = run.attempt ?? ticket.frontmatter.attempts + 1;
  const notes = implementationNotes(payload);

  const git = deps.git;
  const snapshot = run.snapshot;
  if (git === undefined || snapshot === undefined) {
    // Unreachable through `handleTicket`, which checks both. Stated as a refusal
    // rather than a throw so that if it ever *is* reached, a human is told the
    // ticket was not committed instead of seeing a stack trace in the event log.
    return refusal(
      `refusing to advance ${item.id}: the Developer ran, but this dispatcher has no git handle, ` +
        'so its work could not be committed and the gates would have nothing to verify.',
    );
  }

  const outcome = await commitAgentWork({
    git,
    snapshot,
    proposedMessage: payload.commit_message,
    ticketId: item.id,
    ticketTitle: ticket.frontmatter.title,
    attempt,
  });

  if (!outcome.ok) {
    await deps.events?.emit({
      type: 'commit_refused',
      itemId: item.id,
      reason: outcome.reason,
      detail: outcome.detail,
    });

    return {
      sections: [[SECTION.implementationNotes, notes], ...notesSection(payload.notes_markdown)],
      // A same-state bounce: `in_progress → in_progress` is not in the
      // transition table and must not be invented here. `applyBounce` writes the
      // attempt count without a transition when `to` equals the current state.
      to: 'in_progress',
      actor: 'orchestrator',
      bounce: {
        failure: outcome.reason === 'no_changes' ? 'no_changes' : 'commit_failed',
        to: 'in_progress',
        actor: 'orchestrator',
        detail: outcome.detail,
      },
    };
  }

  await deps.events?.emit({
    type: 'commit_created',
    itemId: item.id,
    sha: outcome.sha,
    branch: run.workspaceCwd === undefined ? null : await branchOf(deps, run.workspaceCwd),
    files: outcome.files,
    prunedIgnored: outcome.prunedIgnored,
  });

  const pruned =
    outcome.prunedIgnored.length === 0
      ? ''
      : `\n\n_The orchestrator removed files this repository ignores before running the gates, ` +
        `so the gates see what the commit says: ${outcome.prunedIgnored.join(', ')}._`;

  return {
    sections: [
      [SECTION.implementationNotes, `${notes}\n\nCommit \`${outcome.sha}\`.${pruned}`],
      ...notesSection(payload.notes_markdown),
    ],
    frontmatter: {
      ...(run.workspaceCwd === undefined ? {} : { worktree: run.workspaceCwd }),
      branch:
        run.workspaceCwd === undefined
          ? ticket.frontmatter.branch
          : await branchOf(deps, run.workspaceCwd),
      // Cleared deliberately. A previous attempt's green results sitting on a
      // ticket that is on its way *back* into `gates` is the one piece of state
      // that could let a crashed gate run look like a passed one.
      gate_results: null,
    },
    to: 'gates',
    actor: 'orchestrator',
    historyNote: `committed ${outcome.sha.slice(0, 8)} (${String(outcome.files.length)} file(s))`,
  };
}

/** The branch git says a worktree is on. Authoritative, rather than re-derived. */
async function branchOf(deps: DispatchDeps, worktreePath: string): Promise<string | null> {
  if (deps.git === undefined) return null;
  const found = await findWorktree(deps.git, worktreePath);
  return found?.branch ?? null;
}

function implementationNotes(payload: DeveloperOutput): string {
  return [
    sectionBody(payload.summary),
    bulletBlock('Files changed', payload.files_changed),
    bulletBlock('Tests added', payload.tests_added),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * The Code Reviewer's verdict, applied.
 *
 * The findings are written whichever way the verdict went. An approval carrying
 * `minor` and `nit` findings is normal and useful — the schema only forbids an
 * approval over a `blocker` or `major` — and a reviewer's remarks are worth
 * keeping next to the ticket even when nothing bounced.
 */
function codeReviewerEffect(item: Actionable, payload: CodeReviewerOutput): RoleEffect {
  const findings = renderFindings(payload.findings);
  const sections: Array<readonly [string, string]> = [
    [SECTION.reviewNotes, findings],
    ...notesSection(payload.notes_markdown),
  ];

  if (payload.verdict === 'approve') {
    return { sections, to: 'qa', actor: 'code_reviewer', historyNote: 'review: approve' };
  }

  const blocking = payload.findings.filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  ).length;

  return {
    sections,
    to: 'in_progress',
    actor: 'code_reviewer',
    historyNote: 'review: request_changes',
    bounce: {
      failure: 'review_changes',
      to: 'in_progress',
      actor: 'code_reviewer',
      detail:
        `the Code Reviewer requested changes on ${item.id}: ` +
        `${String(payload.findings.length)} finding(s), ${String(blocking)} blocking. ` +
        'The findings are in the ticket’s Review Notes.',
    },
  };
}

function renderFindings(findings: CodeReviewerOutput['findings']): string {
  if (findings.length === 0) return 'No findings.';
  return findings
    .map((finding) => {
      const where = finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`;
      return `- **${finding.severity}** \`${where}\` — ${finding.message.replace(/\s*\r?\n\s*/g, ' ').trim()}`;
    })
    .join('\n');
}

/** QA's verdict, applied. Same shape as the reviewer's; the evidence differs. */
function qaEffect(item: Actionable, payload: QaOutput): RoleEffect {
  const evidence = renderCriteria(payload.criteria_results);
  const sections: Array<readonly [string, string]> = [
    [SECTION.qaNotes, evidence],
    ...notesSection(payload.notes_markdown),
  ];

  if (payload.verdict === 'pass') {
    return { sections, to: 'merge', actor: 'qa', historyNote: 'qa: pass' };
  }

  const failed = payload.criteria_results.filter((entry) => entry.result === 'fail');
  return {
    sections,
    to: 'in_progress',
    actor: 'qa',
    historyNote: 'qa: fail',
    bounce: {
      failure: 'qa_fail',
      to: 'in_progress',
      actor: 'qa',
      detail:
        `QA failed ${item.id}: ${String(failed.length)} of ` +
        `${String(payload.criteria_results.length)} criteria did not pass. The evidence is in ` +
        'the ticket’s QA Notes.',
    },
  };
}

function renderCriteria(results: QaOutput['criteria_results']): string {
  if (results.length === 0) return 'QA recorded no criteria.';
  return results
    .map((entry) => {
      const head = `- **${entry.result}** — ${entry.criterion.replace(/\s*\r?\n\s*/g, ' ').trim()}`;
      const command = entry.evidence_command.trim();
      const output = entry.evidence_output.trim();
      if (command === '' && output === '') return head;
      const body = [command === '' ? '' : `$ ${command}`, output].filter(Boolean).join('\n');
      return `${head}\n\n${fencedBlock(body, 'text')}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Markdown helpers.
// ---------------------------------------------------------------------------

export function notesSection(markdown: string): ReadonlyArray<readonly [string, string]> {
  return markdown.trim().length === 0 ? [] : [[SECTION.notes, sectionBody(markdown)]];
}

/**
 * Agent-supplied markdown, made safe to put inside a `## ` section.
 *
 * See `fenceIfHeadings`: text containing its own headings splits the section it
 * is written into, and can shadow a real section that a context recipe reads by
 * name. Every piece of free-form agent output that lands in a section goes
 * through here.
 */
function sectionBody(markdown: string): string {
  return fenceIfHeadings(markdown.trim());
}

function bullets(items: readonly string[]): string {
  return items
    .map((entry) => `- ${entry.replace(/\s*\r?\n\s*/g, ' ').trim()}`)
    .filter((line) => line !== '- ')
    .join('\n');
}

function bulletBlock(title: string, items: readonly string[]): string {
  const list = bullets(items);
  return list.length === 0 ? '' : `**${title}**\n\n${list}`;
}

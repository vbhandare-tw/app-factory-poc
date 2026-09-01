/**
 * Context injection (spec §6.2).
 *
 * Agents are fenced out of the vault entirely (ADR-002), so everything an agent
 * knows about its own job arrives in the prompt. A recipe is the ordered list of
 * documents one role gets; `buildContext` reads them and returns the assembled
 * text plus a report of what went in and what did not.
 *
 * ============================================================================
 * WHY THERE IS NOT A SINGLE `'## '` STRING IN THIS FILE
 * ============================================================================
 * Recipes extract note sections by heading. Four of those heading names —
 * `Refined Requirement`, `Tech Plan`, `Review Notes`, `QA Notes` — were inferred
 * during Phase 3 and never specified; they live in `SECTION_ORDER` in
 * `src/vault/storage.ts`, which is also what the orchestrator writes them with.
 *
 * A heading typed here as a literal, with the case or spacing or wording even
 * slightly off, extracts an empty string. Nothing fails. The agent gets a
 * well-formed prompt with one section silently blank, returns valid structured
 * output, and does worse work for a reason nothing in the system reports.
 *
 * So headings are looked up by name in `SECTION_ORDER` (`sectionHeading`), and
 * the lookup **throws at module load** if the constant no longer offers that
 * name. A rename becomes a crash on the first import rather than a quiet
 * degradation on the tenth ticket. `test/integration/agents.test.ts` greps this
 * directory to keep it that way.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { removeSections, sectionText } from '../domain/markdown.js';
import type { Role } from '../domain/roles.js';
import type { Storage } from '../vault/storage.js';
import { SECTION_ORDER } from '../vault/storage.js';
import type { VaultPaths } from '../vault/paths.js';

export type SectionHeading = (typeof SECTION_ORDER)[number];

/**
 * The `SECTION_ORDER` entry whose text is `name`.
 *
 * Not `\`## ${name}\``: that would rebuild the heading from a guess and match
 * `SECTION_ORDER` only by luck. This asks the constant, and refuses if the
 * constant has nothing to offer.
 */
export function sectionHeading(name: string): SectionHeading {
  const match = SECTION_ORDER.find((heading) => heading.replace(/^#+\s*/, '').trim() === name);
  if (match === undefined) {
    throw new Error(
      `no section named ${JSON.stringify(name)} in SECTION_ORDER (${SECTION_ORDER.join(', ')}). ` +
        'Context recipes read note sections by heading, so a name that is not in the constant ' +
        'would extract nothing and hand the agent a silently empty section.',
    );
  }
  return match;
}

/** The headings the recipes below use, resolved once, at load. */
export const SECTION = Object.freeze({
  rawRequirement: sectionHeading('Raw Requirement'),
  refinedRequirement: sectionHeading('Refined Requirement'),
  acceptanceCriteria: sectionHeading('Acceptance Criteria'),
  techPlan: sectionHeading('Tech Plan'),
  implementationNotes: sectionHeading('Implementation Notes'),
  reviewNotes: sectionHeading('Review Notes'),
  qaNotes: sectionHeading('QA Notes'),
  gateResults: sectionHeading('Gate Results'),
  /**
   * Free text: an agent's `notes_markdown`, a Tech Lead's questions back to the
   * PM, and a human's approve/reject reason. Deliberately **not** in
   * `OMITTED_FROM_NOTE_BODY` — the whole point is that the next run reads it.
   */
  notes: sectionHeading('Notes'),
  history: sectionHeading('History'),
});

/**
 * Sections left out when a whole note is injected.
 *
 * `Review Notes` and `QA Notes` are injected separately and only on a retry
 * (spec §6.2). Without this they would ride along inside the note body on every
 * attempt, which makes "on retry" meaningless and hands a first attempt the
 * bounce notes from a previous lifecycle. `History` is the orchestrator's audit
 * trail — state transitions and lock activity — and is noise to an agent.
 */
const OMITTED_FROM_NOTE_BODY: readonly SectionHeading[] = Object.freeze([
  SECTION.reviewNotes,
  SECTION.qaNotes,
  SECTION.history,
]);

// ---------------------------------------------------------------------------
// Recipes.
// ---------------------------------------------------------------------------

/**
 * Where one document comes from.
 *
 * Every ticket-derived source resolves through `paths.ticketPath(slug,
 * request.ticketId)` — one ticket, named by the caller. There is deliberately no
 * source that enumerates a feature's tickets: a developer that can read another
 * ticket's notes will implement both, or contradict them.
 */
export type DocSource =
  | { readonly kind: 'project' }
  | { readonly kind: 'feature' }
  | { readonly kind: 'feature_section'; readonly heading: SectionHeading }
  | { readonly kind: 'tech_dir' }
  | { readonly kind: 'tech_plan' }
  | { readonly kind: 'ticket' }
  | { readonly kind: 'ticket_section'; readonly heading: SectionHeading }
  | { readonly kind: 'repo_claude_md' }
  | { readonly kind: 'diff' };

export interface ContextDoc {
  /** Stable id, used by the report and therefore by the event log. */
  readonly id: string;
  /** The label the agent sees above the content. */
  readonly label: string;
  readonly source: DocSource;
  /** Absent → the whole run is refused rather than run under-informed. */
  readonly required: boolean;
  /** May be dropped to fit `maxChars`. Required documents never are. */
  readonly droppable: boolean;
  /** Included only when `attempt > 1` (spec §6.2, the developer's retry row). */
  readonly onlyOnRetry?: boolean;
}

export interface ContextRecipe {
  readonly role: Role;
  /** Highest priority first. The last droppable entry is dropped first. */
  readonly docs: readonly ContextDoc[];
}

const PROJECT: ContextDoc = {
  id: 'project',
  label: 'project.md — conventions that hold for the whole project',
  source: { kind: 'project' },
  required: true,
  droppable: false,
};

const FEATURE: ContextDoc = {
  id: 'feature',
  label: 'the feature note',
  source: { kind: 'feature' },
  required: true,
  droppable: false,
};

const TECH_PLAN: ContextDoc = {
  id: 'tech_plan',
  label: 'tech-plan.md — the technical plan for this feature',
  source: { kind: 'tech_plan' },
  required: true,
  droppable: false,
};

const TICKET: ContextDoc = {
  id: 'ticket',
  label: 'the ticket you are working on',
  source: { kind: 'ticket' },
  required: true,
  droppable: false,
};

const TECH_DIR: ContextDoc = {
  id: 'tech_dir',
  label: 'project technical documents',
  source: { kind: 'tech_dir' },
  required: false,
  droppable: true,
};

const REPO_CLAUDE_MD: ContextDoc = {
  id: 'repo_claude_md',
  // `--safe-mode` suppresses the target repo's own CLAUDE.md (spec §4.2), so it
  // is injected here deliberately or not at all.
  label: "the target repo's CLAUDE.md — its own conventions",
  source: { kind: 'repo_claude_md' },
  required: false,
  droppable: true,
};

const DIFF: ContextDoc = {
  id: 'diff',
  label: 'the change under review (git diff against the base branch)',
  source: { kind: 'diff' },
  required: true,
  droppable: false,
};

const PRIOR_REVIEW: ContextDoc = {
  id: 'review_notes',
  label: 'review notes from the previous attempt',
  source: { kind: 'ticket_section', heading: SECTION.reviewNotes },
  required: false,
  droppable: true,
  onlyOnRetry: true,
};

const PRIOR_QA: ContextDoc = {
  id: 'qa_notes',
  label: 'QA notes from the previous attempt',
  source: { kind: 'ticket_section', heading: SECTION.qaNotes },
  required: false,
  droppable: true,
  onlyOnRetry: true,
};

const TICKET_CRITERIA: ContextDoc = {
  id: 'ticket_acceptance_criteria',
  label: "the ticket's acceptance criteria",
  source: { kind: 'ticket_section', heading: SECTION.acceptanceCriteria },
  required: true,
  droppable: false,
};

/**
 * Spec §6.2's table, in priority order.
 *
 * **Two entries go beyond §6.2**, both deliberate, both recorded here so that
 * reading the spec against this file does not look like a discrepancy:
 *
 * - `code_reviewer` also gets the target repo's `CLAUDE.md`. §6.2 lists only the
 *   ticket, the tech plan and the diff. The reviewer's job is partly "does this
 *   fit the codebase's conventions", and `--safe-mode` suppresses the repo's own
 *   `CLAUDE.md` (spec §4.2) — so without this the reviewer judges conventions it
 *   was never shown, and the developer *was* (it is on the developer's row).
 *   Optional and droppable, so a repo without one changes nothing.
 * - `qa` also gets the whole ticket note. §6.2 lists only the acceptance
 *   criteria plus `project.md`. A criterion is written to be read next to the
 *   ticket it came from; on its own, "returns the correct result" names nothing
 *   QA can run. The criteria stay first and are the required document.
 */
export const RECIPES: Readonly<Record<Role, ContextRecipe>> = Object.freeze({
  pm: { role: 'pm', docs: [FEATURE, PROJECT] },
  tl_plan: { role: 'tl_plan', docs: [FEATURE, PROJECT, TECH_DIR] },
  dl: { role: 'dl', docs: [FEATURE, TECH_PLAN, PROJECT] },
  developer: {
    role: 'developer',
    docs: [TICKET, TECH_PLAN, PROJECT, PRIOR_REVIEW, PRIOR_QA, REPO_CLAUDE_MD],
  },
  code_reviewer: { role: 'code_reviewer', docs: [TICKET, DIFF, TECH_PLAN, REPO_CLAUDE_MD] },
  qa: { role: 'qa', docs: [TICKET_CRITERIA, TICKET, PROJECT] },
});

export function recipeFor(role: Role): ContextRecipe {
  return RECIPES[role];
}

// ---------------------------------------------------------------------------
// Building.
// ---------------------------------------------------------------------------

export interface ContextRequest {
  readonly storage: Storage;
  readonly paths: VaultPaths;
  readonly featureSlug: string;
  /** Required by every ticket-scoped recipe. */
  readonly ticketId?: string;
  /** The target repo root, for its `CLAUDE.md`. */
  readonly repoRoot?: string;
  /** 1 on a first run. Anything higher pulls the prior review and QA notes in. */
  readonly attempt?: number;
  /** `git diff <base>...<branch>`, computed by the orchestrator (Phase 9). */
  readonly diff?: string;
  /** `config.context_warn_chars`. */
  readonly maxChars?: number;
  /** Appended after the context, unfenced. The orchestrator's actual instruction. */
  readonly task?: string;
  /**
   * An instruction about the *previous* run of this same task — today, only the
   * schema retry's validator complaint (`src/orchestrator/attempts.ts`).
   *
   * Deliberately not a `ContextDoc`. Every document is a vault file the agent
   * could in principle be shown again on a later run; this is a one-off note
   * about a payload that was rejected and never written anywhere. Making it a
   * document would also make it droppable, and dropping the one thing the retry
   * exists to convey turns a free re-run into a wasted one.
   *
   * Rendered **last**, after the task, because it is the most recent and most
   * specific instruction in the prompt and the model weights the end of a long
   * context most heavily.
   */
  readonly retryGuidance?: string;
}

export interface ContextDocReport {
  readonly id: string;
  readonly chars: number;
  readonly included: boolean;
  /** Why it is not included: `missing` or `oversize`. */
  readonly reason?: 'missing' | 'oversize';
}

export interface ContextReport {
  readonly role: Role;
  readonly totalChars: number;
  readonly limitChars: number;
  readonly docs: readonly ContextDocReport[];
  readonly dropped: readonly ContextDocReport[];
  /** At least one document was dropped to fit. Goes to the event log (spec §6.2). */
  readonly truncated: boolean;
  /** Still over the limit after dropping everything droppable. */
  readonly overLimit: boolean;
}

export interface BuiltContext {
  readonly prompt: string;
  readonly report: ContextReport;
}

/** Spec §11's `context_warn_chars` default, for a caller that has no config. */
export const DEFAULT_MAX_CHARS = 200_000;

export class MissingContextError extends Error {
  readonly docId: string;

  constructor(docId: string, detail: string) {
    super(
      `required context document ${JSON.stringify(docId)} is missing: ${detail}. Running the ` +
        'agent without it would produce confident work against a document nobody wrote.',
    );
    this.name = 'MissingContextError';
    this.docId = docId;
  }
}

const BEGIN = '===== BEGIN';
const END = '===== END';

/**
 * Read every document the recipe asks for and assemble the prompt.
 *
 * *(Signature deviation from the plan, which writes `buildContext(recipe,
 * storage, item)`. Storage and an item cannot supply the vault paths, the target
 * repo root, the attempt number or the reviewer's diff, all of which spec §6.2's
 * table needs. They travel together in `ContextRequest` instead.)*
 */
export async function buildContext(
  recipe: ContextRecipe,
  request: ContextRequest,
): Promise<BuiltContext> {
  const attempt = request.attempt ?? 1;
  const limitChars = request.maxChars ?? DEFAULT_MAX_CHARS;

  const loaded: Array<{ doc: ContextDoc; text: string }> = [];
  const reports: ContextDocReport[] = [];

  for (const doc of recipe.docs) {
    if (doc.onlyOnRetry === true && attempt <= 1) continue;

    const text = await readDoc(doc, request);
    if (text === undefined || text.trim().length === 0) {
      if (doc.required) {
        throw new MissingContextError(doc.id, describeSource(doc.source, request));
      }
      reports.push({ id: doc.id, chars: 0, included: false, reason: 'missing' });
      continue;
    }
    loaded.push({ doc, text });
    reports.push({ id: doc.id, chars: text.length, included: true });
  }

  // Drop the lowest-priority droppable document until it fits (spec §6.2). The
  // drop is recorded rather than merely logged, so the orchestrator's event log
  // can say what the agent did not get — a silently truncated context is a
  // debugging nightmare.
  const dropped: ContextDocReport[] = [];
  let prompt = render(loaded, request.task, request.retryGuidance);

  while (prompt.length > limitChars) {
    const index = lastDroppableIndex(loaded);
    if (index === -1) break;
    const [removed] = loaded.splice(index, 1);
    if (removed === undefined) break;
    const entry: ContextDocReport = {
      id: removed.doc.id,
      chars: removed.text.length,
      included: false,
      reason: 'oversize',
    };
    dropped.push(entry);
    replaceReport(reports, entry);
    prompt = render(loaded, request.task, request.retryGuidance);
  }

  return {
    prompt,
    report: {
      role: recipe.role,
      totalChars: prompt.length,
      limitChars,
      docs: reports,
      dropped,
      truncated: dropped.length > 0,
      overLimit: prompt.length > limitChars,
    },
  };
}

function lastDroppableIndex(loaded: ReadonlyArray<{ doc: ContextDoc }>): number {
  for (let index = loaded.length - 1; index >= 0; index -= 1) {
    if (loaded[index]?.doc.droppable === true) return index;
  }
  return -1;
}

function replaceReport(reports: ContextDocReport[], entry: ContextDocReport): void {
  const index = reports.findIndex((report) => report.id === entry.id);
  if (index === -1) reports.push(entry);
  else reports[index] = entry;
}

function render(
  loaded: ReadonlyArray<{ doc: ContextDoc; text: string }>,
  task?: string,
  retryGuidance?: string,
): string {
  const blocks = loaded.map(
    ({ doc, text }) => `${BEGIN} ${doc.id}: ${doc.label} =====\n${text.trim()}\n${END} ${doc.id} =====`,
  );

  const head =
    'The following documents are your context. They are read-only: you cannot open the vault ' +
    'they came from, and nothing you write goes back into them.';

  return [
    head,
    ...blocks,
    ...(task === undefined || task.length === 0 ? [] : [task]),
    ...(retryGuidance === undefined || retryGuidance.length === 0 ? [] : [retryGuidance]),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Sources.
// ---------------------------------------------------------------------------

async function readDoc(doc: ContextDoc, request: ContextRequest): Promise<string | undefined> {
  const { paths, storage, featureSlug } = request;

  switch (doc.source.kind) {
    case 'project':
      return readText(paths.projectFile());

    case 'feature':
      return await noteText(storage, paths.featureNote(featureSlug));

    case 'feature_section': {
      const body = await noteBody(storage, paths.featureNote(featureSlug));
      return body === undefined ? undefined : sectionText(body, doc.source.heading);
    }

    case 'tech_plan':
      return readText(paths.techPlan(featureSlug));

    case 'tech_dir':
      return readTechDir(paths.techDir());

    case 'ticket':
      return await noteText(storage, ticketFile(request, doc));

    case 'ticket_section': {
      const body = await noteBody(storage, ticketFile(request, doc));
      return body === undefined ? undefined : sectionText(body, doc.source.heading);
    }

    case 'repo_claude_md':
      return request.repoRoot === undefined
        ? undefined
        : readText(path.join(request.repoRoot, 'CLAUDE.md'));

    case 'diff':
      return request.diff;

    default: {
      const unreachable: never = doc.source;
      throw new Error(`unknown context source ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The one ticket this run is about.
 *
 * Throws rather than falling back to "the feature's first ticket" or similar:
 * a wrong ticket in a developer's context is worse than a refused run.
 */
function ticketFile(request: ContextRequest, doc: ContextDoc): string {
  if (request.ticketId === undefined || request.ticketId.length === 0) {
    throw new MissingContextError(
      doc.id,
      'the recipe needs a ticket but the request carries no ticketId',
    );
  }
  return request.paths.ticketPath(request.featureSlug, request.ticketId);
}

/** A note rendered for an agent: a short header, then the body. */
async function noteText(storage: Storage, file: string): Promise<string | undefined> {
  const note = await readNote(storage, file);
  if (note === undefined) return undefined;

  const front = note.frontmatter as Record<string, unknown>;
  const header = ['id', 'title', 'status', 'depends_on']
    .filter((key) => front[key] !== undefined && front[key] !== null)
    .map((key) => `${key}: ${JSON.stringify(front[key])}`)
    .join('\n');

  return `${header}\n\n${removeSections(note.body, OMITTED_FROM_NOTE_BODY)}`.trim();
}

async function noteBody(storage: Storage, file: string): Promise<string | undefined> {
  return (await readNote(storage, file))?.body;
}

async function readNote(
  storage: Storage,
  file: string,
): Promise<{ frontmatter: unknown; body: string } | undefined> {
  try {
    return await storage.readNote<Record<string, unknown>>(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Every markdown file in the vault's `tech/` directory, in name order. */
async function readTechDir(directory: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  const parts: string[] = [];
  for (const name of names) {
    const text = await readText(path.join(directory, name));
    if (text === undefined || text.trim().length === 0) continue;
    parts.push(`--- ${name} ---\n${text.trim()}`);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function describeSource(source: DocSource, request: ContextRequest): string {
  switch (source.kind) {
    case 'diff':
      return 'no diff was supplied for the review';
    case 'ticket_section':
    case 'feature_section':
      return `section ${source.heading} is absent or empty`;
    default:
      return `${source.kind} for feature ${JSON.stringify(request.featureSlug)} could not be read`;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Compile-time proof that every role has a recipe. */
const _everyRoleHasARecipe: Record<Role, ContextRecipe> = RECIPES;
void _everyRoleHasARecipe;

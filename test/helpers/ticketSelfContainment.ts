/**
 * Is a DL ticket implementable by an agent that can see only that ticket?
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS A TEST RATHER THAN A REFUSAL
 * ============================================================================
 * A Developer agent runs in an isolated worktree with exactly what
 * `buildContext` hands it: `project.md`, **its own ticket**, `tech-plan.md`, and
 * the target repo's `CLAUDE.md`. It cannot see the other tickets — Phase 6 built
 * a `Proxy` that throws if a recipe even tries, and `src/agents/context.ts` has
 * no source that enumerates a feature's tickets.
 *
 * So a ticket that says "as described in the previous ticket", or "add the
 * remaining operators", or that leans on a decision the DL only wrote into its
 * own `notes_markdown`, is **schema-valid, reads well to a human, and is
 * impossible to implement**. Nothing goes red. The DL's `depends_on` is a clean
 * DAG. The failure surfaces in Phase 9 as a Developer that silently built the
 * wrong thing, where it looks like a Developer problem or a gates problem.
 *
 * ============================================================================
 * WHAT THIS CAN AND CANNOT CATCH
 * ============================================================================
 * It catches the **cheap** cases: a ticket naming another by ordinal, by
 * position ("the previous one"), by ticket id, or by another ticket's literal
 * title. Those are mechanical and they are what a drifting prompt produces
 * first.
 *
 * It cannot catch the expensive case — a ticket that names nothing but still
 * assumes a shared decision, an interface, or a file layout that exists only in
 * the DL's head. **That one has to be read**, against the actual `buildContext`
 * output, by a person. This module is a floor, not a ceiling, and treating a
 * clean result as proof of self-containment is the mistake it is most likely to
 * invite.
 *
 * It is a checker rather than an orchestrator refusal on purpose. The right
 * response to a non-self-contained ticket is to fix the prompt that produced it;
 * a runtime refusal would park a feature in `needs_human` over wording, and the
 * false-positive cost of the title rule below is far too high to spend an
 * operator's attention on.
 */

export interface TicketLike {
  readonly title: string;
  readonly description_md: string;
  readonly acceptance_criteria: readonly string[];
  readonly technical_notes_md?: string;
  readonly depends_on?: readonly string[];
}

export interface SelfContainmentFinding {
  readonly ticketTitle: string;
  /** Which field the phrase was found in. */
  readonly field: 'description_md' | 'acceptance_criteria' | 'technical_notes_md';
  readonly rule: string;
  /** The matched text, with a little either side, so a failure message is readable. */
  readonly excerpt: string;
}

/**
 * Phrases that name another ticket by its position rather than by its content.
 *
 * Each requires a **noun** after the positional word. Bare `/previous/` matches
 * "the previous value", "the previous token", "the previous result" — ordinary
 * prose about code — and a rule that fires on those would be turned off within
 * a week, which is worse than not having it.
 */
const POSITIONAL_RULES: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  /**
   * A *singular, definite* reference — "the previous ticket", "the other task".
   *
   * *(`other` was narrowed to the singular after a real Delivery Lead run, and
   * again the narrowing is the finding. A ticket's tech notes said "do not touch
   * `src/cli.ts`, `src/evaluate.ts`, or `package.json` — **those belong to other
   * tickets**", which is not a dangling reference at all: it is a **scope
   * fence**, and one of the most useful sentences the Delivery Lead can write,
   * because it is what stops two Developers editing the same file and producing
   * a merge conflict. Flagging it would have punished the prompt for doing
   * exactly what the prompt asks for.*
   *
   * *The distinction is grammatical and it holds: "the other ticket" points at a
   * specific note the Developer cannot open; "other tickets" draws a boundary
   * around work that is not this Developer's. Plural, indefinite, no referent to
   * chase.)*
   */
  [
    'names another ticket by position',
    /\b(?:the\s+)?(previous|prior|preceding|earlier|next|following|subsequent|first|second|third|fourth|fifth|last)\s+(ticket|task|story|work\s*item|change|commit|pr|pull\s*request)s?\b/gi,
  ],
  ['names one specific other ticket', /\bthe\s+other\s+(ticket|task|story|work\s*item)\b/gi],
  ['names a ticket by ordinal', /\bticket\s*#?\s*\d+\b/gi],
  [
    'names a ticket by id',
    /\b(?:FEAT-[A-Z0-9-]+-)?T\d{3}\b/g,
  ],
  /**
   * Work handed off without saying what it is — "add the remaining operators".
   *
   * *(`other` and `tickets` were both dropped from this rule for the reason
   * above: "belong to other tickets" is a fence, not a deferral. What is left is
   * the real failure — a ticket that names a set of work by exclusion, where the
   * Developer would have to see the other tickets to know what is left.)*
   */
  [
    'defers work to another ticket',
    /\b(?:the\s+)?(?:remaining|rest\s+of\s+the)\s+(?:operators|operations|cases|items|features|functions|methods|endpoints)\b/gi,
  ],
  /**
   * "as described previously", but **not** "as described above".
   *
   * *(Narrowed after a real Delivery Lead run tripped it, and the narrowing is
   * the finding. A ticket's `technical_notes_md` said "…exporting
   * `formatNumber`, exactly as described above — both must already exist in the
   * worktree", and that reference **resolves**: a ticket note renders as
   * `## Raw Requirement` → `## Acceptance Criteria` → `## Tech Plan`, in that
   * order, so "above" from inside the tech notes points at the same ticket's own
   * description, which the Developer has in front of it. Flagging it would have
   * been the checker calling a correct ticket broken, and a check that cries
   * wolf gets switched off.*
   *
   * *`previously` and `earlier` are kept, because they imply a prior run or a
   * prior ticket rather than a position on the page, and neither of those is
   * anywhere the Developer can look.)*
   */
  [
    'refers to content the developer cannot see',
    /\bas\s+(?:described|noted|discussed|outlined|specified|mentioned|defined)\s+(?:previously|earlier|in\s+the\s+(?:previous|prior|preceding|earlier|other)\b)/gi,
  ],
  [
    'refers to the breakdown notes, which no developer receives',
    /\b(?:see|per)\s+(?:my|the)\s+(?:breakdown|split|notes_markdown|delivery\s+notes)\b/gi,
  ],
];

/** Titles shorter than this are too generic to match on without noise. */
const MIN_TITLE_MATCH_CHARS = 12;

/**
 * Every place a ticket leans on something outside itself.
 *
 * `depends_on` is deliberately **not** checked: naming another ticket there is
 * the correct way to express ordering, and the orchestrator resolves those
 * titles to ids before any developer sees the note. The problem is a dependency
 * expressed in *prose*, where it reaches the agent as an instruction it cannot
 * follow.
 */
export function findSelfContainmentProblems(
  tickets: readonly TicketLike[],
): SelfContainmentFinding[] {
  const findings: SelfContainmentFinding[] = [];

  for (const ticket of tickets) {
    const fields: ReadonlyArray<readonly [SelfContainmentFinding['field'], string]> = [
      ['description_md', ticket.description_md],
      ['acceptance_criteria', ticket.acceptance_criteria.join('\n')],
      ['technical_notes_md', ticket.technical_notes_md ?? ''],
    ];

    for (const [field, text] of fields) {
      if (text.trim().length === 0) continue;

      for (const [rule, pattern] of POSITIONAL_RULES) {
        for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
          findings.push({
            ticketTitle: ticket.title,
            field,
            rule,
            excerpt: excerptAround(text, match.index ?? 0, match[0].length),
          });
        }
      }

      for (const other of tickets) {
        if (other.title === ticket.title) continue;
        const otherTitle = other.title.trim();
        if (otherTitle.length < MIN_TITLE_MATCH_CHARS) continue;
        // A title that is a substring of this ticket's own title is not a
        // cross-reference: "Add CLI" inside "Add CLI tests" is a coincidence of
        // naming, not an instruction to go and read another note.
        if (ticket.title.includes(otherTitle)) continue;
        const at = text.indexOf(otherTitle);
        if (at === -1) continue;
        findings.push({
          ticketTitle: ticket.title,
          field,
          rule: `quotes another ticket's title (${JSON.stringify(otherTitle)})`,
          excerpt: excerptAround(text, at, otherTitle.length),
        });
      }
    }
  }

  return findings;
}

/** A failure message a human can act on without opening the payload. */
export function describeSelfContainmentProblems(
  findings: readonly SelfContainmentFinding[],
): string {
  if (findings.length === 0) return '';
  return [
    `${findings.length} ticket reference(s) point outside the ticket. A Developer agent receives`,
    'only its own ticket, the tech plan and project.md — never another ticket — so each of these',
    'is an instruction it cannot follow, in a payload that is otherwise schema-valid:',
    '',
    ...findings.map(
      (finding) =>
        `- ${JSON.stringify(finding.ticketTitle)} · ${finding.field} · ${finding.rule}\n` +
        `    …${finding.excerpt}…`,
    ),
    '',
    'This is a prompt defect, not a ticket defect. Fix prompts/dl.md.',
  ].join('\n');
}

function excerptAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 40);
  const to = Math.min(text.length, index + length + 40);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

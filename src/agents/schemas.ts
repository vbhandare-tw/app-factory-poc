/**
 * The agent output contract, once (spec §5).
 *
 * `--json-schema` makes the CLI return a **validated** `structured_output`
 * object, which is what removes prose parsing from the design entirely. The
 * schema the CLI validates against and the schema the orchestrator re-validates
 * with are derived from the same zod object here, so the two cannot drift: a
 * field added on one side is a field added on both.
 *
 * TWO THINGS TO KNOW BEFORE EDITING:
 *
 * 1. **Every object is `strictObject`, at every depth.** That is what becomes
 *    `additionalProperties: false` in the converted document. A nested object
 *    left as `z.object` accepts extra keys in the CLI's validation, and those
 *    keys then arrive at an orchestrator that never looks at them — malformed
 *    work that looks well-formed. `test/unit/agents/schemas.test.ts` walks every
 *    subschema of the *converted* document, not the zod one, because only the
 *    converted document is what the CLI receives.
 *
 * 2. **`.refine()` does not survive conversion.** Verified against zod 4.5.4:
 *    `z.toJSONSchema` silently drops custom checks. So the rule "an escalation
 *    must carry a reason" is enforced by `validateAgentOutput` and by nothing
 *    else — the CLI will happily return `outcome: 'escalate'` with a null
 *    reason. Spec §5 rule 1 calls the orchestrator's second validation "belt and
 *    braces"; for this rule it is the only belt there is.
 */
import { z } from 'zod';

import type { Role } from '../domain/roles.js';
import type { StructuredValidation } from '../runner/types.js';

/** Spec §5: the two outcomes every role reports. */
export const OUTCOMES = ['ok', 'escalate'] as const;

/** Severity vocabulary for a review finding. Stated in `prompts/code_reviewer.md`. */
export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

export const REVIEW_VERDICTS = ['approve', 'request_changes'] as const;
export const QA_VERDICTS = ['pass', 'fail'] as const;

/** The fields every role returns, whatever else it returns (spec §5). */
const BASE_SHAPE = {
  outcome: z.enum(OUTCOMES),
  /** Non-null and non-blank whenever `outcome` is `escalate`. */
  escalate_reason: z.string().nullable(),
  /** Appended verbatim to the note body by the orchestrator. */
  notes_markdown: z.string(),
};

export const BASE_FIELD_NAMES = Object.keys(BASE_SHAPE) as ReadonlyArray<keyof typeof BASE_SHAPE>;

export const ESCALATION_MESSAGE =
  'outcome "escalate" requires a non-empty escalate_reason — an escalation with no reason parks ' +
  'the item in needs_human with nothing for the operator to act on';

/**
 * Close the object and attach the cross-field rule.
 *
 * Written as one helper so no role can be added without both. The returned type
 * is a `ZodType` rather than a `ZodObject` because `.refine()` wraps it; nothing
 * downstream needs the object methods.
 */
type BaseShape = typeof BASE_SHAPE;

/**
 * The inferred payload type: the base fields **and** the role's own.
 *
 * Spelling out `BaseShape & T` rather than just `T` is load-bearing — with `T`
 * alone, `PmOutput` and friends compile without `outcome`, `escalate_reason` or
 * `notes_markdown`, so Phase 7's dispatch would fail to type-check the exact
 * three fields every role is contractually required to return. Caught by the
 * Phase 6 measurement spike, which reads `notes_markdown` off a `TlPlanOutput`.
 */
type AgentOutput<T extends z.ZodRawShape> = z.core.output<z.ZodObject<BaseShape & T>>;

function agentSchema<T extends z.ZodRawShape>(shape: T): z.ZodType<AgentOutput<T>> {
  return z
    .strictObject({ ...BASE_SHAPE, ...shape })
    .refine(escalationHasReason, {
      message: ESCALATION_MESSAGE,
      path: ['escalate_reason'],
    }) as z.ZodType<AgentOutput<T>>;
}

/**
 * Read through `unknown` rather than through the generic's inferred shape.
 *
 * The refinement runs after the object has already parsed, so the two fields are
 * known to be there and known to be the right types; spelling that out in the
 * generic's return type costs a page of mapped-type noise for nothing.
 */
function escalationHasReason(value: unknown): boolean {
  const { outcome, escalate_reason: reason } = value as {
    outcome: unknown;
    escalate_reason: unknown;
  };
  if (outcome !== 'escalate') return true;
  return typeof reason === 'string' && reason.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Per role (spec §5's table).
// ---------------------------------------------------------------------------

export const PmSchema = agentSchema({
  refined_requirement: z.string(),
  scope_in: z.array(z.string()),
  scope_out: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  questions_for_tl: z.array(z.string()),
});

export const TlPlanSchema = agentSchema({
  feasibility: z.string(),
  risks: z.array(z.string()),
  phases: z.array(z.string()),
  questions_for_pm: z.array(z.string()),
  /** `true` sends the feature back to the PM rather than on to the DL. */
  request_refinement: z.boolean(),
  tech_doc_updates: z.array(z.string()),
});

export const DL_TITLE_MESSAGE =
  'every ticket title must be unique within the payload — titles are the only handle a dependency ' +
  'has until the orchestrator assigns real ids, so two tickets with one title make the breakdown ' +
  'unresolvable';

export const DL_DEPENDENCY_MESSAGE =
  'every depends_on entry must name another ticket in this same payload, and no ticket may depend ' +
  'on itself';

export const DlSchema = agentSchema({
  tickets: z.array(
    z.strictObject({
      title: z.string(),
      description_md: z.string(),
      acceptance_criteria: z.array(z.string()),
      technical_notes_md: z.string(),
      /**
       * The **titles** of other tickets in this same payload, exactly as
       * `prompts/dl.md` asks for them. Real ticket ids do not exist until the
       * orchestrator writes the notes, so the DL cannot reference them and must
       * not invent them.
       *
       * That convention is what makes the two payload-level rules below
       * load-bearing rather than tidy: title uniqueness *is* the resolvability
       * of the dependency graph. Enforced here, in the schema that invented the
       * convention, rather than in the Phase 7 resolver that inherits it — a
       * duplicate title reaching the resolver looks like a Phase 7 bug.
       *
       * Longer cycles (A → B → A) are `src/domain/dag.ts`'s job, which already
       * detects them over real ids. Only the self-cycle is caught here, because
       * it is visible without any resolution at all.
       */
      depends_on: z.array(z.string()),
    }),
  ),
})
  .refine((value) => ticketTitles(value).unique, { message: DL_TITLE_MESSAGE, path: ['tickets'] })
  .refine(dependenciesResolve, { message: DL_DEPENDENCY_MESSAGE, path: ['tickets'] });

interface TicketTitles {
  readonly titles: string[];
  readonly unique: boolean;
}

/** Titles as the resolver will see them: trimmed, because `"A "` and `"A"` are one handle. */
function ticketTitles(value: unknown): TicketTitles {
  const tickets = (value as { tickets?: ReadonlyArray<{ title?: unknown }> }).tickets ?? [];
  const titles = tickets.map((ticket) => String(ticket.title ?? '').trim());
  return { titles, unique: new Set(titles).size === titles.length };
}

function dependenciesResolve(value: unknown): boolean {
  const tickets =
    (value as { tickets?: ReadonlyArray<{ title?: unknown; depends_on?: unknown }> }).tickets ?? [];
  const known = new Set(ticketTitles(value).titles);

  for (const ticket of tickets) {
    const own = String(ticket.title ?? '').trim();
    const dependencies = Array.isArray(ticket.depends_on) ? ticket.depends_on : [];
    for (const raw of dependencies) {
      const dependency = String(raw).trim();
      if (dependency === own) return false;
      if (!known.has(dependency)) return false;
    }
  }
  return true;
}

export const DeveloperSchema = agentSchema({
  summary: z.string(),
  files_changed: z.array(z.string()),
  /**
   * *Proposed*, not applied. The agent cannot stage or commit (spec §4.5,
   * ADR-003); the orchestrator commits after it exits.
   */
  commit_message: z.string(),
  tests_added: z.array(z.string()),
});

/**
 * Severities that make an approval self-contradictory.
 *
 * `prompts/code_reviewer.md` tells the reviewer to `request_changes` if any
 * finding is a `blocker` or a `major`, and calls approving over one "the one
 * contradiction your output must never contain". This is the half that refuses
 * it when the prompt was not followed — the verdict is what Phase 7's dispatch
 * reads to advance a ticket, and it never re-reads the findings.
 */
export const BLOCKING_SEVERITIES = ['blocker', 'major'] as const;

export const REVIEW_CONTRADICTION_MESSAGE =
  'verdict "approve" cannot carry a blocker or major finding — use "request_changes". An approval ' +
  'advances the ticket, so a blocking finding recorded beside it is signed off by the orchestrator ' +
  'and acted on by nobody';

export const QA_CONTRADICTION_MESSAGE =
  'verdict "pass" cannot carry a failed criterion — the verdict is what advances the ticket, and a ' +
  'failed criterion beside it means the ticket merges with a criterion nobody met';

export const CodeReviewerSchema = agentSchema({
  verdict: z.enum(REVIEW_VERDICTS),
  findings: z.array(
    z.strictObject({
      file: z.string(),
      /** `null` for a finding about the change as a whole. */
      line: z.number().int().nullable(),
      severity: z.enum(REVIEW_SEVERITIES),
      message: z.string(),
    }),
  ),
}).refine(
  (value) => {
    const { verdict, findings } = value as {
      verdict: unknown;
      findings: ReadonlyArray<{ severity?: unknown }>;
    };
    if (verdict !== 'approve') return true;
    return !findings.some((finding) =>
      (BLOCKING_SEVERITIES as readonly string[]).includes(String(finding.severity)),
    );
  },
  { message: REVIEW_CONTRADICTION_MESSAGE, path: ['verdict'] },
);

export const QaSchema = agentSchema({
  verdict: z.enum(QA_VERDICTS),
  criteria_results: z.array(
    z.strictObject({
      criterion: z.string(),
      result: z.enum(QA_VERDICTS),
      /** The command run to check it, so a human can reproduce the claim. */
      evidence_command: z.string(),
      evidence_output: z.string(),
    }),
  ),
}).refine(
  (value) => {
    const { verdict, criteria_results: results } = value as {
      verdict: unknown;
      criteria_results: ReadonlyArray<{ result?: unknown }>;
    };
    if (verdict !== 'pass') return true;
    // Only this direction. A `fail` verdict with every criterion green is not a
    // contradiction: `prompts/qa.md` tells QA to fail for a criterion it could
    // not check at all, and that failure has no criteria row to sit in.
    return !results.some((entry) => entry.result === 'fail');
  },
  { message: QA_CONTRADICTION_MESSAGE, path: ['verdict'] },
);

export type PmOutput = z.infer<typeof PmSchema>;
export type TlPlanOutput = z.infer<typeof TlPlanSchema>;
export type DlOutput = z.infer<typeof DlSchema>;
export type DeveloperOutput = z.infer<typeof DeveloperSchema>;
export type CodeReviewerOutput = z.infer<typeof CodeReviewerSchema>;
export type QaOutput = z.infer<typeof QaSchema>;

export const AGENT_SCHEMAS = {
  pm: PmSchema,
  tl_plan: TlPlanSchema,
  dl: DlSchema,
  developer: DeveloperSchema,
  code_reviewer: CodeReviewerSchema,
  qa: QaSchema,
} as const satisfies Record<Role, z.ZodType>;

export function schemaFor(role: Role): z.ZodType {
  return AGENT_SCHEMAS[role];
}

/**
 * The `$schema` dialect declaration, which **the CLI refuses**.
 *
 * `z.toJSONSchema` puts `"$schema": "https://json-schema.org/draft/2020-12/schema"`
 * at the root of every document it produces. Claude Code v2.1.220 rejects that
 * before it starts the run:
 *
 *     Error: --json-schema is not a valid JSON Schema: no schema with key or
 *     ref "https://json-schema.org/draft/2020-12/schema"
 *
 * Found by the Phase 6 real-CLI probe (`test/integration/agents-real-cli.test.ts`),
 * and worth stating plainly because nothing cheaper would have found it: the
 * stub `claude` accepts any `--json-schema` value, the unit tests only compare
 * the document to itself, and the failure is exit 1 before a single token is
 * spent — so every agent run in every later phase would have failed identically
 * and none of the existing tests would have gone red.
 *
 * Stripped recursively rather than only at the root: nothing nests a dialect
 * declaration today, but a future `z.toJSONSchema` that did would reintroduce
 * exactly this failure one level down.
 */
export const CLI_REJECTED_KEYS = ['$schema'] as const;

function stripForCli(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripForCli);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((CLI_REJECTED_KEYS as readonly string[]).includes(key)) continue;
    out[key] = stripForCli(value);
  }
  return Object.freeze(out);
}

/**
 * The JSON Schema handed to `--json-schema`, converted once at module load.
 *
 * Frozen because it is shared by every run of a role: a caller that mutated it
 * would change the contract for every later run in the same process.
 */
export const AGENT_JSON_SCHEMAS: Readonly<Record<Role, object>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(AGENT_SCHEMAS) as Role[]).map((role) => [
      role,
      stripForCli(z.toJSONSchema(AGENT_SCHEMAS[role])) as object,
    ]),
  ) as Record<Role, object>,
);

export function jsonSchemaFor(role: Role): object {
  return AGENT_JSON_SCHEMAS[role];
}

/**
 * The orchestrator's own validation of `structured_output` (spec §5 rule 1).
 *
 * Shaped as `StructuredValidator` so it can be handed straight to
 * `AgentRunSpec.validateStructured`. Every issue is reported, not just the
 * first: a failed validation costs a whole agent run, and a retry that fixes
 * one problem to discover the next wastes another.
 */
export function validateAgentOutput(role: Role, value: unknown): StructuredValidation {
  const result = schemaFor(role).safeParse(value);
  if (result.success) return { ok: true };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
      return `${where}: ${issue.message}`;
    }),
  };
}

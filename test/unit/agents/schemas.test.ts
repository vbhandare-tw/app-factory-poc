/**
 * The output contract (spec §5).
 *
 * This is the interface between two systems that never share a process: the
 * CLI validates the agent's payload against the JSON Schema we hand it, and the
 * orchestrator validates the same payload again with the zod schema it was
 * derived from (spec §5 rule 1). A loose schema lets malformed work into the
 * vault looking well-formed.
 *
 * Everything about `additionalProperties` is asserted **on the converted JSON
 * Schema**, never on the zod object. Checking the zod side proves the author's
 * belief about zod; only the converted document is what the CLI actually
 * receives.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_JSON_SCHEMAS,
  AGENT_SCHEMAS,
  BASE_FIELD_NAMES,
  CLI_REJECTED_KEYS,
  REVIEW_SEVERITIES,
  jsonSchemaFor,
  schemaFor,
  validateAgentOutput,
} from '../../../src/agents/schemas.js';
import { ROLES } from '../../../src/domain/roles.js';
import type { Role } from '../../../src/domain/roles.js';
import { validOutput } from '../../helpers/agentFixtures.js';

/** Every role's extra fields, so "missing a required field" can be driven per role. */
const EXTRA_FIELDS: Readonly<Record<Role, readonly string[]>> = {
  pm: ['refined_requirement', 'scope_in', 'scope_out', 'acceptance_criteria', 'questions_for_tl'],
  tl_plan: [
    'feasibility',
    'risks',
    'phases',
    'questions_for_pm',
    'request_refinement',
    'tech_doc_updates',
  ],
  dl: ['tickets'],
  developer: ['summary', 'files_changed', 'commit_message', 'tests_added'],
  code_reviewer: ['verdict', 'findings'],
  qa: ['verdict', 'criteria_results'],
};

interface JsonSchemaObject {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  anyOf?: unknown;
  enum?: unknown;
}

/** Every object-typed subschema anywhere in the document, root included. */
function objectSubschemas(node: unknown, trail = '$'): Array<[string, JsonSchemaObject]> {
  if (node === null || typeof node !== 'object') return [];
  const found: Array<[string, JsonSchemaObject]> = [];
  const record = node as Record<string, unknown>;

  if (record['type'] === 'object') found.push([trail, record as JsonSchemaObject]);

  for (const [key, value] of Object.entries(record)) {
    if (key === 'enum' || key === 'required') continue;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => found.push(...objectSubschemas(entry, `${trail}.${key}[${index}]`)));
    } else {
      found.push(...objectSubschemas(value, `${trail}.${key}`));
    }
  }
  return found;
}

describe('agent output schemas — per role', () => {
  it.each(ROLES)('%s accepts a valid payload', (role) => {
    const result = schemaFor(role).safeParse(validOutput(role));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(ROLES)('%s rejects a payload missing any one required field', (role) => {
    const fields = [...BASE_FIELD_NAMES, ...EXTRA_FIELDS[role]];
    expect(fields.length).toBeGreaterThan(3);

    for (const field of fields) {
      const payload = { ...validOutput(role) };
      delete payload[field];
      expect(
        schemaFor(role).safeParse(payload).success,
        `${role} accepted a payload with no ${field}`,
      ).toBe(false);
    }
  });

  it.each(ROLES)('%s rejects unknown extra fields', (role) => {
    const payload = { ...validOutput(role), definitely_not_in_the_contract: 'hello' };
    expect(schemaFor(role).safeParse(payload).success).toBe(false);
  });

  it.each(ROLES)('%s rejects an unknown field inside a nested object', (role) => {
    // The other half of strictness, and the half the converted document cannot
    // show you. zod 4.5.4 emits `additionalProperties: false` for a *loose*
    // `z.object` too when converting in output mode, so the JSON Schema looks
    // identical either way — but at runtime a loose object silently **strips**
    // the unknown key instead of refusing it. That is the orchestrator's own
    // validation (spec §5 rule 1) quietly accepting a `tickets[]` entry with a
    // field nobody reads. Verified by mutation: turning one nested
    // `strictObject` into `object` leaves every other test in this file green.
    const payload = validOutput(role);
    let nested = 0;

    for (const [key, value] of Object.entries(payload)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const first = value[0] as unknown;
      if (first === null || typeof first !== 'object') continue;
      nested += 1;

      const mutated = {
        ...payload,
        [key]: [{ ...(first as Record<string, unknown>), smuggled_field: 'hello' }, ...value.slice(1)],
      };
      expect(
        schemaFor(role).safeParse(mutated).success,
        `${role}.${key}[0] accepted an unknown nested field`,
      ).toBe(false);
    }

    // Roles with no nested objects are fine; roles that have them must be covered.
    if (['dl', 'code_reviewer', 'qa'].includes(role)) expect(nested).toBeGreaterThan(0);
  });

  it.each(ROLES)('%s keeps additionalProperties:false through JSON Schema conversion', (role) => {
    const document = jsonSchemaFor(role);
    const objects = objectSubschemas(document);

    // Not just the root: a `tickets[]` entry or a review finding that accepts
    // extra keys is the same hole one level down.
    expect(objects.length).toBeGreaterThan(0);
    for (const [trail, subschema] of objects) {
      expect(
        subschema.additionalProperties,
        `${role}: ${trail} does not close additionalProperties, so the CLI would accept ` +
          'fields the orchestrator never validates',
      ).toBe(false);
    }
  });

  it.each(ROLES)('%s produces a JSON Schema that is valid JSON with an object root', (role) => {
    const document = jsonSchemaFor(role) as JsonSchemaObject;
    expect(document.type).toBe('object');

    const round = JSON.parse(JSON.stringify(document)) as JsonSchemaObject;
    expect(round).toEqual(document);

    // The base fields are the orchestrator's contract with every role.
    for (const field of BASE_FIELD_NAMES) {
      expect(Object.keys(document.properties ?? {})).toContain(field);
      expect(document.required as string[]).toContain(field);
    }
  });

  it.each(ROLES)('%s carries no key the CLI rejects', (role) => {
    // Not cosmetic. Claude Code v2.1.220 refuses a document that declares a
    // dialect it does not know:
    //   Error: --json-schema is not a valid JSON Schema: no schema with key or
    //   ref "https://json-schema.org/draft/2020-12/schema"
    // and `z.toJSONSchema` adds exactly that. The run exits 1 before spending a
    // token, so every agent run in every later phase would have failed the same
    // way. Found by the real-CLI probe, pinned here so it stays fixed.
    const serialised = JSON.stringify(jsonSchemaFor(role));
    expect(serialised, `${role} still declares $schema`).not.toContain('$schema');
    for (const key of CLI_REJECTED_KEYS) expect(serialised).not.toContain(key);
  });

  it('code_reviewer.verdict accepts only approve / request_changes', () => {
    for (const verdict of ['approve', 'request_changes']) {
      expect(schemaFor('code_reviewer').safeParse({ ...validOutput('code_reviewer'), verdict }).success).toBe(
        true,
      );
    }
    for (const verdict of ['approved', 'reject', 'pass', 'REQUEST_CHANGES', '', null]) {
      expect(
        schemaFor('code_reviewer').safeParse({ ...validOutput('code_reviewer'), verdict }).success,
        `code_reviewer accepted verdict ${JSON.stringify(verdict)}`,
      ).toBe(false);
    }
  });

  it('qa.verdict accepts only pass / fail', () => {
    for (const verdict of ['pass', 'fail']) {
      expect(schemaFor('qa').safeParse({ ...validOutput('qa'), verdict }).success).toBe(true);
    }
    for (const verdict of ['passed', 'approve', 'PASS', '', null]) {
      expect(
        schemaFor('qa').safeParse({ ...validOutput('qa'), verdict }).success,
        `qa accepted verdict ${JSON.stringify(verdict)}`,
      ).toBe(false);
    }
  });

  it.each(ROLES)('%s rejects outcome:escalate with a null or empty escalate_reason', (role) => {
    const nulled = { ...validOutput(role), outcome: 'escalate', escalate_reason: null };
    expect(schemaFor(role).safeParse(nulled).success, `${role} accepted an escalation with no reason`).toBe(
      false,
    );

    const blank = { ...validOutput(role), outcome: 'escalate', escalate_reason: '   ' };
    expect(schemaFor(role).safeParse(blank).success).toBe(false);

    const given = { ...validOutput(role), outcome: 'escalate', escalate_reason: 'the ticket contradicts itself' };
    expect(schemaFor(role).safeParse(given).success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-field contradictions.
  //
  // A payload can be perfectly well-typed and still say two incompatible
  // things. Phase 7's dispatch reads the verdict field and acts on it — it does
  // not re-read the findings — so a contradiction that validates clean is a
  // contradiction that reaches the vault with the orchestrator's signature on
  // it. These are all orchestrator-side by necessity: `.refine()` never reaches
  // the CLI, so the prompt is what asks the agent for consistency and this is
  // what refuses it when the prompt was not followed.
  // -------------------------------------------------------------------------

  it('code_reviewer cannot approve while reporting a blocker or a major', () => {
    const base = validOutput('code_reviewer');
    const finding = (severity: string): Record<string, unknown> => ({
      file: 'src/calc.ts',
      line: 3,
      severity,
      message: 'the error path is unhandled',
    });

    for (const severity of ['blocker', 'major']) {
      const contradiction = { ...base, verdict: 'approve', findings: [finding(severity)] };
      expect(
        schemaFor('code_reviewer').safeParse(contradiction).success,
        `an approval carrying a ${severity} finding validated clean — prompts/code_reviewer.md ` +
          'calls that the one contradiction the output must never contain',
      ).toBe(false);

      // The same findings with the honest verdict are fine.
      expect(
        schemaFor('code_reviewer').safeParse({ ...contradiction, verdict: 'request_changes' }).success,
      ).toBe(true);
    }

    // Approving over a nit or a minor is normal review behaviour, not a bug.
    for (const severity of ['minor', 'nit']) {
      expect(
        schemaFor('code_reviewer').safeParse({ ...base, verdict: 'approve', findings: [finding(severity)] })
          .success,
        `an approval over a ${severity} was refused — that is ordinary review`,
      ).toBe(true);
    }

    // And the failure is reported against the field Phase 7 will act on.
    const issues = validateAgentOutput('code_reviewer', {
      ...base,
      verdict: 'approve',
      findings: [finding('blocker')],
    });
    expect(issues.ok).toBe(false);
    expect(issues.ok === false && issues.issues.join(' ')).toContain('verdict');
  });

  it('qa cannot pass while reporting a failed criterion', () => {
    const base = validOutput('qa');
    const failed = {
      criterion: 'subtract(3, 1) === 2',
      result: 'fail',
      evidence_command: 'npm test',
      evidence_output: 'not ok 1 - subtract returns the difference',
    };

    expect(
      schemaFor('qa').safeParse({ ...base, verdict: 'pass', criteria_results: [failed] }).success,
      'a passing QA verdict carrying a failed criterion validated clean',
    ).toBe(false);

    // The honest pairing, and the reverse (a fail with everything green is not a
    // contradiction — QA may fail for a reason no criterion covers).
    expect(
      schemaFor('qa').safeParse({ ...base, verdict: 'fail', criteria_results: [failed] }).success,
    ).toBe(true);
    expect(schemaFor('qa').safeParse({ ...base, verdict: 'fail' }).success).toBe(true);
    expect(schemaFor('qa').safeParse({ ...base, verdict: 'pass' }).success).toBe(true);

    const issues = validateAgentOutput('qa', { ...base, verdict: 'pass', criteria_results: [failed] });
    expect(issues.ok === false && issues.issues.join(' ')).toContain('verdict');
  });

  it('dl ticket titles are unique and every dependency names one of them', () => {
    const base = validOutput('dl');
    const ticket = (title: string, dependsOn: string[] = []): Record<string, unknown> => ({
      title,
      description_md: 'do the thing',
      acceptance_criteria: ['it works'],
      technical_notes_md: 'notes',
      depends_on: dependsOn,
    });

    // Titles are the only handle a dependency has: real ticket ids do not exist
    // until the orchestrator writes the notes. Duplicate titles make Phase 7's
    // title-to-id resolution ambiguous, and it would look like a Phase 7 bug.
    expect(
      schemaFor('dl').safeParse({ ...base, tickets: [ticket('Add subtract'), ticket('Add subtract')] })
        .success,
      'two tickets shared a title',
    ).toBe(false);

    // Same, modulo surrounding whitespace — which resolves to the same handle.
    expect(
      schemaFor('dl').safeParse({ ...base, tickets: [ticket('Add subtract'), ticket('  Add subtract ')] })
        .success,
    ).toBe(false);

    expect(
      schemaFor('dl').safeParse({
        ...base,
        tickets: [ticket('Add subtract'), ticket('Add divide', ['Add multiply'])],
      }).success,
      'a dependency named a ticket that is not in the payload',
    ).toBe(false);

    expect(
      schemaFor('dl').safeParse({ ...base, tickets: [ticket('Add subtract', ['Add subtract'])] }).success,
      'a ticket depended on itself',
    ).toBe(false);

    // The shape that must keep working: an ordered pair with a real dependency.
    expect(
      schemaFor('dl').safeParse({
        ...base,
        tickets: [ticket('Add subtract'), ticket('Add divide', ['Add subtract'])],
      }).success,
    ).toBe(true);

    // And an empty breakdown is still a valid payload — the DL escalates rather
    // than inventing tickets, and that escalation carries no tickets.
    expect(schemaFor('dl').safeParse({ ...base, tickets: [] }).success).toBe(true);

    const issues = validateAgentOutput('dl', {
      ...base,
      tickets: [ticket('Add subtract'), ticket('Add subtract')],
    });
    expect(issues.ok === false && issues.issues.join(' ')).toContain('tickets');
  });

  it('the escalate-reason rule is enforced by us, not by the JSON Schema', () => {
    // Documented gap, asserted so it cannot be mistaken for CLI-side coverage:
    // `z.toJSONSchema` drops `.refine()`, so the CLI would happily return
    // `outcome: escalate` with a null reason. `validateAgentOutput` is what
    // catches it, which is why spec §5 rule 1's second validation is not
    // optional belt-and-braces here — it is the only enforcement.
    const document = JSON.stringify(jsonSchemaFor('pm'));
    expect(document).not.toContain('escalate_reason_required');

    const verdict = validateAgentOutput('pm', {
      ...validOutput('pm'),
      outcome: 'escalate',
      escalate_reason: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.issues.join(' ')).toContain('escalate_reason');
  });

  it('validateAgentOutput reports every issue and accepts a good payload', () => {
    expect(validateAgentOutput('developer', validOutput('developer'))).toEqual({ ok: true });

    const bad = validateAgentOutput('developer', { outcome: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.issues.length).toBeGreaterThan(1);

    expect(validateAgentOutput('developer', null).ok).toBe(false);
    expect(validateAgentOutput('developer', 'a string').ok).toBe(false);
  });

  it('every role has both a zod schema and a converted JSON Schema, and nothing else does', () => {
    expect(Object.keys(AGENT_SCHEMAS).sort()).toEqual([...ROLES].sort());
    expect(Object.keys(AGENT_JSON_SCHEMAS).sort()).toEqual([...ROLES].sort());
  });

  it('review findings carry a severity from the documented set', () => {
    const withBadSeverity = {
      ...validOutput('code_reviewer'),
      findings: [{ file: 'a.ts', line: 1, severity: 'catastrophic', message: 'no' }],
    };
    expect(schemaFor('code_reviewer').safeParse(withBadSeverity).success).toBe(false);

    for (const severity of REVIEW_SEVERITIES) {
      const payload = {
        ...validOutput('code_reviewer'),
        // Paired with `request_changes` because a blocking severity beside an
        // `approve` is now a refused contradiction, tested above. The point of
        // this case is the severity vocabulary, so it is asserted against a
        // verdict that is coherent with every member of it.
        verdict: 'request_changes',
        findings: [{ file: 'a.ts', line: null, severity, message: 'a finding' }],
      };
      expect(schemaFor('code_reviewer').safeParse(payload).success, `severity ${severity}`).toBe(true);
    }
  });
});

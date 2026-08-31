---
description: Gate 3 — phased implementation plan with per-phase tests
model: opus
---

## ROLE

You are in Gate 3 — Plan.
You have a reviewed and approved feature spec from Gate 2.
Your job is to produce a detailed, phased implementation plan
that includes both implementation steps AND a full test plan
for each phase — unit tests and integration tests.
Do NOT write any code. Do NOT write actual test code.
Plan only.

## CONTEXT

- Read /docs/features/[feature-id]-technical.md
- Re-read any files flagged as [NEEDS VERIFICATION] in Gate 2
  and resolve them now before producing the plan

## INSTRUCTION — Produce this exact output

### Section A — Resolved uncertainties

For each [NEEDS VERIFICATION] item from Gate 2:
what you found in the code and how it affects the plan.

### Section B — Implementation phases

Each phase must follow this exact format:

---

**Phase [N] — [Short name]**

Goal: One sentence describing what this phase achieves.

Implementation changes:

- [file or constant name]: what changes and why
- [file or constant name]: what changes and why
  (name the actual file, function, config key — be specific)

Unit tests to write:

- [test file path]: what to test and why
  - [ ] [specific test case]
  - [ ] [specific test case]

Integration tests to write:

- [ ] [end-to-end scenario]
- [ ] [regression scenario — existing behaviour unchanged]

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] [any additional manual check if needed]

Risk: Low / Medium / High — one sentence why.
Touches shared/core files: Yes / No — list them if Yes.

---

Repeat for every phase.

### Section C — Full test summary

List every test file that will be created or modified across all phases.

**New test files:**

- [path]: covers [what]

**Modified test files:**

- [path]: what is being added

**Regression test targets:**
List existing tests that must still pass after all phases are complete.

### Section D — Recommended PR structure

Should this be one PR or multiple?
If multiple, which phases go together and why?
Note: each PR should include both implementation and its tests together —
never implementation without tests.

### Section E — What must NOT change

List existing behaviours that must be preserved exactly.
These map directly to the regression tests in Section C.

### Section F — ADR update

If Gate 2 flagged an architecture decision:

- Draft the ADR (Context / Decision / Consequences) using `docs/adr/TEMPLATE.md`
- Give it the next `NNN-slug` number and note whether it supersedes an existing ADR
- Do not add the ADR to `docs/adr/` yet — I will approve this separately

### Section G — Feature done checklist

Copy this into the plan. Every item must pass before the feature is closed.

- [ ] All phases complete and committed
- [ ] Full test suite green (see `.claude/README.md` — Test commands)
- [ ] E2E tests pass if the plan includes E2E coverage
- [ ] Plan doc updated with final session summary (`/session-summary [feature-id]`)
- [ ] PR open and linked to feature docs
- [ ] New/updated ADR added to `docs/adr/` (if Section F required it)

## OUTPUT

Save this plan to: /docs/features/[feature-id]-plan.md

## CONSTRAINT

Do NOT use Claude Code's native plan/execute flow.
Do NOT create or update files under ~/.claude/plans/.
Do NOT ask to proceed with implementation.
Save only the plan document described above.
Do not write any code or actual test code.
Do not begin implementation.
Wait for my explicit "approved, start Phase 1" message.
When I approve, ask me: "Should I add the ADR to docs/adr/ first,
or start Phase 1 implementation and tests?"

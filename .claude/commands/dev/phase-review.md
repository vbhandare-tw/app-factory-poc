---
description: Review one implementation phase against the plan (report only)
argument-hint: [feature-id] [phase-number]
---

## ROLE

You are doing a phase review for the feature and phase I specify.
Do not start the next phase. Do not make any changes.
Report only.

## CONTEXT

- Feature-id and phase number: from $ARGUMENTS (e.g. `error-handling-e2e 3`) or I will state them in chat
- Read /docs/features/[feature-id]-plan.md
- Focus only on the requested phase done conditions and planned changes

## INSTRUCTION — Produce this exact output

### 1. Files changed

List every file created or modified in this phase.
For each file: one sentence on what changed and why.

### 2. Test results

Run the test command(s) named in this phase of the plan (unit/integration for this phase). Show the full output.

Then run the full workspace test suite (see `.claude/README.md` — Test commands). Show the summary line.
If any tests that were passing before this phase are now failing, flag them immediately — do not proceed.

### 3. Done conditions

Copy each done condition from this phase in the plan.
Mark each one:

- [PASS] — confirmed passing
- [FAIL] — not passing, explain why
- [PARTIAL] — partially done, explain what is missing

### 4. Deviations from plan

Did anything get implemented differently from what the plan described?
If yes: what changed, why, and does it affect any later phases?
If no: state "No deviations."

### 5. Recommendation

Based on the above — is this phase ready to approve?
Yes / No — one sentence reason.

## CONSTRAINT

Do not start the next phase.
Do not make any fixes or changes.
Wait for my explicit approval before proceeding.

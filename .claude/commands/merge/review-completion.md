---
description: Final pre-PR review — acceptance criteria, tests, housekeeping
---

## ROLE

You are performing a final review pass after completing a body of work (multi-phase feature or stories). Do not make changes — report only.

## CONTEXT

- Read `/docs/features/[feature-id]-plan.md` when work used the 4-gate feature flow
- Or read story PLAN/TASKS paths from `.claude/README.md` — Feature docs when work used the story-doc flow
- Use `git log` and `git diff` against [base-branch] (default: main) to understand the full scope of changes

## INSTRUCTION — Produce this exact output

### 1. Acceptance criteria check

For each story or feature done checklist item:

- [PASS] — confirmed
- [FAIL] — not met, explain
- [PARTIAL] — partially met, explain what is missing

### 2. Dead code and stale references

Scan for:

- Unused imports, constants, types, or functions introduced or left behind
- Commented-out code that should have been deleted
- Stale references in test fixtures or mocks

List findings or state "None found."

### 3. Test coverage gaps

For each new or significantly modified component/function:

- Does it have tests? If not, flag it.
- Are existing tests still valid after the changes?

### 4. Open questions and tech debt

- List any unresolved open questions from plan or TASKS docs
- Flag any code smells, duplication, or patterns that should be addressed
- Note any pre-existing issues encountered during implementation

### 5. Housekeeping

- Are there temp files, spike artifacts, or stashed directories to clean up?
- Is documentation (plan, TASKS, feature docs) up to date?
- Are commit messages clear and well-scoped?

### 6. Code-review-fix check

- If no `docs/features/[feature-id]-plan.md` exists — mark **N/A**, this is not a gated feature.
- Otherwise look for evidence `/dev:code-review-fix` ran: a commit matching
  `git log [base-branch]..HEAD --grep "^code-review-fix:"`, or a dated row in the plan's Delivery ledger.
- Found → **[PASS]** — summarize what it found, fixed, and rejected.
- Not found → **[FAIL]** — recommend running `/dev:code-review-fix [feature-id]` before merge; this
  pass catches cross-phase issues no single `/phase-review` ever saw.

### 7. Recommendation

Overall assessment — is this work ready for PR/review?
List any items that should be addressed before merging, in priority order.

## CONSTRAINT

Do not make any fixes or changes.
Report only. Wait for explicit instructions before acting on findings.

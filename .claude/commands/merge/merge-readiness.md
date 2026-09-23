---
description: Pre-merge checklist — blockers vs nice-to-haves
argument-hint: [base-branch]
---

## ROLE

You are assessing whether this branch is ready to merge.
Do not make changes unless I ask. Report only.

## CONTEXT

- `git diff [base-branch]...HEAD --stat` (base: $ARGUMENTS or main)
- Run all four gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Never the paid
  suites (`test:all`, `test:isolation`, any `FACTORY_REAL_*`) — those spawn live agents and cost money.
- Read feature plan done checklist or story acceptance criteria if docs exist
- Check for a `/dev:code-review-fix` pass: skip entirely if there is no
  `docs/features/[feature-id]-plan.md` — not a gated feature. Otherwise look for
  `git log [base-branch]..HEAD --grep "^code-review-fix:"` or a dated row in the plan's Delivery ledger.

## INSTRUCTION — Produce this exact output

### 1. Blockers (must fix before merge)

List items that would fail CI, break main, or violate acceptance criteria.

### 2. Should fix (strong recommendation)

Tests, docs, or code quality issues that are not strict blockers. For a gated feature, include a missing
`/dev:code-review-fix` pass here — it catches cross-phase issues no single `/phase-review` ever saw.
Omit this line entirely if the branch is not a gated feature (no plan doc).

### 3. Nice to have (optional)

Improvements safe to defer to a follow-up.

### 4. Verification run

Summarize lint, test, and (if applicable) command-library sync script results (pass/fail, counts).

### 5. Verdict

**Ready to merge** / **Not ready** — one paragraph justification.

## CONSTRAINT

Do not open a PR or merge. Wait for my decision.

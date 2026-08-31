---
description: Pre-merge checklist — blockers vs nice-to-haves
argument-hint: [base-branch]
---

## ROLE

You are assessing whether this branch is ready to merge.
Do not make changes unless I ask. Report only.

## CONTEXT

- `git diff [base-branch]...HEAD --stat` (base: $ARGUMENTS or main)
- Run lint and full test suite per `.claude/README.md` — Test commands
- Read feature plan done checklist or story acceptance criteria if docs exist
- If this branch changes `.claude/commands/`, edit in **IDEX (base repo)** first, mirror to TSP, run `./scripts/diff-claude-commands.sh` (see Contributing in `.claude/README.md`) and report pass/fail

## INSTRUCTION — Produce this exact output

### 1. Blockers (must fix before merge)

List items that would fail CI, break main, or violate acceptance criteria.

### 2. Should fix (strong recommendation)

Tests, docs, or code quality issues that are not strict blockers.

### 3. Nice to have (optional)

Improvements safe to defer to a follow-up.

### 4. Verification run

Summarize lint, test, and (if applicable) command-library sync script results (pass/fail, counts).

### 5. Verdict

**Ready to merge** / **Not ready** — one paragraph justification.

## CONSTRAINT

Do not open a PR or merge. Wait for my decision.

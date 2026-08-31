---
description: Walk through the branch diff like an experienced PR reviewer
argument-hint: [base-branch]
---

## ROLE

You are walking me through this change the way an experienced reviewer would.
Do not make changes. Explain clearly for someone unfamiliar with the diff.

## CONTEXT

- `git diff [base-branch]...HEAD` (base branch: $ARGUMENTS or main)
- `git log [base-branch]..HEAD --oneline`
- Read related `docs/features/` plan or technical doc if the branch name or commits suggest a feature-id

## INSTRUCTION — Produce this exact output

### 1. Problem and intent

What problem does this solve? What is the intended design?

### 2. Walkthrough by area

Group changes logically (not file-by-file alphabetically). For each area:

- What changed and why it matters
- Anything clever or non-obvious

### 3. Likely review comments

Where might reviewers push back? Be specific (files, patterns, missing tests).

### 4. Tradeoffs

What alternatives were implied? What did we gain vs give up?

### 5. Questions for the author

Only questions that would block approval or require a design decision.

## CONSTRAINT

Report only. Do not suggest drive-by refactors outside this change scope.

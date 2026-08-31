---
description: Append session handoff to feature plan before /clear
argument-hint: [feature-id]
---

## ROLE

You are creating a session summary before the context is cleared.
Do not make any changes to any files except the plan document.

## CONTEXT

- Feature-id: from $ARGUMENTS or I will state it in chat
- Read /docs/features/[feature-id]-plan.md

## INSTRUCTION — Produce this exact output

### 1. Phases completed this session

List each phase completed with one sentence on what was built.

### 2. Files created or modified

List every file touched across all phases this session.
For each file: what changed.

### 3. Deviations from original plan

List anything implemented differently from the plan.
For each deviation: what changed, why, and whether the
plan document was updated to reflect it.

### 4. Current state

Which phase are we on right now?
Is it complete or mid-flight?
If mid-flight: what was the last thing done and what
is the next step?

### 5. Watch out for

Anything the next session should be careful about.
eg: a shared file that was modified, a pending
decision, an unresolved deviation, a failing test
that was deferred.

### 6. Next action

Exact message the next session should start with
to resume cleanly from where we left off.

## OUTPUT

Append this summary to /docs/features/[feature-id]-plan.md
under a section called "## Session log — [today's date]"
Do not overwrite anything already in the file.
End your response with exactly this line:
SESSION_SUMMARY_COMPLETED

## CONSTRAINT

Do not make any other changes.
Do not start any new work.
After saving, confirm the summary was saved and
tell me it is safe to run /clear.

---
description: Reload feature context from plan after /clear
argument-hint: [feature-id]
---

## ROLE

You are resuming an in-progress feature after a context clear.
Do not make any changes. Read the plan and confirm current state first.

## CONTEXT

- Feature-id: from $ARGUMENTS or I will state it in chat
- Read /docs/features/[feature-id]-plan.md

## INSTRUCTION — Produce this exact output

### 1. Feature summary

One paragraph: what is this feature and what problem does it solve?

### 2. Progress to date

Which phases are complete? Which is in progress?
List completed phases with one sentence on what was built.

### 3. Current state

What was the last thing done?
What is the very next step?

### 4. Watch out for

Copy the "Watch out for" section from the latest session log entry.
If no session log exists, state "No session log found — proceeding with caution."

### 5. Ready to continue

State exactly:
"I have read [feature-id]-plan.md. Phases [X, Y, ...] are complete.
Currently on Phase [N]. Next step: [exact next action].
Ready for your instruction."

## CONSTRAINT

Do not start any work.
Do not make any changes.
Wait for my explicit instruction after confirming state.

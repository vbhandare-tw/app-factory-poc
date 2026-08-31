---
description: Gate 1 — understand the use case before analysis or code
model: opus
---

## ROLE

You are in Gate 1 — Understand.
Your only job is to deeply understand the use case I am about to give you.
Do NOT analyse, do NOT suggest solutions, do NOT write code.

## CONTEXT — Read these files before responding

- Read the files I reference in the use case below
- Read any constants, role definitions, permission configs relevant to the feature area
- Read any existing components I mention as reference
- Confirm you have read them by listing what you found

## USE CASE

[PASTE YOUR USE CASE HERE]

## INSTRUCTION — Produce this exact output (Gate 1 format only)

### Section A — What I understood

Summarise the feature in plain English in 4–5 sentences.
No technical terms. Write it as if explaining to someone new to the project.

### Section B — Assumptions I am making

List every assumption you are making about behaviour, roles, data, or UI.
Number each one. Be specific.

### Section C — Clarifying questions

List every question that, if answered differently, would change how this is built.
Group them by:

- Business / product questions (for your PM)
- Technical questions (you can answer by reading more code)
- UX / edge case questions (need design decision)

### Section D — Files I need to read for Gate 2

List any additional files or constants you want to read before doing analysis.
I will confirm and then we move to Gate 2.

## CONSTRAINT

Do NOT use Claude Code's native plan/execute flow.
Do NOT create or update files under ~/.claude/plans/.
Do NOT ask to proceed with implementation.
Reply in chat with Sections A–D only — no other files.

Stop after producing Sections A–D.
Do not proceed to analysis or planning.
Wait for my response before continuing.

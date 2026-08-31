---
description: Explain one phase in plain language before approving it
argument-hint: [phase-number] [feature-id]
---

## ROLE

Explain Phase $ARGUMENTS to the developer so they can decide whether to approve it.

They are time-constrained. This is a **60-second read**, not a reference document.
If they want more depth on any part, they will ask. Your job is to give them
enough to approve or push back — nothing more.

## CONTEXT

- Read `docs/features/[feature-id]-plan.md` and focus **only** on the named phase
- Skim the actual files the phase touches, so the explanation matches the real code
  rather than what the plan predicted

## HARD LIMITS

Obey these. They are the point of this command.

- **Total output: one screen. Roughly 350 words.** If you exceed it, cut content —
  do not shrink the font of the argument by compressing words into jargon.
- Five sections maximum, in the order below. Skip any that do not apply —
  omit the heading entirely, never write "none" or "N/A".
- No code blocks. No component trees. No data-flow diagrams. No dependency chains.
- Do not restate the plan document. Do not list test cases.

## WORDING RULES

These matter more than the format. Vague wording is the failure mode this command exists to fix.

1. **Name the real thing.** Never "the DB rows", "the table", "the store", "the config".
   Write the actual table, file, or constant: `troubleshooter_shared_widgets`,
   `use-widget-layout.js`, `CONFIG_DRIVEN_SECTIONS`. If a project has several tables that
   a phrase could mean, naming the wrong one inverts the meaning — so always name it.
2. **Never use a short form the codebase invented.** `defs`, `cards`, `recipes` mean nothing
   outside this repo. Write "widget definition rows". Expand on first use or don't use it.
3. **Prefer the everyday word.** Not "supersede" — "replace". Not "propagate" — "pass down".
4. **The test:** would this sentence make sense to someone who has not read the plan doc?
   If not, rewrite it.

Worked example — this is the standard:

- ❌ "Stop a config-driven section whose DB rows are missing from rendering as a blank tab
  with no notice."
- ✅ "If the Problems tab has no widget rows in `troubleshooter_shared_widgets`, it currently
  shows a completely blank page — no widgets, no error, no Retry button, as if empty is normal.
  After this phase it shows a red error with a Retry button."

## OUTPUT

### In plain terms

Max 80 words. What is different **for a person using the app** after this phase, and why that
matters. No file names here. If the phase is invisible to users (a refactor, a migration that
nothing reads yet), say so plainly and say what it sets up.

### What changes

One table. Max 8 rows. Collapse related files into one row rather than spilling over.

| File | What it does now | Why |
| ---- | ---------------- | --- |

### What could break

Max 3 bullets. The real risks, most likely first. Name the file or behaviour that would
break, not a category of risk.

### Check these yourself

Max 3 bullets. Specific actions in the browser or an API client — a click, a URL, a
response field. Not "run the tests".

### Surprises

Only if this phase does something a reasonable developer would not expect — a deviation from
the plan, or a choice where the obvious alternative was rejected. Max 2 bullets, one line each:
what was chosen, and why not the obvious thing. Skip this section entirely if there are none.

Close with a single line: **Read first:** one file name, and why it is the entry point.

## CONSTRAINT

Do not start implementation. Do not show code.
Stop after the explanation and wait for the developer's response.

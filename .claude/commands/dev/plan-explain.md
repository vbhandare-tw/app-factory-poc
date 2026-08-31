---
description: Explain the Gate 3 plan in plain language before approving it
argument-hint: [feature-id]
---

## ROLE

Explain the plan for $ARGUMENTS so the developer can approve it or push back.

They are time-constrained. This is a **90-second read** covering a whole feature,
not a reference document. If they want depth on one phase, they will run
`/phase-explain N`. Give them enough to judge the shape of the plan — nothing more.

## CONTEXT

- Read `docs/features/[feature-id]-plan.md` (the phased plan)
- Read `docs/features/[feature-id]-technical.md` (the technical spec)

## HARD LIMITS

Obey these. They are the point of this command.

- **Total output: roughly 500 words.** If you exceed it, cut content — do not
  compress words into jargon to fit.
- Five sections maximum, in the order below. Skip any that do not apply —
  omit the heading, never write "none".
- No diagrams, no arrow chains, no component trees, no glossary table.
  If a term needs explaining, gloss it inline in parentheses at first use.
- Do not restate the plan section by section. Do not list test cases.

## WORDING RULES

These matter more than the format. Vague wording is the failure mode this command exists to fix.

1. **Name the real thing.** Never "the DB rows", "the table", "the store", "the config".
   Write the actual table, file, or constant: `troubleshooter_shared_widgets`,
   `use-widget-layout.js`, `CONFIG_DRIVEN_SECTIONS`.
2. **Never use a short form the codebase invented** (`defs`, `cards`, `recipes`). Write
   "widget definition rows". Expand on first use or don't use it.
3. **Prefer the everyday word.** Not "supersede" — "replace". Not "propagate" — "pass down".
4. **The test:** would this sentence make sense to someone who has not read the plan doc?
   If not, rewrite it. ❌ "an empty defs set becomes visible" → ✅ "if a tab has no widget rows
   in `troubleshooter_shared_widgets`, it now shows an error instead of a blank page".

## OUTPUT

### In plain terms

Max 100 words. What can a person do after this feature that they could not before — or,
if it is invisible to users (a refactor, a migration), say so plainly and say what it enables
later. No file names here.

### The phases

One table. One row per phase. This replaces any narrative walkthrough.

| # | What it does (plain words) | Where | Risk | You'll know it worked when |
| - | -------------------------- | ----- | ---- | -------------------------- |

"Where" is one of: frontend / backend / database / tests / docs.

### Why this order

Max 80 words. Name the one or two orderings that would actually break, and what would break.
Skip any phase whose position is arbitrary — do not justify every phase.

### Decisions worth knowing

Max 3 bullets, one line each: what was chosen, and what the obvious alternative was that
someone might otherwise "fix" later. Skip the section if the plan has no such choices.

### The mental model

Max 50 words. If the developer remembers one thing about how this feature works, what is it?

Close with a single line: **Biggest risk:** which phase, and why.

## CONSTRAINT

Do not write code or tests. Do not modify the plan.
Stop after the explanation and wait for the developer's response.

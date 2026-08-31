---
description: Map a phase's diff back to the use cases it moves forward
argument-hint: [phase-number] [feature-id]
---

## ROLE

You are explaining the changes of one implementation phase so the developer
can review them — with every change mapped back to the use cases (UC ids)
they already understand from `/preview-behaviour`.

The developer reviews top-down: which behaviours moved forward → which
changes did it → the diff. And bottom-up: any change they don't understand
carries a UC pointer back to the behaviour walkthrough.

The developer is time-constrained. Keep every description small and clear —
**one line per bullet**, and a Change section must fit on one screen. Skip any
bullet that does not apply; never write "N/A".

## WORDING RULES

These matter as much as the structure. Vague wording is what makes these
explanations unreadable.

1. **Name the real thing.** Never "the DB rows", "the table", "the store", "the
   config" — write the actual table, file or constant (`troubleshooter_shared_widgets`,
   `use-widget-layout.js`, `CONFIG_DRIVEN_SECTIONS`). Where a project has several
   tables a phrase could mean, naming the wrong one inverts the meaning.
2. **Never use a short form the codebase invented** (`defs`, `cards`, `recipes`) —
   write "widget definition rows". Expand on first use or don't use it.
3. **Prefer the everyday word.** Not "supersede" — "replace". Not "propagate" — "pass down".
4. **Describe effects as user-visible symptoms where you can.** ❌ "defaults resolve to
   the static leftover" → ✅ "the tab shows 7 tiles that are permanently empty, with no
   error message".
5. Gloss any remaining specialist term on first use, in parentheses.

## CONTEXT

- Argument: phase number (feature-id from the active feature plan in
  /docs/features/, or the developer states it in chat)
- Read /docs/features/[feature-id]-behaviour.md — the UC index and
  walkthrough written by `/preview-behaviour`. **This is the anchor.**
  If it does not exist, say so and offer to run `/preview-behaviour` first;
  only if the developer declines, derive UC ids yourself from the gate docs
  and mark every one `[derived — run /preview-behaviour to lock ids]`.
- Read the feature plan's Phase N section for what was supposed to change.
- Run `git diff` (or `git diff <last-phase-commit>..HEAD` / `git status`)
  scoped to the phase's files. **The explanation must match the diff 1:1** —
  every changed file appears in exactly one Change section (tests may be
  grouped), and no Change may describe something not in the diff.
- Read the actual source files so every statement is from the working tree,
  never reconstructed from memory or the plan.

## INSTRUCTION — Produce this exact output

### Summary of changes

2–3 sentences: what this phase did in behaviour terms, and whether it is
user-visible or groundwork.

### UC coverage after this phase

| UC | Use case | After Phase N | Built by |
| -- | -------- | ------------- | -------- |

Status legend (include it under the table):
- ✅ working — a user can do this now
- 🟡 groundwork — plumbing exists and is tested, but not user-visible yet
- ⬜ later phase — untouched this phase

List every UC from the behaviour doc, including the ⬜ ones (one row each —
the developer must see what did NOT move). "Built by" names the Change
numbers below.

### Change 1 … Change N

One section per logical change (a file may hold two changes; two files may
form one change — follow the logic, but stay 1:1 with the diff overall).
Order by importance, implementation before tests.

**Change N — <short name>**

- **Serves:** UC-x (*quote the UC's one-liner from the behaviour doc*) —
  or **Foundation** if it serves no UC directly (see below)
- **Its role in the UC:** one line — which part of that behaviour this
  change is (the click? the fetch? the drawing? the guard?)
- **File:** path (+added/−removed)
- **What changed:** before → after, one line
- **Loaded via:** import/component chain to where it executes — only for
  components/hooks/modules (e.g. `WidgetGrid → WidgetTile → useWidgetData`)
- **Effect:** what behaves differently now — or "inert until Phase N+1
  (<what activates it>)"
- **State:** only if state is touched — name it and say local (component),
  global (context/URL), or persisted (URL param / localStorage / server)
- **API:** only if a fetch or endpoint is touched — endpoint, key params,
  how success/failure/stale responses are handled, and the one thing that
  matters about the call (e.g. "exact-match dtc, never prefix")
- **Covered by:** the test file + case name(s) that pin this change

Skip any bullet that does not apply — no "N/A" lines.

### Foundation changes (no direct UC)

Changes serving no use case directly (refactor, guard, type fix) go here
with the same bullet shape. If this bucket is large, say so explicitly —
that is itself a review flag (the phase drifted from behaviour).

### Test files changed

| File | Added |
| ---- | ----- |

One line each ("new — 6 geometry cases", "+2 cases via registry fixtures").
Tests are evidence, not behaviour — never a numbered Change of their own.

## Backend changes

Backend changes use the same per-change structure — no separate trace
format. For a change that adds/modifies an endpoint, the **API** bullet
expands to at most four sub-lines:

- Example request: one realistic URL with query params
- Validation: what the route schema rejects (zod), what the use-case rejects
- Security: tenant scoping + parameter binding (the value travels separately
  from the SQL text so input can never rewrite the query) — one line
- Response: the shape the frontend consumer reads

## CONSTRAINT

Report only — do not make any changes.
Do not start or continue any implementation phase.
Every statement must be verifiable against the current git diff and working
tree; if the plan and the code disagree, report the code and flag the drift.
Keep each bullet to one line where possible; a Change section should fit on
one screen.

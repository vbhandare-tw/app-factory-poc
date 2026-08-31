---
description: Explain what a phase's tests actually protect, and what they don't
argument-hint: [phase-number] [feature-id]
---

## ROLE

Explain the tests written for Phase $ARGUMENTS so the developer can approve them.

They are time-constrained. This is a **60-second read**. The single most useful thing
you can tell them is **what breaks in the product if each test fails** — and where the
safety net has holes. Everything else is secondary.

## CONTEXT

- Read `docs/features/[feature-id]-plan.md` for the named phase's test plan and its
  done conditions
- Read the actual test files written for this phase, so the explanation reflects what
  was really tested rather than what was planned

## HARD LIMITS

Obey these. They are the point of this command.

- **Total output: roughly 400 words.** If you exceed it, cut content.
- Five sections maximum, in the order below. Skip any that do not apply — omit the
  heading, never write "none".
- No test code. Test *names* only.
- Cover only the tests **this phase added or changed**. Do not inventory pre-existing tests.
- If the phase added more than ~12 tests, group the routine ones into a single row
  ("6 cases pinning the UUID-bucketing rules") rather than listing each.

## WORDING RULES

These matter more than the format.

1. **Name the real thing.** Never "the DB rows", "the store", "the config" — write the actual
   table, file or constant (`troubleshooter_shared_widgets`, `use-widget-layout.js`).
2. **Never use a short form the codebase invented** (`defs`, `cards`). Write "widget definition
   rows". Expand on first use or don't use it.
3. **Prefer the everyday word.** Not "supersede" — "replace".
4. **Describe failures as user-visible symptoms, not internal states.** ❌ "defaults resolve to
   the static leftover" → ✅ "the Problems tab shows 7 tiles that are permanently empty, with no
   error message".

## OUTPUT

### The strategy

Max 60 words. What is tested heavily, what is tested lightly, and why that split is right
for this phase.

### What each test protects

Group by file. For each test, one row:

| Test | What breaks in the product if this fails |
| ---- | ---------------------------------------- |

Plain symptoms in the right-hand column — what the user or developer would actually see.

### Not covered by tests

Max 4 bullets. Behaviour in this phase that automated tests do **not** protect, and why
(mocked boundary, needs a real browser, needs a real database, design review). This is the
highest-value section — it stops the developer assuming coverage that isn't there.

### Done conditions with no test

Any done condition in the phase plan that no test verifies. State it plainly and say what
manual check covers it instead. Skip the section if every condition has a test.

### The one that matters most

One or two lines. If only one test from this phase could be kept, which — and what regression
does it prevent?

## CONSTRAINT

Do not write or modify tests. Do not show test code. Do not start implementation.
Stop after the explanation and wait for the developer's response.

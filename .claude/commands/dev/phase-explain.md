---
description: Explain one plan phase to the developer, plain English, before they approve it
argument-hint: [feature-id] [phase-number]
---

## ROLE

You are explaining Phase [phase-number] to the developer before they approve it. The goal is
understanding, not approval pressure. Use plain English. No code blocks unless showing a file path, a
component tree, or a data-flow arrow chain. Be concise — favour clarity over completeness. If a section
does not apply to this phase, omit it entirely rather than writing "none".

## CONTEXT

- Feature-id and phase number: from $ARGUMENTS (e.g. `error-handling-e2e 3`) or I will state them in
  chat.
- Check the plan's **Delivery ledger** first — it is this project's session-scoped index and says which
  phases are done, at which commit, with what carried forward. There is no `TASKS.md` here.
- Plans live in exactly one place: `docs/features/[feature-id]-plan.md`. There is no `docs/technical/`
  tree.
- Focus only on the requested phase.
- Read the files the phase actually touches (from `git diff` or the phase's file list) so the
  explanation reflects the real code, not just the plan's intent.

## INSTRUCTION — Produce this exact output

### 1. Summary

One paragraph, plain English — what this phase achieves from the user's point of view.

Group every file change into the categories below. Only include categories that have changes in this
phase.

### 2. Frontend changes

For each new or modified component/file:

**Component tree position**
```
<ParentComponent>
  └─ <ThisComponent>          ← new / modified
       └─ <ChildComponent>
```

**File:** path/to/file.tsx
**What changed:** one sentence
**Why it exists:** one sentence — what problem it solves and why a separate file rather than modifying
an existing one
**API calls:** GET /endpoint — when called, what triggers it
**Connected to:** files it imports from / exports to in this phase

### 3. Backend changes

For each new or modified endpoint/service:

**Endpoint:** METHOD /api/path
**File:** path/to/file.ts
**What changed:** one sentence
**Logic flow:** 1. step → 2. step → 3. step (max 5)
**Connected to:** files this calls or is called by

### 4. Database / schema changes

**File:** path/to/schema.ts
**Table/collection affected:** name
**What changed:** field added/removed/type changed/index — specific
**Why:** one sentence
**Impact:** what breaks if this migration is not run
**Referenced in codebase:** files in this phase that read/write it

### 5. Everything else

| File | What changed | Why |
|---|---|---|

### 6. File change summary

Complete inventory — usable as a PR description.

| File | New/Modified | Category | One-line purpose |
|---|---|---|---|

### 7. Data flow

```
User action / trigger
  → what fires first → what calls what
  → where data is stored/returned → what the user sees
```
Only steps this phase introduces or changes.

### 8. State ownership map

| State / data | Owned by | Read by | Persisted? |
|---|---|---|---|

### 9. Before and after

**Before this phase:** how it worked (or "did not exist")
**After this phase:** what is different, what it enables
**Why the old approach was not enough:** one sentence

### 10. Dependency chain

Tells the developer reading order:

```
1. foundation-file.ts     ← no dependencies in this phase
2. service-file.ts        ← depends on 1
3. component-file.tsx     ← depends on 2
```

### 11. Concepts introduced

2-3 plain sentences per genuinely new pattern. Skip if none.

### 12. Decisions worth knowing

Non-obvious choices: what was chosen, the obvious alternative, one-line reason. Skip if none.

### 13. Glossary

| Term | Meaning |
|---|---|
Skip if no specialised terms.

### 14. Answer these questions

1. The one thing that could go wrong in this phase.
2. What to manually verify after this phase (2-3 concrete user actions, not "run the tests").
3. If this phase breaks something, it will most likely be: [most likely regression + where to look
   first].
4. The file I should read first to understand this phase, and why.
5. What I should be able to explain to a teammate: 2-3 sentences summarising this phase.

## CONSTRAINT

Do not start implementation. Do not show actual code. Wait for the developer to say "Phase [N]
explanation looks good, proceed" before doing anything else.

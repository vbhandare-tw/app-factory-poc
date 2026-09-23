---
description: Explain the Gate 3 plan to the developer, plain English, before any code is written
argument-hint: [feature-id]
---

## ROLE

You are explaining the Gate 3 plan to the developer so they understand the whole feature before any
code or tests are written. This is the foundation — if the developer understands the plan here,
reviewing tests and code later becomes easy. Use plain English. No code. Favour clarity over
completeness.

## CONTEXT

- Feature-id: from $ARGUMENTS or I will state it in chat.
- Check the plan's **Delivery ledger** first — it is this project's session-scoped index and says which
  phases are done, at which commit, with what carried forward. There is no `TASKS.md` here.
- Plans live in exactly one place: `docs/features/[feature-id]-plan.md`, alongside
  `[feature-id]-technical.md`. There is no `docs/technical/` tree.
- Read the ADRs in `docs/adr/` — top of the doc precedence — for section 2 below (how this feature fits
  the existing system).
- This covers the whole plan, every phase — not one phase. Use `/dev:phase-explain [feature-id] [N]`
  for a single phase.

## INSTRUCTION — Produce this exact output

Explain the plan in the following order. Each section builds on the previous one, so keep them in this
sequence.

### 1. The feature in one paragraph

What does this feature let a user do that they could not before? Plain English, no jargon. A
non-developer should understand it.

### 2. The big picture — how it fits the system

Where does this feature live in the existing system? What existing parts does it touch, extend, or
depend on? Show it as a simple map:

```
Existing: [what already exists that this builds on]
  → New: [what this feature adds]
     → Touches: [existing parts that must change to support it]
```

### 3. The phases as a story

Explain why the phases are ordered the way they are. Walk through them as a narrative, not a list: "We
start with Phase 1 because [foundation reason]. Once that exists, Phase 2 can [build on it how]..."
What would break if phases were reordered?

### 4. Phase-by-phase summary

For each phase, one compact block:

**Phase N — [name]**
- In one sentence: what this phase delivers
- Depends on: which earlier phases must be done first
- The key change: the single most important thing this phase does
- Where it lives: frontend / backend / db / config
- Risk: Low / Medium / High and the one-line reason
- You will know it works when: the one observable thing that proves this phase succeeded

### 5. The data flow across the whole feature

Trace one complete user journey through all the phases, showing how the pieces built in different
phases connect:

```
User does X
  → [Phase 2's component] captures it
  → [Phase 1's endpoint] processes it
  → [Phase 3's schema] stores it
  → [Phase 4's component] displays result
```

### 6. Decisions worth knowing

The non-obvious choices in this plan where a developer might have expected something different. For
each: what was chosen, the obvious alternative, and why.

### 7. The mental model

In 3-4 sentences, give the single mental model that makes this whole feature make sense. If the
developer remembers only one thing about how this feature works, what should it be?

### 8. Glossary

Any feature-specific or domain terms:

| Term | Meaning |
|---|---|

### 9. Comprehension check

List 3-4 questions the developer should be able to answer after reading this. If they cannot answer
them, they should ask before approving.

## CONSTRAINT

Do not write any code or tests. Do not modify the plan. Wait for the developer to say the plan is
clear, or to ask questions, before proceeding to Phase 1.

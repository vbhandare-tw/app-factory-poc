---
description: Gate 2 — produce the technical feature spec
model: opus
---

## ROLE

You are in Gate 2 — Analyse.
You have already understood the use case in Gate 1.
Your job now is to produce a full technical requirement analysis.
Do NOT write implementation steps yet. Do NOT write code.

## CONTEXT — Read these files before responding

[LIST THE FILES FROM GATE 1 SECTION D HERE — the ones Claude asked for]

- Also re-read any files needed to confirm your Gate 1 assumptions

## INSTRUCTION — Produce this exact output

### Technical spec (for dev team)

Write this for a senior developer. Be specific. Name files and constants
where you are confident. Mark uncertainty with [NEEDS VERIFICATION].

Group by these sections — use all that apply:

**Constants & roles**
What new constants or role values are needed and where do they live?

**Permissions**
What new permission keys are needed following the existing pattern in CLAUDE.md?

**UI components**
Which existing components are reused? Which need modification? What is new?
Reference actual component names from the codebase.

**State management**
Any new Redux actions, selectors, or context needed?
How does new state flow through the feature?

**API**
What new endpoints are needed?
What existing endpoints are reused, and with what changes?

**Routing**
Any new routes? Any route guards that need updating?

**Configuration**
What config files change (settings, permission maps, role maps, etc.)?

---

### Section — Architecture impact

Answer these specifically:

- Does this feature warrant a new or updated ADR in `docs/adr/`? Yes / No / Maybe
  (See `docs/adr/README.md` — write one only for structural / stack / cross-cutting / dependency
  decisions, not for feature-level or easily reversible choices.)
- If yes, which existing ADR does it touch or supersede (`NNN-slug`), or is it a brand-new ADR, and what is the proposed decision?
- Do not add or edit ADRs yet — list the proposed change here for my approval

---

### Section — Open items

- Assumptions made that I should verify with the PM
- Parts of the codebase you could not find or were uncertain about
- Anything that should be discussed before Gate 3

## OUTPUT

Save the technical spec to: /docs/features/[feature-id]-technical.md
Do not save the Architecture Impact or Open Items sections —
paste those directly in the chat for my review.

## CONSTRAINT

Do NOT use Claude Code's native plan/execute flow.
Do NOT create or update files under ~/.claude/plans/.
Do NOT ask to proceed with implementation.
Save only the technical feature spec file and chat sections described above.
Do not produce a non-technical / UI spec.
Do not propose an implementation plan yet.
Wait for my approval and any corrections before moving to Gate 3.

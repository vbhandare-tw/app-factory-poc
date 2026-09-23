---
description: Gate 2 — produce non-technical and technical feature specs
---

## ROLE

You are in Gate 2 — Analyse.
You have already understood the use case in Gate 1.
Your job now is to produce a full requirement analysis in TWO separate versions.
Do NOT write implementation steps yet. Do NOT write code.

## CONTEXT — Read these files before responding

[LIST THE FILES FROM GATE 1 SECTION D HERE — the ones Claude asked for]

- Also re-read any files needed to confirm your Gate 1 assumptions

## INSTRUCTION — Produce this exact output

> **Backend-only or no user-facing change?** Skip VERSION 1. State explicitly in chat: `"VERSION 1 skipped — backend-only change, no user-facing UI."` Save only VERSION 2. Skip to the Architecture Impact section.

---

### VERSION 1 — Non-technical (for PM / designer review)

Write this as if the reader has never seen the codebase.
No component names, no file paths, no API references.

Cover:

- What the user sees at each step of this feature
- Full user journey for every new capability (use numbered steps)
- What dialogs, forms, buttons, confirmations appear
- How this is consistent with existing UI patterns the user already knows
- Edge cases from a user perspective (what if no data exists, what if action fails)

Format: One section per user journey. Clear headings. Numbered steps.

---

### VERSION 2 — Technical overview (for dev team)

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

- Does this feature require changes to the ADRs in `docs/adr/`? Yes / No / Maybe
- If yes, what sections change and what is the proposed ADR entry?
- Do not update the ADRs in `docs/adr/` yet — list the proposed changes here for my approval

---

### Section — Open items

- Assumptions made that I should verify with the PM
- Parts of the codebase you could not find or were uncertain about
- Anything that should be discussed before Gate 3

## OUTPUT

Save VERSION 1 to: /docs/features/[feature-id]-nontechnical.md
Save VERSION 2 to: /docs/features/[feature-id]-technical.md
Do not save the Architecture Impact or Open Items sections —
paste those directly in the chat for my review.

## CONSTRAINT

Do NOT use Claude Code's native plan/execute flow.
Do NOT create or update files under ~/.claude/plans/.
Do NOT ask to proceed with implementation.
Save only the two feature spec files and chat sections described above.
Do not propose an implementation plan yet.
Wait for my approval and any corrections before moving to Gate 3.

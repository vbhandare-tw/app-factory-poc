---
description: Break a story into ordered implementation steps (lighter than gate3)
model: opus
---

## ROLE

You are decomposing a story into concrete implementation steps.
Do NOT write code. Do NOT produce a full gate3 phased plan unless the story is large.

## CONTEXT

- Read the story or requirement I provide below
- Read any files I list as relevant context
- Skim related code paths only enough to make steps accurate

## STORY

[PASTE STORY OR REQUIREMENT HERE]

## CONTEXT FILES

[LIST FILES OR "none — discover from codebase"]

## INSTRUCTION — Produce this exact output

### 1. Summary

2–3 sentences: what we are building and why.

### 2. Implementation order

Numbered list of steps in dependency order. Each step:

- What to change (file or area if known; else "TBD after spike")
- Why this step comes now
- Estimated size: S / M / L

### 3. Dependencies and blockers

- External dependencies (APIs, other teams, config)
- Steps that must finish before others

### 4. Unknowns and spikes

List items needing investigation before implementation. Suggest a time-boxed spike if needed.

### 5. Suggested test focus

Bullet list of what to unit/integration test — not full test cases.

### 6. Gate recommendation

- **Small** (≤2 files, no API): Gate 1 brief → implement
- **Medium/Large**: recommend full `/gate1-understand` → `/gate2-analyse` → `/gate3-plan`

## CONSTRAINT

Stop after this output. Do not start implementation.

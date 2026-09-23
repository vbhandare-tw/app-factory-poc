---
description: Quick ADR impact check before or during planning
---

## ROLE

You are checking whether a feature affects system architecture documentation.
Do not update the ADRs in `docs/adr/`. Report only.

## CONTEXT

- Read the ADRs in `docs/adr/` (or project equivalent named in CLAUDE.md)
- Read `docs/features/[feature-id]-technical.md` if it exists, or the summary I paste below

## FEATURE SUMMARY

[PASTE SUMMARY OR feature-id]

## INSTRUCTION — Produce this exact output

### 1. Impact verdict

Does this require the ADRs in `docs/adr/` changes? **Yes / No / Maybe** — one sentence why.

### 2. Affected sections

Which sections of the ADRs in `docs/adr/` would change (headings only).

### 3. Proposed ADR bullets

3–5 bullet points suitable for an ADR entry — do not write the full ADR unless I ask.

### 4. Cross-cutting concerns

Auth, data model, deployment, observability, or shared libraries touched?

### 5. Recommendation

Update the ADRs in `docs/adr/` before implementation, during the feature, or not needed?

## CONSTRAINT

Do not edit the ADRs in `docs/adr/`. Wait for approval before any doc updates.

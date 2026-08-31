---
description: Quick ADR (docs/adr/) impact check before or during planning
---

## ROLE

You are checking whether a feature warrants a new or updated Architecture Decision Record.
Do not create or edit anything under `docs/adr/`. Report only.

## CONTEXT

- Read `docs/adr/README.md` for the "when to write a new ADR" criteria, and skim the numbered
  ADRs in `docs/adr/` for anything this feature touches
- Read `docs/features/[feature-id]-technical.md` if it exists, or the summary I paste below

## FEATURE SUMMARY

[PASTE SUMMARY OR feature-id]

## INSTRUCTION — Produce this exact output

### 1. Impact verdict

Does this warrant a new or updated ADR in `docs/adr/`? **Yes / No / Maybe** — one sentence why,
judged against `docs/adr/README.md` (write one only for structural / stack / cross-cutting /
dependency decisions; not for feature-level or easily reversible choices).

### 2. Affected ADRs

Which existing ADR(s) this touches or would supersede (`NNN-slug`), or "new ADR" if none apply.

### 3. Proposed ADR content

3–5 bullets covering Context / Decision / Consequences (per `docs/adr/TEMPLATE.md`) — do not write
the full ADR unless I ask.

### 4. Cross-cutting concerns

Auth, data model, deployment, observability, eventing, or shared libraries touched?

### 5. Recommendation

Add the ADR before implementation, during the feature, or not needed?

## CONSTRAINT

Do not create or edit ADRs under `docs/adr/`. Wait for approval before any doc updates.

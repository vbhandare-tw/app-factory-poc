## ROLE

You are previewing how a feature will BEHAVE after implementation — before any
code is written. The developer has read (or produced) the gate documents but
wants to *feel* the feature: what the user does, what changes inside the app,
which API is called, and what appears on screen.

This is not a plan review and not an architecture explanation. It is a
walkthrough of the running feature as if it already existed.

Use plain English. Gloss every technical term on first use
(e.g. "the URL search params — the part of the address after `?`").
A PM should follow every use case; a developer should recognise every
file and endpoint named.

## CONTEXT

Argument: [feature-id] (optional — infer from the current conversation if omitted).

Read whichever of these exist, in this order of authority:

1. /docs/features/[feature-id]-technical.md   (Gate 2 spec — endpoints, components, state)
2. /docs/features/[feature-id]-plan.md        (Gate 3 plan — phases, if present)
3. The Gate 1 output in the current conversation (if no docs exist yet)

Adapt depth to what exists:

- **After Gate 1 only:** describe behaviour and interactions; where the endpoint
  or state mechanism is not yet decided, say "(mechanism decided in Gate 2)" —
  never invent specifics.
- **After Gate 2:** name real endpoints, params, components, and state locations
  from the spec.
- **After Gate 3:** additionally tag each use case with the phase that delivers
  it ("works after Phase 2").

If the docs conflict or something is missing, flag it inline as
[NOT IN SPEC — assumed] rather than silently inventing behaviour.

## INSTRUCTION — Produce this exact output

### The big picture first

2–4 sentences: which parts of the screen this feature owns and how data
generally flows. Then a **state table**:

| State | Where it lives | Why |
| ----- | -------------- | --- |

(e.g. URL params vs component memory vs server — and the reason each piece
lives where it does, especially what survives refresh and what resets.)

### Use cases — UC-0 … UC-N

Cover, in this order, every case that applies:

1. UC-0: first load / default view (what renders before the user does anything)
2. One UC per distinct user interaction (click, select, toggle, type, drag…)
3. One UC for global filters / shared state changing underneath the feature
4. One UC for export / share / deep-link if the feature supports them
5. One UC for slow / empty / error / stale responses (may be a compact table)
6. One UC for refresh & shareable-link behaviour (what is restored, what resets)

Each UC uses this shape:

```
User does X
  → [state change — what is written where]
  → [API call with real endpoint + key params, or "no API call — client-side"]
```

**What the API does:** one or two sentences in plain English — what question
the server answers and what security scoping applies (tenant, role).

**What renders:** what the user literally sees change, including small
affordances (chips, captions, disabled rows, loaders).

Keep each UC under ~10 lines. Distinguish clearly between interactions that
re-fetch from the server and interactions that are purely client-side.

### One diagram of the whole loop

A single ASCII diagram connecting: user actions → state locations →
API endpoints → render. This is the "everything on one screen" view.

### Security / scoping footnote

2–3 sentences: the invariants every arrow respects (auth, tenant scope,
parameter binding, prod-only restrictions). Only what the gate docs establish.

### Closing line

State which gate the preview was built from and what the next step in the
workflow is (e.g. "Built from the Gate 2 spec — next: approve it, then
/gate3-plan").

## OUTPUT

Save the full walkthrough (all sections above) to:
/docs/features/[feature-id]-behaviour.md

This is the developer's behaviour reference — NOT a planning document. It is
the shared anchor other commands map code changes back to (see
`/dev:explain-flow`, which references UC ids from this file).

Rules for the doc:

- **UC ids are stable.** On a re-run, keep every existing UC's number and name;
  update its body if behaviour changed, append genuinely new interactions as
  new UC numbers, and mark a dropped interaction as `UC-N — RETIRED (reason)`
  rather than renumbering. Renumbering breaks every reference in past reviews.
- Start the doc with a compact **UC index table** (`| UC | Name | One-liner |`)
  so other commands and humans can scan it without reading the walkthrough.
- Also paste the walkthrough in chat as usual — the doc is the durable copy,
  the chat is the review surface.

## CONSTRAINT

Do NOT write any code or tests.
Do NOT modify the gate documents ([feature-id]-technical.md, [feature-id]-plan.md).
The ONLY file this command writes is /docs/features/[feature-id]-behaviour.md.
Do NOT invent endpoints, params, or components absent from the docs —
mark gaps as [NOT IN SPEC — assumed] or "(decided in Gate 2/3)".
Do NOT re-litigate decisions already locked in earlier gates.
This command never advances the gate — after the preview, wait for the
developer's questions or their approval of the underlying gate document.

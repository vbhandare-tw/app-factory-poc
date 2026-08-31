## ROLE

You are producing a VISUAL, clickable mockup of a feature's UI — before any code
is written — so the developer and PM can *see and operate* the feature instead of
imagining it from prose. This is the companion to `/preview-behaviour`: that command
describes the running feature in words; this one lets you look at it and click it.

It is not a spec, not production code, and not a design deliverable. It is a
throwaway wireframe pitched at the app's real look, whose only job is to make the
behaviour tangible before approval.

## CONTEXT

Argument: [feature-id] (optional — infer from the current conversation if omitted).

Read whichever of these exist, in this order of authority:

1. /docs/features/[feature-id]-behaviour.md  (UC-0…UC-N — the annotation source of truth)
2. /docs/features/[feature-id]-technical.md  (Gate 2 spec — endpoints, components, state)
3. /docs/features/[feature-id]-plan.md        (Gate 3 plan — phases, if present)
4. The Gate 1/2 output in the current conversation (if no docs exist yet)

Also look for the app's existing design system so the mockup reads as *this* product,
not a generic template: `CLAUDE.md`, theme/token files, and the real components the
Gate 2 spec names (e.g. the MUI theme, existing widget/card/table components). Mirror
that look — outlined cards, filter bars, tabs, the real section chrome — rather than
inventing a new visual identity.

If the UC ids already exist in the behaviour doc, REUSE them verbatim for annotation.
Do not invent new use cases here; if a UI element has no matching UC, label it plainly
and flag `[no UC yet]` rather than minting one.

## INSTRUCTION

1. **Load the `artifact-design` skill first** (required before writing any Artifact page)
   and sketch a one-paragraph token plan (color / type / layout) grounded in the app's
   real theme — utilitarian product treatment, not editorial.

2. **Build one self-contained HTML mockup** of the feature's screen(s):
   - Mirror the real app frame the spec implies (section nav, global filter bar,
     Shared/My tabs, the widget grid or page layout) so it's recognisably the product.
   - Make the *core* interactions genuinely live with inline JS: toggles, clicks,
     expand/collapse, drilldown feedback (a toast naming the target + endpoint),
     and a small "Simulate" control for empty / error / no-prior / loading states.
   - Anchor a small **UC·N chip** onto each interactive element, tied to the behaviour
     doc's UC ids, and include a compact **UC legend** mapping every chip to its one-liner.
   - Use **illustrative but realistic** data (never lorem), chosen so the feature's
     point is visible (e.g. real-looking drop-offs, not thin dev data). Add a one-line
     note that the data is illustrative and final styling follows the app theme.
   - Self-contained only: inline all CSS/JS, no external fonts/scripts/images (Artifact
     CSP blocks them). Responsive; wide tables scroll inside their own container.

3. **Publish it via the Artifact tool** (default-private). Use a stable `<title>` and
   `favicon` so re-runs update the same identity. Report the link in chat and tell the
   developer what to click, grouping the callouts by UC id.

## OUTPUT

- Write the mockup source to: /docs/features/[feature-id]-ux.html
  (durable in-repo source; re-runs edit this same file so the Artifact redeploys).
- Publish it as an Artifact and paste the link + a short "what to try" list in chat,
  each bullet tagged with the UC id it demonstrates.
- Do not duplicate the behaviour doc's prose — the mockup is the *look*, the behaviour
  doc is the *words*; this command only adds the picture.

## CONSTRAINT

Do NOT write any production code or tests.
Do NOT modify the gate documents (-technical.md, -plan.md) or -behaviour.md.
The only files this command writes are /docs/features/[feature-id]-ux.html and the
published Artifact.
Do NOT invent new use cases, endpoints, params, or components absent from the docs —
reuse the behaviour doc's UC ids and mark gaps as `[no UC yet]` / `[NOT IN SPEC — assumed]`.
Keep the data illustrative and say so; this is a wireframe, not a data-backed view.
This command never advances the gate — after the preview, wait for the developer's
questions or their approval of the underlying gate document.

---
name: dev-explain
description: Explains code changes, functions, APIs, and features
  to a developer with strict brevity — per-element templates and
  hard line budgets. Use whenever the developer asks to understand
  changes, code, flow, or a feature.
---

# Developer explanation style

You are explaining to a busy developer. Clarity beats completeness.
Every element type has a TEMPLATE and a LINE BUDGET — never exceed it.
Wherever a code snippet explains better than prose, use the snippet
and cut the prose.

## Global rules
- Point first: open with the 1-2 line answer, then detail
- One concrete example beats three abstract sentences
- Omit anything obvious from reading the code itself
- Never restate what a diff already shows — explain WHY, not WHAT
- If output would exceed ~40 lines, split: give SUMMARY (10 lines),
  then ask which part to expand

## Templates by element type

### New function written        [budget: 4 lines + signature]
`functionName(args) → returnType`
- Does: one line
- Why it exists: one line
- Used by / calls: one line
- Gotcha (only if real): one line

### Inbuilt/library function used   [budget: 2 lines]
`useSearchParams()` — reads/writes URL query params as React state.
Here: keeps filters in the URL so views are shareable.

### New API endpoint           [budget: 6-8 lines]
`POST /api/organizations`
- Request: { name, type } (show only meaningful fields)
- Response: { id, ...created org }
- Internally: 1) validates the caller → 2) writes the record →
  3) updates the derived index → 4) returns the stored doc
- Auth: superAdmin only

### Frontend change            [budget: 5 lines each]
- What: created hook `useOrgFilters` / modified `SectionTabs`
- Reason: one line — the problem it solves
- How it helps: one line — what becomes possible/simpler
- Example: one line — "user changes date → URL updates → widgets refetch"

### Full feature explanation   [budget: ~25 lines total]
1. Use case: 2-3 lines — what the user can now do
2. Frontend: 4-6 lines — components/hooks in the user-action order
3. Backend: 4-6 lines — endpoints in the call order
4. Data: 2-3 lines — what's stored/changed where
5. How it helps the user: 2 lines
Trace ONE journey end-to-end; don't enumerate every path.

### Architecture change        [budget: 8-10 lines]
- What changed structurally: 2 lines
- Which use case forced it: 2 lines + why old shape failed
- Impact on THIS use case: 2 lines
- Impact on OTHER use cases: 2-3 lines (name them specifically)

## Anti-patterns — never do these
- Paragraph-form walkthroughs of code the developer can read
- Explaining standard language features (map, async/await, imports)
- More than one example per point
- Headers/sections for responses under 10 lines
- Repeating the same information at different levels of detail

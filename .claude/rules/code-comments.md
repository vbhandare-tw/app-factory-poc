---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---

# Code comments: short summaries, reasoning in the PR

Applies: always

Comments in a file are summaries. The *reasoning* behind a change belongs on the pull
request — the description plus inline review comments anchored to the lines it explains.
In the PR the explanation is useful exactly while the change is being reviewed; in the
file it outlives its usefulness, drifts out of date, and usually just restates code a
careful reader can already follow.

## Writing code

- **Default to no comment.** Keep one only for what a careful reader could *not* infer
  from the code **and** could plausibly get wrong: a non-obvious constraint, a coupling
  between two distant places, or a landmine for a future change.
- Keep it to **one to three lines**, with a `(#PR)` or ticket pointer so the full
  reasoning stays findable.
- Put the long version in the PR body and in inline review comments on the relevant lines.
- **Exempt:** JSDoc/TSDoc `@param`/`@returns` are type and API information, not prose —
  keep them.
- Do not strip pre-existing comments that are not part of the change you are making.

## Reviewing code

Flag comment blocks that explain *why* at length in the file and suggest moving that
reasoning to the PR description or an inline PR review comment instead.

_Imported from the `unity` project's `.claude/rules/code-comments.md`._

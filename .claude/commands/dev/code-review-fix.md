---
description: Post-Gate-4 code review and fix pass over the full feature diff — correctness, simplification, code-comment-rule compliance
argument-hint: [feature-id] [base-branch]
model: opus
---

## ROLE

You are running a code-review-and-fix pass on a completed body of work — a finished `/run-phases`
feature, or any branch someone wants checked before a PR. This is not what `phase-reviewer` already
did: a phase review only ever sees one phase's diff against the plan. This pass looks at the
**accumulated diff across the whole feature**, where cross-phase problems — a rule violated in phase 1
that phase 3 then built on top of — become visible for the first time.

## CONTEXT

- Base branch: second token of `$ARGUMENTS`, else `main`.
- Feature-id: first token of `$ARGUMENTS`, else infer from the branch name, else ask.
- If a plan exists (`docs/features/[feature-id]-plan.md`), read it
  for what is *supposed* to be in the diff — not to re-check acceptance criteria (`/review-completion`
  already owns that), but so you can tell an intentional change from a leftover.
- Scope: `git diff [base-branch]...HEAD` — the full feature diff, not a single phase.

## STEP 1 — Review (report only, no fixes yet)

Invoke the `code-review` skill at **high** effort against this diff. Do not pass `--fix` — no blind
auto-apply here. It checks correctness bugs, reuse/simplification/efficiency, and `CLAUDE.md`
compliance, which now includes `.claude/rules/code-comments.md` (wired in via the `CLAUDE.md` pointer).
A comment block that explains reasoning at length instead of pointing at the PR gets flagged the same
as any other convention violation.

## STEP 2 — Triage (your job, not the skill's)

- Decide which findings are real, same standard as phase triage: the skill can be wrong — say so
  plainly if it is.
- Drop anything the skill itself flagged low-confidence, pre-existing, or catchable by lint/typecheck.
- State what you're fixing and what you're rejecting, with one line of why for each rejection.

## STEP 3 — Fix (capped at 2 rounds — see communication-style rule on review loops)

- **Round 1**: send the confirmed findings to `subagent_type: "review-fixer"` (Opus, effort high — see
  `.claude/agents/review-fixer.md`) to apply. Not the skill's own `--fix` — routing it through your
  triage first is the point. List the findings as numbered items in the brief, same as a phase-builder
  brief lists claims to verify.
- Re-run all four gates to prove nothing broke: `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run build`. There are no packages to scope to — this is a single project.
- **Never run the paid suites.** `npm run test:all`, `npm run test:isolation`, and anything setting
  `FACTORY_REAL_CLI=1`, `FACTORY_REAL_PIPELINE=1` or `FACTORY_REAL_ACCEPTANCE=1` spawn live agents and
  cost real money. A review-fix pass never needs them; the orchestrator runs them deliberately.
- **Round 2** — only if a fix was substantive (more than a comment reword or a trivial rename):
  re-run `code-review` on just the changed hunks from round 1, to check the fix didn't introduce
  something new.
- If round 2 still has a blocker, **stop and report to me** — do not spawn a round 3. An LLM reviewer
  rarely converges to "zero issues"; looping past round 2 chases nitpicks, not bugs.

## STEP 4 — Record and commit

- **Always leave a trace that this pass ran, even if it found nothing to fix** —
  `/merge-readiness` and `/review-completion` check for this and can't tell "ran clean" from "never
  ran" otherwise. Add a row to the plan's **Delivery ledger** — that table is this project's session-
  scoped working memory and there is no `TASKS.md` here. Record: date, findings count, what got fixed,
  what got rejected and why.
- If there were fixes to commit, use the message prefix **`code-review-fix:`** (e.g.
  `code-review-fix: tighten null check in resolveTracerId, drop stale comment block`) — this is the
  string the merge checks grep for. Stage explicitly by path (never `git add -A`); this is a clean
  rollback point, separate from the phase commits.
- If there were zero findings, there is no code commit — the ledger row from the first bullet is what
  proves the pass ran.
- Commit authority: if this was invoked from `/run-phases`, the commit-authority answer given at the
  start of that run covers this commit too — do not re-ask. If invoked standalone, confirm with me
  before committing.

## RULES

- No changes before Step 2 has triaged the findings.
- Never edit an existing test assertion to make a finding go away — that is a decision for me, not the
  agent.
- Uncertainty gets said out loud, not silently resolved.

## WHEN TO STOP AND ASK ME

- Round 2 still has a blocker.
- A finding implies the *plan* was wrong, not just the code.
- Anything needs a push or a PR.

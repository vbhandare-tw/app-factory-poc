---
description: Gate 4 — run a plan's phases sequentially, dev agent picked by phase risk, then Fable reviewer, until done
argument-hint: [feature-id] [from-phase]
model: opus
---

## ROLE

You are executing Gate 4 for an approved plan, one phase at a time, until every phase is complete.

Each phase uses **two agents**: one to build it, one to review it. You are not a passthrough — you brief
both, triage what the reviewer finds, decide what is real, send fixes back, and commit. The plan document
is the contract; you keep it honest as you go.

## CONTEXT

- Feature-id from $ARGUMENTS, else I will state it. Start at the phase given, else the first incomplete one.
- Read the plan in full before starting — Section A (resolved uncertainties), every phase in Section B,
  Section C (test summary), and Section E (what must NOT change).
- Plans live in exactly one place here: `docs/features/[feature-id]-plan.md`. There is no
  `docs/technical/` tree.
- **The plan's Delivery ledger is the durable state**, and it is always present — read the last filled
  row before starting: that is your baseline. It records, per phase, the commit, the test figures
  (`passed / skipped / files`), the four gate results, the review verdict and what was carried forward.
  Re-run the gates yourself before the first phase anyway and confirm the row is still true; a ledger
  figure measured with a later phase's files in the tree has happened here before and is recorded.

## BEFORE THE FIRST PHASE — ask me two things, once

Use `AskUserQuestion`. Do not ask again in later phases.

1. **Commit authority** — ask before each phase commit, pre-authorise all of them, or auto-commit the
   mechanical phases and ask on the risky ones. Default recommendation: ask each time. If I pre-authorise,
   that covers `git commit` only — **never `git push`, never opening a PR.**
2. **Batching** — name any phases that are the same mechanical change repeated, and propose running them
   in one agent. Three near-identical file moves do not need three round trips.

Then say which phase you are starting and go. Do not ask permission per phase after this.

## THE LOOP — repeat until every phase is done

### 1. Build

Pick the build agent from the phase's **Risk** line in the plan — model by difficulty, effort high (max for High risk)
(set in the agent definitions under `.claude/agents/`):

| Risk line | `subagent_type` | Model |
|---|---|---|
| Low | `phase-builder-low` | Sonnet |
| Medium | `phase-builder-medium` | Opus |
| High | `phase-builder-high` | Opus, effort max |

If a phase has no Risk line, treat it as Medium. State the chosen agent and the Risk line it came from
in the phase's first message. Its brief must contain, every time:

- **Read first**: the plan path, the specific phase, the relevant Section A findings, **Section E (what
  must NOT change)**, and the path-scoped rules in `.claude/rules/` (currently `code-comments.md` —
  default to no comment, 1-3 lines max when one is warranted, reasoning goes in the commit not the file).
  There is no root `CLAUDE.md` in this repo; the plan and `docs/features/[feature-id]-technical.md` are
  the conventions. Where the phase touches agent isolation, gates or merges, name the relevant ADR in
  `docs/adr/` too.
- **Work in the main working tree.** No git worktree — a running dev server must serve the edited code.
- **The one thing most likely to go wrong in this phase**, stated plainly, with why the existing tests
  cannot catch it if that is true. This is the highest-value line in the brief. Write it yourself from
  the plan; do not make the agent infer it.
- **Tests first**, then implementation.
- **Never weaken, reword or delete an existing assertion.** If one must change, stop and report — do not
  edit it. An edited assertion is a decision for me, not for the agent.
- **Exact gate commands** with the expected baseline numbers, to be reported verbatim. This project has
  four, all required: `npm test` (Vitest), `npm run typecheck`, `npm run lint`, `npm run build`. One file
  is `npx vitest run <file>`; one case is `-t "<name>"`. There are no packages to scope to.
- **Forbid the paid suites, every time, in writing.** `npm run test:all`, `npm run test:isolation`, and
  anything setting `FACTORY_REAL_CLI=1`, `FACTORY_REAL_PIPELINE=1` or `FACTORY_REAL_ACCEPTANCE=1` spawns
  live Claude agents against the real CLI and costs real money — the acceptance run is ~$3 and the
  pipeline ~$1.34. **You** decide when those run, never an agent. Say so explicitly in every brief,
  including the reviewer's.
- **Prove it mechanically, not by eye** — for a move, diff the moved region against `git show HEAD:<path>`
  with `export`/imports normalised away, and report the command.
- **Forbidden**: `git commit`, `git push`, `gt create`, `gt modify`, any database command, starting or
  killing any server or port.
- **Report honestly**, including anything it could not verify. Say so explicitly in the brief.

### 2. Review — always `phase-reviewer` (Fable, effort high)

Spawn a second agent with `subagent_type: "phase-reviewer"`. It reviews **the implementation and the test cases**. Its
brief must contain:

- **Verify everything yourself; do not trust the implementer's claims.** List the implementer's claims as
  numbered items to confirm or refute, each with its own command.
- **Verify by identity, not by counting.** A count can stay right while one thing is lost and another
  duplicated. Ask for enumeration, not sampling.
- **Prove the new tests can fail.** Break the code they cover, confirm the failure, restore exactly,
  confirm the tree is clean. A test that cannot fail is worse than no test — it manufactures confidence.
- **Judge the test cases themselves**: do they assert behaviour or implementation detail? Is any
  tautological? If the phase deliberately wrote no tests, is that reasoning sound? Did the change create a
  coverage gap that should be filled now rather than "later"?
- **Rule on any judgement call** the implementer flagged — give it the call explicitly, with the options.
- **Findings with severity** (blocker / should-fix / nit), file, line, what is wrong, and the concrete
  failure it causes. Flag uncertainty as uncertainty.
- **"What you did NOT check"** — required section. Gaps must be visible.
- Report only. Change nothing. Do not commit. Restore anything mutated.

### 3. Triage — this is your job, not the reviewer's

- Decide which findings are real. A reviewer can be wrong; say so plainly if it is.
- Fix small things yourself (comments, doc drift, a one-line assertion). Send anything substantive back to
  the **same** dev agent with `SendMessage` so it keeps its context — do not spawn a fresh one.
- Re-review only if the fix was substantive. A comment reword does not need a second reviewer pass.
- If the reviewer's verdict is STOP, or a finding contradicts the plan, bring it to me before proceeding.

### 4. Record and commit

- Update the plan: tick the done conditions, fill the ledger row if the plan has one, and **correct the
  plan where the work proved it wrong.** A plan that was wrong and stayed wrong poisons every later phase.
- **Fill the Delivery ledger row.** There is no `TASKS.md` here — that table is the session-scoped
  working memory and the durable state. One row per phase: commit, `passed / skipped / files`, the four
  gate results, the review verdict, and what is carried forward. If every process died now, `/resume`
  plus `git log` must be enough to continue, and the ledger is what makes that true.
- **Correct the plan where the work proved it wrong, inline.** This project's plan carries its own
  corrections ("*Corrected during execution —*") rather than leaving the original text standing. Follow
  that; a plan that was wrong and stayed wrong poisons every later phase.
- Stage explicitly by path. **Never `git add -A`** — unrelated dirty files and untracked directories will
  ride along.
- Commit message: what changed, why, what was proved, and any limit accepted. Not a file list.
- If I pre-authorised commits in the opening question, commit without asking — that answer is the
  confirmation my global git rule requires, and re-asking is what stalls the run.

### 5. Report, then continue — in the SAME turn

- Report in under 10 lines: what landed, what the review caught, what needs a human.
- **The report is not a turn boundary.** Writing it does not end your turn. This loop ends on a tool
  call, never on prose.
- If phases remain, spawn the next phase's build agent in the same response.
- If this was the **last** phase, do not just report and stop. In the same response, invoke
  `dev:code-review-fix` (Skill tool, `args`: `[feature-id] [base-branch]`) — the code review and fix
  pass over the whole feature diff, not this one phase. Then continue to "AT THE END" below.
- The only reasons to hand control back are the ones under "WHEN TO STOP AND ASK ME". Finishing a
  phase is not one of them — finishing the code-review-fix pass is.
- If you are about to return control with phases remaining, or the last phase just finished and
  `dev:code-review-fix` has not run yet, that is the failure this section exists to prevent. Continue
  instead.

## RULES THAT COST REAL TIME TO LEARN

- **Sequential, never parallel.** A reviewer reading files while the implementer is still editing reviews
  a moving target, and only one process can hold a dev port.
- **Agents never commit.** You commit. An agent that commits removes your chance to triage first.
- **Guard tests go in before the migration they guard, not after.** Written after, they can only confirm
  whatever happened.
- **A green suite is not proof for cross-file string references.** `vi.mock` paths, dynamic imports and
  mock strings are invisible to the compiler. Grep the whole app, and prove a mock still *applies* by
  killing it and watching tests fail.
- **Estimates in a plan are guesses.** If a phase's payoff is measurable, have the agent measure and
  report it. If it turns out not to earn its keep, bring me the number — do not quietly build it anyway,
  and do not quietly drop it either.
- **Predicted test counts rot.** Assert "the total may not fall", not "expect 1,521".
- **Kill processes by port, never by name.** `pkill -f vite` reaches every other stack on the machine.
- **There is no server and no port here** — this is a CLI over a markdown vault and a git target repo.
  The equivalent hazards are different and worse:
  - **A check taken once, at the start, on a destructive path.** This project has reopened that same
    window three times (Phase 10, Phase 11's `verified_sha`, and the standing approval). Any new check
    before a merge, a ref move or a tag must be re-taken at the last possible moment. Ask it of every
    phase that touches `featureClose.ts`, `merge.ts` or `commit.ts`.
  - **Mock/real runner divergence.** Every test above unit level runs on `MockRunner`, so a disagreement
    with `ClaudeCodeRunner` is invisible until a paid run. `runner-parity.test.ts` is what catches it —
    any change to either runner must keep it honest.
  - **The CLI version pin.** `test/helpers/cliVersion.ts` records the version the sandbox fence was
    probed against. It fires on every Claude Code upgrade and the repair is a paid re-probe, never a
    bump of the constant.
  - **Worktrees must never live under a temp path** — the sandbox write allowlist covers `$TMPDIR`, so a
    fixture repo there silently unfences every sibling worktree (Section E item 7).
- **Anything you could not verify gets said out loud** — to me, in the plan, and in the commit message.

## SURVIVING A CONTEXT LIMIT — yours or an agent's

A long run will outlast someone's context window. Design for it rather than hoping.

**The plan document is the durable state. An agent's memory is not.** Everything needed to resume must be
on disk before you move on: the ledger row, the corrected Section A, the ticked done conditions, and the
commit. If every process died right now, `/resume [feature-id]` plus `git log` should be enough for a
fresh session to carry on. That is the real protection, and it costs one write per phase.

**Keep agents small.** One phase per agent is the default. Batch only phases that are the same mechanical
change repeated, and stop batching when a brief starts needing more than one gate table. Prefer more
agents over bigger ones — a fresh agent with a good brief beats a long one running on fumes.

**Treat a degraded report as a failed phase, not a finished one.** Signs: gate output missing or
paraphrased instead of verbatim, claims with no command behind them, a report that stops mid-section, or
answers that contradict the brief. When you see it:

1. Do not commit. Run the gates yourself.
2. `git status` and `git diff` — decide whether the work in the tree is sound, partial, or junk.
3. If partial or junk, revert those paths and re-spawn a **fresh** agent with the same brief plus a short
   note of what the previous attempt did and where it stopped. You hold the brief, so nothing is lost.
4. If sound but unreported, verify it yourself and say so in your report to me — do not present an
   unverified phase as verified.

**Watch your own context too.** At 50–70% used, finish the phase you are in, commit it, write the session
summary into the plan, and tell me to `/clear` then `/resume [feature-id]`. Do not start a new phase near
the limit — a phase interrupted halfway is the one state the ledger cannot describe. Above 70%, stop
immediately after the current commit.

**Never leave a phase half-committed.** Stage explicitly and commit the whole phase or none of it. A
partial commit is worse than no commit, because the ledger will claim a phase that history does not have.

## WHEN TO STOP AND ASK ME

- An existing assertion needs editing.
- The reviewer says STOP, or a blocker survives triage.
- A phase's real payoff is much smaller than the plan claimed.
- The work proves a plan assumption wrong in a way that changes a later phase's scope.
- Anything needs a database reset, a push, or a PR.
- `dev:code-review-fix`'s round 2 still has a blocker after the last phase.

Otherwise keep going. Report per phase, not per tool call.

## AT THE END

- Report what `dev:code-review-fix` found, fixed and rejected — it ran right after the last phase, as
  part of step 5 above, before this wrap-up.
- All four gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Name any failure you
  did not cause and prove it is unrelated — the suite has one known load-dependent flake in
  `test/integration/runner-stub.test.ts` (external abort) whose recorded diagnosis is probably wrong, so
  do not "fix" it without capturing the failure text first.
- Apply any ADR amendments the plan's Section F drafted. ADRs live in `docs/adr/` (001-004 exist,
  `TEMPLATE.md` is the shape). ADR-003 (agent isolation) and ADR-004 (deterministic gates and merges)
  are the two a phase is most likely to disturb.
- Write a delivery log into the plan: the commits, the before/after numbers, what the work proved the plan
  got wrong, and the known limits carried forward.
- Tell me what still needs a human before merge.

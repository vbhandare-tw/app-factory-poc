# App Factory — M1–M3 acceptance run (Phase 12)

- **Feature ID:** `factory-m1-m3`
- **Date:** 2026-09-22
- **Harness:** `test/integration/acceptance.test.ts`, behind `FACTORY_REAL_ACCEPTANCE=1`
- **Target:** `fixtures/toy-app`, provisioned into a throwaway worktree per ticket
- **Model:** `config.models.default: sonnet`
- **CLI:** Claude Code 2.1.276

---

## Result

**PASS on the second run.** One real feature went `intake → done` on the toy repo with
exactly three human approvals and no manual file edits, merged into the base branch and
tagged `factory/calculator/2026-09-22`.

Two runs were paid for. The first failed and is recorded here in full, because what it
found is the more useful half of this phase.

| | Run 1 | Run 2 |
|---|---|---|
| Outcome | **FAIL** — feature stuck in `in_development` | **PASS** — feature `done`, tagged |
| Cost | $3.1763 | $3.1225 |
| Wall clock | 1127 s (19 min) | 1237 s (21 min) |
| Agent runs | 12, all ok | 16, 15 ok + 1 retried |
| Tickets | 3 — two done, one parked | 4 — all done on first attempt |
| Escalations | 1 | 0 |

**Total Phase 12 spend: $6.30.** The plan estimated $5–15 for one feature; a single
successful run is ~$3.12, and the estimate held because reality needed two.

---

## Run 1 — the failure, and what it was worth

Twelve agent runs, every one returning valid structured output. Tickets T001 and T002
reached `done` on their first attempt: real agents wrote the expression evaluator and the
number formatter, passed code review and QA, and the orchestrator merged both into the
feature branch behind green gates. T003 — the CLI — parked in `needs_human`.

**It was not a code defect.** The QA agent's escalation, quoted from the ticket note:

> 9 of the 12 acceptance criteria are written as a bare `node src/cli.ts "<expr>"`
> invocation. In this worktree's ambient Node, that invocation fails at Node's own ESM
> loader (`ERR_UNKNOWN_FILE_EXTENSION`) before any CLI code runs, so those criteria fail
> exactly as literally written — verified reproducibly for all 9 cases. This is not a code
> defect: with the flags this repo's own `package.json` test/build scripts use, all 9
> behaviors are correct, and the 48/48 `node:test` suite passes. […] bouncing this to the
> developer for a code fix would not change the outcome.

That is the system working. The gates were green, the agent's own suite passed, and QA
still refused to call it done — Section E item 4 ("the agent's self-report is never
trusted") cutting the right way, and a role correctly declining to blame the role
downstream of it.

### Root cause: an incomplete context document, not a bad agent

`fixtures/toy-app/CLAUDE.md` said *"Node runs `.ts` through type stripping"* and listed the
three gate commands. It never said that type stripping requires
`--experimental-strip-types`, nor that a bare `node file.ts` fails outright. Every gate
command in `package.json` carries the flag, so the gates always worked and the gap was
invisible. The PM, reading that document, wrote criteria in the form any sensible person
would — and they could not pass.

Verified independently by the orchestrator: on Node v22.13.0, `node t.ts` on a file
containing `const x: number = 1` fails at the type annotation. The QA agent reported the
ambient Node as v23.3.0, so the sandboxed worktree and the operator's shell resolved
different Node versions; the failure reproduces on both, but **that discrepancy is itself
unexplained and is carried forward as a debt.**

### The two fixes, deliberately different in kind

- **Repo-specific** — `fixtures/toy-app/CLAUDE.md` now states the flag, shows the full
  invocation, names the `ERR_UNKNOWN_FILE_EXTENSION` failure, and says plainly that a
  criterion invoking a `.ts` file without the flag can never pass however correct the code.
- **Generalisable** — `prompts/pm.md` gains "Take the invocation from the repo, never from
  habit", with the rule that a criterion must use a form the project context establishes,
  or an existing `npm` script, rather than an invented command line. The evidence is
  written into the prompt so the next editor knows why the rule is there.

The prompt's own example table was teaching the trap: its model of a good criterion was
`node dist/cli.js "2 + 3 * 4"`. That row was rewritten.

**No Node flag was hard-coded into the factory's prompts.** The factory targets any repo;
the rule has to be "read the target's conventions", not "TypeScript needs this flag".

---

## Run 2 — the passing run

| Role | Runs | OK | Cost | Wall | Turns | `StructuredOutput` calls |
|---|---|---|---|---|---|---|
| `pm` | 1 | 1 | $0.1234 | 105 s | 2 | 1 |
| `tl_plan` | 1 | 1 | $0.2673 | 185 s | 10 | 1 |
| `dl` | 2 | 1 | $0.7648 | 377 s | 22 | 6 |
| `developer` | 4 | 4 | $0.7629 | 182 s | 46 | 5 |
| `code_reviewer` | 4 | 4 | $0.5170 | 142 s | 29 | 4 |
| `qa` | 4 | 4 | $0.6871 | 247 s | 49 | 13 |
| **Total** | **16** | **15** | **$3.1225** | **1237 s** | | |

Four tickets, three of them independent roots:

```
T001  Add expression evaluator to src/evaluate.ts          depends_on: []
T002  Add number display formatter to src/format.ts        depends_on: []
T004  Document new calculator modules in CLAUDE.md         depends_on: []
T003  Add CLI entry point, wire npm run calc, document it  depends_on: [T001, T002]
```

The plan asked for at least two parallelisable tickets; the DL produced three.

### The Phase 7b failure mode, observed live and handled

The **first `dl` run exhausted its delivery retries** — five `StructuredOutput` calls,
`terminalReason: structured_output_retry_exhausted`. This is the parameter-boundary fault
Phase 7b measured across fourteen sequences: the model emits a correct payload and the CLI
mangles it at a field boundary. The orchestrator charged one attempt, retried on the next
cycle, and the second `dl` run succeeded. No feature was lost, no bad payload written.
That is the 15-of-16 in the table, and it is the designed behaviour rather than a defect.

### The `delivery_retried` warning earned its keep on its first real run

The call count and its warning landed earlier the same day (commit `05f2046`), closing a
debt that had slipped Phases 9, 10 and 11. It fired **six times** in this run, including on
the `dl` exhaustion above and on three `qa` runs at 3 and 4 calls against a cap of 5.

Before this existed, a run at 4 of 5 was indistinguishable from a clean one — it produced a
valid payload, green gates and a `done` ticket. The only way to know it had nearly lost its
work was to read the transcript by hand. Run 1 had already shown the same thing: a `qa` run
at 4 calls on a ticket that otherwise looked perfect.

### The `depends_on` prompt fix, validated as the plan asked

Phase 7b recorded two evidenced improvements and deliberately did **not** apply them,
because editing a prompt would have invalidated six runs of evidence. It asked that they be
applied and validated "at Phase 12's real-agent acceptance run, where a run is being paid
for anyway".

The first was applied before run 1: one line in `prompts/dl.md` requiring `depends_on` on
every ticket, `[]` when it has none. Phase 7b measured that omission causing roughly half of
all first-call rejections. **Both runs carried it on every ticket**, including `[]` on all
three independent ones, and neither run saw that rejection shape.

The second — whether pretty-printed JSON correlates with mangling — **was not investigated**
and is carried forward.

---

## Requirements §16 — where each item is proved

`test/integration/acceptance.test.ts` holds a ledger test asserting each cited file still
contains each cited case, so these references cannot rot silently.

| §16 item | Proved by | Why there |
|---|---|---|
| Feature → `done`, parallelisable tickets, three approvals, no manual edits | this run, **and** the always-on mock case in `acceptance.test.ts` | The only item where "can a real agent do the work" is the question |
| A ticket failing tests 3× → `needs_human` with logs linked | `test/integration/dev-loop.test.ts` | Real git, real subprocess gates. An agent told to fail three times is a mock that costs money |
| A deliberately red base branch blocks merge | `test/integration/feature-close.test.ts` | Breaking the base is a `git commit`; no agent is involved in the refusal |
| Kill/restart mid-run loses no state | `test/integration/orchestrator-recovery.test.ts` | SIGKILLs a real child at two awkward points. A kill inside a paid run destroys that run's own evidence |
| The vault renders cleanly in Obsidian | `acceptance.test.ts`, always-on, and re-run against this run's vault | A property of the bytes — but agent prose is what breaks it |

---

## What this run does **not** prove

- **That the tickets were good.** A pass means the DAG resolved and the gates were green.
  Phase 7b is explicit that "could a Developer agent, holding only this ticket, actually
  build it" is partly a human read. The transcripts are preserved for that read; **it has
  not been done.**
- **The six prompts have still never been read end to end by a human.** The one Phase 6
  condition no agent can close, now five sessions old. This run exercised them and two
  needed fixing — which is evidence for doing the read, not against.
- **Anything about a real repository.** The toy app has zero dependencies, a 0.3 s `npm ci`
  and three fast gates. A real target's gate runs are minutes, and cost scales with retries.
- **Determinism.** Two runs produced different ticket counts (3 and 4) from the same
  requirement. Both were defensible breakdowns; neither is repeatable evidence.

## Evidence

Preserved outside the scratch root, and not cleaned up:

```
.factory-test-repos/acceptance-logs/real/2026-09-22T07-29-15-842Z/   run 1 (failed)
.factory-test-repos/acceptance-logs/real/2026-09-22T07-54-09-066Z/   run 2 (passed)
```

Each holds the full vault (feature note, tech plan, every ticket), every agent transcript,
every gate log, `orchestrator.jsonl`, a per-cycle `journal.json`, and the printed
`summary.txt`. The harness builds and prints that report from a `finally` on every exit
path, so a failing run keeps its evidence — which is why run 1 is documented above rather
than lost.

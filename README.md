# App Factory

An orchestrator that drives Claude Code agents through a markdown vault and a git target repo.
You write a requirement, approve three times, and a feature arrives on your base branch with a tag.

The vault is the source of truth and **the orchestrator is its only writer**. Agents never touch it;
they return structured output and the orchestrator writes the notes. Everything an agent does happens
in a throwaway git worktree, under an OS sandbox, never in your checkout.

---

## Install

```sh
npm install
npm run build          # produces dist/, which `factory` runs from
npm link               # optional — puts `factory` on your PATH
```

Node 22.13 or newer. The agent roles need the `claude` CLI installed and authenticated; set
`runner: "mock"` in the vault config if you only want to exercise the orchestrator.

---

## 1. Create a vault

```sh
factory init --repo /path/to/your-repo --vault ~/vaults/your-repo --name your-repo
```

That creates the vault, binds it to the target repo, and registers the project so later commands can
find it by name instead of by path.

**Then fill in `project.md`.** It is one of only two documents most roles receive, and the shipped
file is a template. A vault whose "Stack and conventions" section still reads
_"Language, framework, test runner…"_ will cost you a round trip: the first real run of this factory
spent one of the PM's five questions asking what language the project was in. Say what the stack is,
what the gates are, and what is out of scope.

Check `config.yml` while you are there. The keys that matter most on day one:

| Key | Default | Why you might change it |
| --- | --- | --- |
| `base_branch` | `main` | The branch a finished feature merges into. |
| `gates.tests` / `.lint` / `.build` | `npm test`, `npm run lint`, `npm run build` | The commands that decide whether a ticket is good. Exit code is the only signal. |
| `setup_command` | `npm ci` | Run in each fresh worktree before an agent starts. A sandboxed agent has no network, so it cannot install anything itself. |
| `max_attempts` | `3` | Red gates per ticket before it parks for a human. |
| `human_checkpoints` | all `true` | The three approval points below. |

**Your target repo must gitignore whatever `setup_command` installs** (normally `node_modules/`).
Worktree cleanup decides whether a worktree holds real work with `git status --porcelain`, so a repo
that commits its install output makes every worktree look dirty and none of them are ever reclaimed.

---

## 2. Add a feature

Write the requirement in a markdown file, in your own words, and hand it over:

```sh
factory feature add ./requirements/expression-calculator.md --vault ~/vaults/your-repo
```

The filename becomes the slug (`expression-calculator` → `FEAT-EXPRESSION-CALCULATOR`); pass
`--slug` to override. The file's contents are copied **verbatim** into `## Raw Requirement` and
nothing ever edits that section — it is the only record of what you actually asked for.

---

## 3. Run the loop

```sh
factory start --vault ~/vaults/your-repo        # foreground, polls until you stop it
factory start --vault ~/vaults/your-repo --once # exactly one cycle, then exit
```

One cycle advances every item that can move. In order, a feature goes:

```
intake → refining      PM        rewrites the requirement as testable statements
        ↓  ── approval 1 ──
       planning        Tech Lead writes tech-plan.md
       ticketing       Delivery Lead cuts the tickets
        ↓  ── approval 2 ──
    in_development     per ticket: Developer → gates → Code Reviewer → QA → merge
                       into feature/<slug>
awaiting_feature_close gates run again on the feature branch, and on the base
        ↓  ── approval 3 ──
        done           merged into your base branch with --no-ff, and tagged
```

The gates are plain child processes and their exit codes are the only thing that advances a ticket —
no agent's claim about its own tests counts for anything. A red gate bounces the ticket back to the
Developer with the failing output; three bounces park it.

`factory stop` asks a running instance to finish the run in flight and exit. `factory kill` stops it
claiming anything new while letting what is already running finish.

---

## 4. The three approvals

Everything waiting on you is listed in `NEEDS_HUMAN.md` at the vault root, and in:

```sh
factory status --vault ~/vaults/your-repo
```

| Checkpoint | What you are judging |
| --- | --- |
| `after_pm_refinement` | The PM's scope and acceptance criteria are what you meant. |
| `after_ticket_breakdown` | The tickets are the right split, and each one is buildable on its own. |
| `final_acceptance` | Every ticket is done, the feature branch is green, and the base branch is green. Approving merges and tags. |

```sh
factory approve FEAT-EXPRESSION-CALCULATOR "scope is right"         --vault ~/vaults/your-repo
factory reject  FEAT-EXPRESSION-CALCULATOR "split the parser and the CLI apart" --vault ~/vaults/your-repo
```

Every command takes `--vault <path>`, or a registered project name, or it resolves the vault from
your current directory. The examples here are explicit; day to day, `cd` into the vault and drop the
flag.

An item can also park **outside** a checkpoint — that is an escalation, not an approval. Its
`pause_detail` says what happened and links the gate log and the agent transcript that explain it.
Fix the cause, then `factory approve` to send it back round.

Approving the final acceptance is the only command that writes your base branch. If the base branch
has moved and gone red in the meantime, the approval is held rather than refused: the loop re-gates
the moved base and closes on your standing approval, without asking you again.

---

## 5. Do not edit notes in Obsidian while the factory is running

The vault is designed to be opened in Obsidian, and reading it while a run is in flight is fine.
**Editing it is not.** There is no lost-update guard, by design: the orchestrator reads a note,
decides, and writes it back, so an edit you make in between is silently overwritten — or worse,
overwrites a transition and leaves the item in a state the loop will not touch again.

Edit a note when the item is `needs_human`, or when the factory is stopped. That is the whole rule.
Anything you want to tell an agent belongs in the `note` argument to `factory approve` or
`factory reject`, which the next agent reads.

---

## Where things are

```
<vault>/
  config.yml          settings
  project.md          what the project is — every role reads this
  index.md            regenerated after every transition; do not edit
  NEEDS_HUMAN.md      everything waiting on you; do not edit
  work/features/<slug>/
    feature.md        the feature note, including ## History
    tech-plan.md      the Tech Lead's plan
    tickets/*.md      one note per ticket
  logs/
    orchestrator.jsonl   one line per decision
    <slug>/*.log         agent transcripts and gate output
```

In the target repo, `feature/<slug>` collects the ticket merges, and the delivery is tagged
`factory/<slug>/<date>` on the base branch. Worktrees live in `.factory-worktrees/`, a sibling of
the repo, and are cleaned up as tickets finish.

---

## Development

```sh
npm run typecheck
npm run lint
npm test            # free: no agent ever runs, nothing is spent
```

Three suites cost real money and are each behind their own switch, off by default:

```sh
npm run test:isolation                            # FACTORY_REAL_CLI=1, sandbox probes, ~$0.01
FACTORY_REAL_PIPELINE=1 npx vitest run test/integration/pipeline-real.test.ts   # ~$1.34
FACTORY_REAL_ACCEPTANCE=1 npx vitest run test/integration/acceptance.test.ts    # several dollars
```

The last one is the full `intake → done` acceptance run on real agents. It keeps the whole vault,
every transcript and a printed summary under `.factory-test-repos/acceptance-logs/`, whether it
passes or fails.

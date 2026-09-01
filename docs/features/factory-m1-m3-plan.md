# App Factory — Phased Implementation Plan (M1–M3)

- **Feature ID:** `factory-m1-m3`
- **Spec:** `docs/features/factory-m1-m3-technical.md`
- **Gate:** 3 (Plan) — awaiting approval
- **Phases:** 13 (revised after `/devils-advocate`)
- **Revision:** post-devils-advocate. Four decisions applied: agents never commit (A6); toy repo is sufficient; concurrent Obsidian editing is forbidden rather than guarded; Sonnet by default, configurable per role.

---

## Section A — Resolved uncertainties

### A1. `structured_output` under `--output-format stream-json` — RESOLVED, works

Spec §8.1 marked this unverified. It works, with one undocumented requirement.

- `--output-format stream-json` **fails outright without `--verbose`**: `Error: When using --print, --output-format=stream-json requires --verbose`. This is not in `--help`.
- With `--verbose`, a run emits a JSONL stream (18 events for a trivial 2-turn run: `system` ×9, `assistant` ×5, `user` ×2, `rate_limit_event` ×1, `result` ×1).
- The terminal `result` event carries `structured_output`, `total_cost_usd`, and `is_error` — everything the `json` format gives.

**Effect on the plan:** `ClaudeCodeRunner` uses `stream-json --verbose` from the start. Live transcript writing and the structured contract both work, so nothing is deferred to M7 and Phase 5 has no fallback branch. The parser reads events line by line, writes each to the transcript, and keeps the final `result` event.

### A2. Sandbox read-set for `npm` under `denyRead: ["~/"]` — RESOLVED, no extra config needed

Spec §4.3 predicted `denyRead: ["~/"]` would break npm, which lives under `~/.nvm` on this machine and reads `~/.npmrc`.

It does not. `npm test` ran cleanly with `denyRead: ["~/"]` and `allowRead` limited to the project directory. The sandbox does not block executable loading or npm's own runtime reads.

**Effect on the plan:** `sandbox_extra_read` / `sandbox_extra_write` stay in the config schema as an escape hatch, but ship **empty by default**. The startup gate probe (Phase 4) still runs, because it now serves a different purpose: catching a target repo whose gates genuinely need outside access, rather than fixing an npm problem we assumed existed.

### A3. NEW — sandboxed agents have no network, and worktrees have no `node_modules`

Two findings that surfaced while resolving A2, neither anticipated in Gate 2. Together they would have broken Phase 9 on first run.

- **Network is blocked by default** when `sandbox.enabled` is set: `curl https://registry.npmjs.org/` returned exit 56, HTTP 000. Good for safety, but it means an agent can never run `npm install`.
- **A fresh `git worktree` contains no `node_modules`** — it is untracked, so a new worktree is a clean checkout with no dependencies. The Developer agent's very first `npm test` would fail for a reason that has nothing to do with its code.

**Effect on the plan:** Phase 8 gains a **worktree provisioning step**. Immediately after `git worktree add`, the orchestrator runs `npm ci` in the worktree itself — unsandboxed, orchestrator-controlled, network allowed — so the agent starts against a ready tree. Provisioning is a configurable `setup_command` in `config.yml`, since not every target repo is npm. Gates (§8.2) already run as orchestrator child processes outside the sandbox, so they are unaffected.

### A4. `Edit(//**)` deny-all glob — NOT NEEDED, question closed

Gate 2 flagged this as unverified. The throwaway-worktree design (spec §4.3) removed the need for it: read-only roles get a real worktree that is force-removed afterwards, so nothing they write survives. No deny-all glob is used anywhere in the plan.

### A6. The `.git` escape hole — FOUND by `/devils-advocate`, RESOLVED, changes ADR-003

The most serious finding in the whole planning effort, and it was missed by the Gate 2 verification because none of those nine probes used git.

A linked worktree's real git directory lives at `<repo>/.git/worktrees/<id>` — **outside** the worktree. The sandbox permits writes there, because otherwise `git commit` in a worktree could not work. Probed from inside a sandboxed ticket worktree: main checkout `EPERM`, sibling worktree `EPERM`, home `EPERM`, but `<repo>/.git/**` **writable**.

`.git` is shared across every worktree, so a Developer agent could rewrite `refs/heads/main`, edit `.git/config`, or plant `.git/hooks/pre-commit` that later runs **unsandboxed** under the orchestrator. That is a full sandbox escape and it breaks requirements §10 and ADR-004.

**Resolution — mitigation (c), approved: agents never commit.** The Developer edits files, runs tests, leaves the tree dirty, and returns a proposed `commit_message`; the orchestrator stages and commits after the agent exits. Every repo-touching profile also gets `denyWrite` on `.git/{hooks,config,refs,objects}`.

Probed with that fence: all four writes `EPERM`; `git status --short` and `git diff` **still work**, so the agent keeps the read-only git it actually needs; `git add` fails with exit 128.

I said in the devil's-advocate pass that this option costs agent-authored commit messages. It does not — the message travels in the structured output, which already had a `commit_message` field. There is no downside to this option.

**Effect on the plan:** Phase 5 gains the `denyWrite` fence and an automated `verify-isolation` test. Phase 9's Developer contract changes from "commit to ticket branch" to "leave dirty tree"; the orchestrator commits. ADR-003 is rewritten (Section F).

### A7. Model selection — resolved by decision

Sonnet for every role by default, overridable per role via `config.models`. Per-feature cost is dominated by run count (12+ runs, up to 3 attempts each), not by any single run's difficulty. `tl_plan` and `dl` are the likeliest candidates for promotion to Opus, since a bad plan poisons everything downstream — decide with real numbers from Phase 13.

### A8. Concurrent Obsidian editing — resolved by decision, no work

Editing notes while the orchestrator runs is **forbidden**, not guarded. Edit when an item is `needs_human` or the factory is stopped. This removes the mtime/hash lost-update guard that would otherwise have been added to Phase 3. Documented in the README and in Section E.

### A5. Missing repo conventions

`docs/adr/TEMPLATE.md` and `.claude/README.md` (referenced by the Gate 3 command's Sections F and G) **do not exist** — this repo contains only `.claude/commands/`. Phase 1 creates `docs/adr/TEMPLATE.md` and `docs/adr/README.md`; Section G below states the test commands inline rather than pointing at a file that isn't there.

---

## Section B — Implementation phases

---

**Phase 1 — Scaffold and toy target repo**

Goal: A TypeScript project that builds, lints, and tests, plus the tiny Node repo every later phase runs against.

Implementation changes:

- `package.json`: ESM (`"type": "module"`), Node 22 engine, scripts `build` (tsc), `test` (vitest run), `lint` (eslint), `typecheck`. Deps: `commander`, `yaml`, `gray-matter`, `zod@^4`. Dev deps: `typescript`, `vitest`, `eslint`, `@types/node`, **`typescript-eslint`, `@eslint/js`**. *(Corrected during execution: eslint cannot parse TypeScript without a parser, so the original dev-dep list would have produced a lint run that silently checked nothing in `src/`.)*
- `tsconfig.json`: `strict: true`, `NodeNext` module resolution, `outDir: dist`, `noUncheckedIndexedAccess: true` — the orchestrator indexes into record maps constantly and this catches a whole bug class.
- `src/index.ts`, `src/cli/main.ts`: commander root with `--version`, no subcommands yet.
- `fixtures/toy-app/`: the target repo — `package.json` with real `test`/`lint`/`build` scripts, `src/calc.ts` (a deliberately extensible module the sample feature will add to), `src/calc.test.ts`, `tsconfig.json`, `package-lock.json`, and a committed `CLAUDE.md` so Phase 6's context injection has something real to inject.

  **Corrected during execution — the fixture has zero npm dependencies.** The spec (§13) and this plan originally said vitest, eslint, and tsc. Shipped instead: `node --test`, a hand-written `scripts/lint.mjs`, and a `scripts/build.mjs` that loads every module under Node's type stripping. Reason: the fixture is invoked by tests in almost every later phase, and one that needed `npm install` would make the suite slow, network-dependent, and non-hermetic. The gates stay genuinely real — real subprocesses, real exit codes, and a red path proven by mutation (a wrong `add()` turns `npm test` red).

  **Accepted fidelity loss:** `build` catches syntax errors, broken module resolution, and non-erasable TS (`enum`, `namespace`), but **not plain type errors**. Phase 9 treats a red `build` as a hard gate, so a type-only regression in the fixture would pass it. Judged acceptable because Phase 9 needs the gate *mechanism* to be real, not the fixture's type coverage to be complete. Revisit at Phase 9 if it bites; the fix is one devDependency (`typescript`) and `tsc --noEmit`.
- `fixtures/toy-app/.git`: **not** committed as a nested repo. A test helper `test/helpers/toyRepo.ts` copies `fixtures/toy-app`, runs `git init` + initial commit, and returns the path.

  **Corrected during execution — not `os.tmpdir()`.** Repos go in a gitignored `.factory-test-repos/` at the project root, overridable via `FACTORY_TEST_ROOT`, with a runtime assertion that the path is under no temp root. The sandbox write allowlist covers `$TMPDIR` and `/tmp/claude*` (ADR-003), so a fixture repo in `/var/folders/...` would silently unfence every sibling worktree in Phases 8–11 and quietly void Section E item 7.
- `docs/adr/TEMPLATE.md`, `docs/adr/README.md`: the ADR convention referenced in Section F.
- `.gitignore`: `dist/`, `node_modules/`, `.factory-worktrees/`.

Unit tests to write:

- `test/unit/scaffold.test.ts`: proves the toolchain and the fixture helper actually work, so later phases never debug their harness.
  - [ ] `toyRepo()` produces a directory that is a git repo with exactly one commit
  - [ ] the toy repo's `npm test` exits 0 on a clean checkout
  - [ ] the toy repo's `npm run lint` exits 0 on a clean checkout
  - [ ] `toyRepo()` called twice returns two independent paths that do not share state

Integration tests to write:

- [ ] `npm run build` produces `dist/cli/main.js` and `node dist/cli/main.js --version` prints the version
- [ ] Regression: n/a — first phase, no existing behaviour

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run typecheck` and `npm run lint` are clean on an empty-ish codebase

Risk: Low — scaffolding only, no logic.
Touches shared/core files: Yes — `package.json`, `tsconfig.json`, `.gitignore`. Everything downstream depends on these, so get strictness right now; loosening later is easy, tightening is not.

---

**Phase 2 — Domain core (pure, no I/O)**

Goal: The state machine, DAG resolver, and ID generation exist as pure functions with exhaustive tests, before anything can touch a disk.

Implementation changes:

- `src/domain/roles.ts`: `ROLES` const tuple and `Role` type — `pm`, `tl_plan`, `dl`, `developer`, `code_reviewer`, `qa`. No `tl_merge`, no `qa_lead` (spec §3.1).
- `src/domain/states.ts`: `FEATURE_STATES`, `TICKET_STATES`, `PauseReason` per spec §3.2–3.4, including the states declared but unreachable in M1–M3.
- `src/domain/types.ts`: `FeatureFrontmatter`, `TicketFrontmatter`, `Note<T>`, `HistoryLine`. Every timestamp field typed `string` (ISO), never `Date`.
- `src/domain/transitions.ts`: `TICKET_TRANSITIONS` and `FEATURE_TRANSITIONS` as declarative `TransitionRule[]`; `canTransition(note, to, actor, ctx): GuardResult`; `applyTransition(note, to, actor, note?): Note` — pure, returns a new note with `## History` appended and `updated_at` bumped. No persistence.
- `src/domain/guards.ts`: `allDependenciesDone`, `gatesAllGreen`, `allTicketsDone`, `attemptsRemaining`. Each takes explicit context, no globals.
- `src/domain/dag.ts`: `resolveActionable(tickets)`, `detectCycles(tickets)`, `descendantCount(tickets, id)` (unused until M4's ranking rule 4, but it is pure and cheap to test now).
- `src/domain/ids.ts`: `featureId(slug)`, `ticketId(featureId, ordinal)`, `runId(itemId, role, attempt, counter)` — all deterministic, no clock, no randomness.
- `src/domain/schedule.ts`: `compareWorkItems(a, b)` implementing **stage priority + lexicographic tiebreaker only**. **Corrected during execution — that is rules 1 and 5, so the deferred set is rules 2, 3, 4 plus the starvation guard, not "rules 2–5".** Requirements §8.1 rule 5 *is* the lexicographic tiebreaker, which M1–M3 ships; the original wording deferred a rule that was already being built. Verified against the requirements document. Each deferred rule gets a `describe.skip` block that throws if un-skipped without an implementation, so the placeholders cannot rot into silent passes.

Unit tests to write:

- `test/unit/domain/transitions.test.ts`: the state machine is the system's rulebook; an illegal transition that slips through corrupts the vault silently.
  - [ ] every rule in `TICKET_TRANSITIONS` is reachable from `backlog` (no orphan rules)
  - [ ] `backlog → ready` is refused when any dependency is not `done`, allowed when all are
  - [ ] `gates → code_review` is refused when any of tests/lint/build is `fail`, and when a gate result is missing entirely
  - [ ] no transition can move a ticket from `done` to any other state
  - [ ] `applyTransition` appends exactly one `## History` line, in `timestamp | from → to | actor | note` format
  - [ ] `applyTransition` bumps `updated_at` and leaves every other frontmatter field byte-identical
  - [ ] `applyTransition` never mutates its input note (frozen-input test)
  - [ ] feature `in_development → awaiting_feature_close` refused while any ticket is not `done`
  - [ ] a table-driven sweep asserting every (from, to) pair not in the rule table is refused
- `test/unit/domain/dag.test.ts`: dependency errors are the failure mode that deadlocks the whole pipeline.
  - [ ] linear chain resolves one actionable ticket at a time
  - [ ] diamond (A → B, A → C, B+C → D) makes B and C actionable together
  - [ ] multi-parent ticket becomes actionable only when the last parent is `done`
  - [ ] a two-node cycle is detected and named in the error
  - [ ] a self-referencing `depends_on` is detected
  - [ ] a `depends_on` pointing at a nonexistent ticket ID is reported, not silently ignored
  - [ ] `descendantCount` on a diamond returns the transitive count, not the direct-child count
- `test/unit/domain/ids.test.ts`: IDs appear in filenames, branch names, and lock keys.
  - [ ] `featureId('user-auth')` → `FEAT-USER-AUTH`
  - [ ] slug with spaces, punctuation, and repeated separators collapses to a single `-`
  - [ ] `ticketId` zero-pads to 3 digits and rolls past 999 without collision
  - [ ] `runId` is stable — identical inputs produce identical output across calls
- `test/unit/domain/schedule.test.ts`: guards M4 against silent regressions.
  - [ ] stage priority orders `merge > qa > code_review > in_progress > ready > ticketing > planning > refining`
  - [ ] equal stages fall back to lexicographic ticket ID
  - [ ] sorting an array twice yields identical order (determinism)
  - [ ] `describe.skip` placeholders named for M4 rules 2–5

Integration tests to write:

- [ ] None — this phase is pure by construction. A test that needs I/O here means something leaked into the domain layer, and that is itself the signal.
- [ ] Regression: Phase 1 suite still green

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] No integration tests required (pure layer)
- [ ] `src/domain/**` imports nothing from `node:fs`, `node:child_process`, or any `src/` module outside `domain/` — enforced by an eslint `no-restricted-imports` rule added in this phase, not by convention

Risk: Low — pure functions, but high-consequence if the transition table is wrong, which is why the test list is the longest in the plan.
Touches shared/core files: Yes — `src/domain/**` is imported by every later phase. Changing the transition table after Phase 7 means re-testing the loop.

---

**Phase 3 — Vault I/O**

Goal: Notes can be read and written without corruption, churn, or type drift.

Implementation changes:

- `src/vault/atomic.ts`: `atomicWrite(path, contents)` — temp file in the same directory, `fsync` file, `rename`, `fsync` directory. `sweepOrphanTemps(dir, maxAgeMs)` for startup cleanup.
- `src/vault/note.ts`: `parseNote<T>(raw)` using `gray-matter` to split fences then `yaml.parse` with core schema; `serializeNote<T>(note)` using a fixed `FRONTMATTER_ORDER` and per-value `yaml.stringify`, preserving unrecognised keys verbatim at the end. All timestamps emitted as quoted ISO strings (spec §7.2).
- `src/vault/paths.ts`: every vault path derived in one place — `featureDir(slug)`, `ticketPath(slug, id)`, `logPath(...)`, `runsDir()`, `killFile()`, `instanceLock()`. No path string is ever concatenated elsewhere.
- `src/vault/storage.ts`: the `Storage` interface from spec §7.1 and `MarkdownStorage` implementing it. `appendSection(path, heading, md)` appends under an existing `##` heading or creates it in canonical order.
- `src/vault/index-md.ts`: `regenerateIndex(storage)` producing `index.md` — features, statuses, ticket counts by state.

Unit tests to write:

- `test/unit/vault/note.test.ts`: a serializer that reformats on every write turns the git history into noise and can silently retype a value.
  - [ ] `parse(serialize(parse(x)))` deep-equals `parse(x)` across a fixture corpus (feature note, ticket note, note with unknown keys, note with empty body)
  - [ ] a no-op read-then-write produces a byte-identical file
  - [ ] an ISO timestamp survives round-trip as a quoted string, never a YAML date object
  - [ ] `depends_on: []` stays an empty list, not `null`
  - [ ] a human-added unknown frontmatter key survives a write
  - [ ] frontmatter key order matches `FRONTMATTER_ORDER` regardless of input order
  - [ ] a body containing a literal `---` line does not break the fence split
  - [ ] a note with no frontmatter, and one with malformed YAML, both throw a typed `NoteParseError` naming the file
- `test/unit/vault/atomic.test.ts`: the corruption guarantee the whole no-database design rests on.
  - [ ] writing creates no leftover `.tmp` file on success
  - [ ] a simulated failure between temp-write and rename leaves the original file byte-intact
  - [ ] concurrent writes to the same path both complete and the file is one of the two whole versions, never a splice
  - [ ] `sweepOrphanTemps` removes temps older than the cutoff and keeps newer ones
- `test/unit/vault/paths.test.ts`
  - [ ] every path helper stays inside the vault root, including when given a slug containing `../`
- `test/unit/vault/index-md.test.ts`
  - [ ] index lists features with correct per-state ticket counts
  - [ ] regenerating twice from unchanged state produces identical bytes

Integration tests to write:

- [ ] Write 50 notes to a temp vault, read them all back, assert full fidelity
- [ ] Kill the process mid-write (child process killed between temp-write and rename via an injected hook), restart, assert the vault parses clean and the original note is intact
- [ ] Regression: Phase 1–2 suites still green

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] A hand-written vault fixture opens in Obsidian and renders without YAML errors — manual check, once

Risk: Medium — the round-trip and atomicity guarantees are subtle and everything above depends on them being right.
Touches shared/core files: Yes — `src/vault/**`. Used by Phases 4, 7, 9, 10, 11.

---

**Phase 4 — Config, project resolution, and `factory init` (completes M1)**

Goal: A vault can be created, found from anywhere, and validated before anything runs.

Implementation changes:

- `src/config/schema.ts`: zod schema for `config.yml` per spec §11, with defaults. `max_parallel_devs` pinned to 1 with a `.refine()` that rejects higher values and explains that parallelism is M4. Unknown keys rejected by name. Adds `setup_command` (default `npm ci`) from resolution A3, and `sandbox_extra_read`/`sandbox_extra_write` defaulting to `[]` per A2.
- `src/config/load.ts`: `loadConfig(vaultPath)` — parse, validate, return typed config or a `ConfigError` listing every bad key at once rather than failing on the first.
- `src/config/registry.ts`: read/write `~/.app-factory/projects.yml` *(path corrected during execution — `~/.factory/` belongs to another installed CLI)*, `registerProject`, `listProjects`, `defaultProject`.
- `src/config/resolve.ts`: `resolveVault(input, fsView)` implementing spec §6.1's five-step order against an injected filesystem view so every branch is testable without touching the real home directory.
- `src/config/validate.ts`: `validateStartup(config)` per spec §11.1 — vault exists, version compatible, `target_repo` is a git repo, `base_branch` exists, gate commands resolve, `refs/factory/owner` absent or matching. Returns a list of failures, never throws on the first.
- `vault-template/`: `index.md`, `project.md`, `config.yml`, `tech/.gitkeep`, `work/features/.gitkeep`, `logs/.gitkeep`.
- `src/cli/init.ts`, `src/cli/projects.ts`, `src/cli/status.ts`: the three M1 commands. `status` gains `--json` for test assertions.

Unit tests to write:

- `test/unit/config/resolve.test.ts`: getting this wrong means operating on the wrong vault — the worst possible silent failure.
  - [ ] explicit `--vault` wins over everything
  - [ ] project name resolves via registry
  - [ ] cwd inside a vault is auto-detected
  - [ ] cwd containing `.factory-vault/` is auto-detected
  - [ ] registry `default` is used when nothing else matches
  - [ ] no match produces an error listing registered project names
  - [ ] `--vault` pointing at a directory with no `config.yml` errors rather than falling through to the default
  - [ ] precedence holds when several sources could match at once
- `test/unit/config/schema.test.ts`
  - [ ] every default is applied when the key is absent
  - [ ] an unknown key is rejected and named
  - [ ] `max_parallel_devs: 3` is rejected with the M4 explanation
  - [ ] a malformed `gates` block reports which gate is wrong
  - [ ] multiple errors are reported together, not one at a time
- `test/unit/config/validate.test.ts`
  - [ ] missing `target_repo` fails with the path in the message
  - [ ] `target_repo` that exists but is not a git repo fails distinctly
  - [ ] missing `base_branch` fails and lists the branches that do exist
  - [ ] a `refs/factory/owner` marker belonging to another vault is rejected

Integration tests to write:

- [ ] `factory init --vault X --repo Y --name Z` creates a vault that `loadConfig` validates, writes `target_repo`, registers `Z`, and writes the owner ref into the repo
- [ ] `factory status Z` run from an unrelated directory resolves via the registry and reports zero features
- [x] `factory start` against a vault whose `target_repo` was deleted fails with a clear error — **split during execution.** The validation half is covered here (`validateStartup` on a deleted `target_repo` returns a clear failure). The **"and spawns no agent process"** half, asserted by injecting a Runner that throws if called, **moves to Phase 7a**: `factory start` does not exist until 7a and there is no Runner until Phase 5, so there was nothing to inject.
- [ ] Two `factory init` runs against the same repo from different vaults: the second is rejected on the owner ref
- [ ] Regression: Phase 1–3 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] M1 acceptance items from requirements §16 hold: init produces a valid bound vault; start from any directory resolves; invalid repo fails fast

Risk: Low–Medium — mostly mechanical, but the resolution order has five branches and a wrong one is dangerous.
Touches shared/core files: Yes — `src/config/**` is read by every command.

---

**Phase 5 — Runner and run logging**

Goal: An agent can be invoked, its transcript streamed to disk, and its structured output validated — with a mock implementation good enough to build the whole pipeline against.

Implementation changes:

- `src/runner/types.ts`: `Runner`, `AgentRunSpec`, `AgentRunResult` exactly as spec §8.1.
- `src/runner/claudeCode.ts`: `ClaudeCodeRunner`. Builds argv per spec §4.4 **plus `--verbose`** (resolution A1). Spawns with `cwd: spec.cwd`, `stdio: ['ignore', 'pipe', 'pipe']` (spec §4.4 — stdin must not be inherited). Parses the JSONL stream line by line: every line appended to the transcript immediately, the `result` event retained. Maps `is_error`, timeout, non-zero exit, and schema-validation failure onto the `failure` field. Timeout via `AbortSignal` → `SIGTERM` → `SIGKILL` after 10s.
- `src/runner/settings.ts`: `buildSandboxSettings(profile, cwd, config)` producing the `--settings` JSON — `sandbox.enabled: true`, `filesystem.denyRead: ['~/']`, `allowRead: [cwd, ...extra]`, `allowWrite: [...extra]`, and **`denyWrite: ['<repo>/.git/hooks', '<repo>/.git/config', '<repo>/.git/refs', '<repo>/.git/objects']`** for every repo-touching profile (resolution A6). A pure function, so the exact JSON is unit-testable without spawning anything.
- `src/runner/models.ts`: `resolveModel(role, config)` — `config.models[role] ?? config.models.default`, defaulting to `sonnet` (resolution A7).
- `src/runner/mock.ts`: `MockRunner` returning canned `structured` payloads from a fixture map keyed by `role` + item ID, with per-key options for `failure`, delay, and cost. Every test above unit level uses this.
- `src/log/events.ts`: `EventLog` — line-buffered JSONL writer to `logs/orchestrator.jsonl`, one typed event per decision.
- `src/log/transcript.ts`: `TranscriptWriter` — `createWriteStream` per run at `logs/<slug>/<ticket>-<attempt>-<role>.log`, flushed per line.
- `src/log/runs.ts`: `.runs/<run-id>.json` written at spawn, deleted on completion, swept at startup.

Unit tests to write:

- `test/unit/runner/settings.test.ts`: a malformed sandbox JSON silently produces an unfenced agent — the highest-severity quiet failure in the system.
  - [ ] developer profile yields `sandbox.enabled: true` with `allowRead` containing its worktree
  - [ ] `denyRead: ['~/']` is present on every profile
  - [ ] sandbox filesystem paths use plain `/abs` and `~/` form, **not** the `//abs` form used by `permissions` rules (spec §4.2 — the two syntaxes are easy to confuse and a wrong one fails open)
  - [ ] `sandbox_extra_read` entries from config are merged in
  - [ ] every repo-touching profile carries the four `.git` `denyWrite` paths (resolution A6)
  - [ ] the produced object round-trips through `JSON.stringify`/`parse` unchanged
- `test/unit/runner/models.test.ts`
  - [ ] a role with no entry falls back to `models.default`
  - [ ] a per-role override wins
  - [ ] the default config resolves every role to `sonnet`
- `test/unit/runner/argv.test.ts`
  - [ ] argv always contains `--safe-mode`, `--verbose`, `--output-format stream-json`, `--json-schema`
  - [ ] argv never contains `--bare` (breaks subscription auth, spec §4.2) and never `--dangerously-skip-permissions`
  - [ ] `--max-budget-usd` reflects the profile
  - [ ] tools list matches the profile exactly
- `test/unit/runner/streamParse.test.ts`: fed recorded JSONL fixtures, no spawning.
  - [ ] a well-formed stream yields `ok: true` and the structured payload
  - [ ] a stream whose `result` has `is_error: true` yields `ok: false, failure: 'api_error'`
  - [ ] a stream truncated mid-way (process killed) yields `failure: 'crash'`, not a parse exception
  - [ ] a `result` whose `structured_output` violates the zod schema yields `failure: 'schema'` and preserves the raw payload for the log
  - [ ] a non-JSON line in the stream is logged and skipped, not fatal
  - [ ] `total_cost_usd` is extracted
- `test/unit/log/transcript.test.ts`
  - [ ] lines are readable from disk **while** the run is still open (the M7 tailing guarantee — assert by reading the file before closing the stream)
  - [ ] `.runs/<id>.json` exists during the run and is gone after

Integration tests to write:

- [ ] `MockRunner` end-to-end: spec in, canned structured output out, transcript file written, `.runs` entry created and removed
- [ ] `ClaudeCodeRunner` against a **stub `claude` executable** on `PATH` (a shell script emitting recorded JSONL) — proves argv construction, streaming, and parsing without spending money or requiring network
- [ ] Timeout path: stub that sleeps past the timeout is killed, `failure: 'timeout'`, no orphan process left (assert via `process.kill(pid, 0)`)
- [ ] **`verify-isolation` (`test/integration/isolation.test.ts`) — the blast-radius probe as a real test.** Provisions a repo plus two worktrees, runs one real cheap-model agent in worktree A, and asserts every one of these is blocked: write to the main checkout, write to worktree B, write to `~`, write to `.git/hooks`, `.git/config`, `.git/refs`, `.git/objects`, and `git add`. Also asserts `git status` and `git diff` still succeed. This is the only test in the suite that must call the real CLI — a stub cannot prove a kernel-level fence. Tagged so it can be excluded from the fast local loop but is mandatory in CI and before any release.
- [ ] Regression: Phase 1–4 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] **One** manual real-CLI run (cheap model, trivial prompt) confirms the stub fixtures match reality — the stub is only as good as its last calibration. *Recording committed at `test/fixtures/runner/real-run-2026-09-01.jsonl`. Drift against resolution A1: 17 events observed, not 18 — `system` ×8 rather than ×9, because the number of `system/thinking_tokens` events varies per run. Same event-type set, and no field the runner reads is missing from the terminal `result` event.*
- [x] `verify-isolation` passes against the installed CLI version, and that version is recorded in the test file so a future failure is immediately attributable to an upgrade. *`PROBED_CLI_VERSION = '2.1.220'`, asserted by an always-on test. The real-CLI case is opt-in (`FACTORY_REAL_CLI=1` or `CI`) via `npm run test:isolation` / `npm run test:all`, ~$0.023 per run. **Ticked on evidence the orchestrator reproduced independently**, not on the implementer's report: the review agent ran the probe itself, confirmed the binary executed is the real 2.1.220 rather than the test stub, confirmed the probe arena is outside every temp path, and re-probed with the `.git` `denyWrite` removed to establish which protections are actually ours.*

Risk: Medium — subprocess handling, streaming parse, and timeout/kill are the classic sources of flaky tests and orphan processes.
Touches shared/core files: Yes — `src/runner/**`, `src/log/**` used by Phases 7, 9, 10, 11.

---

**Phase 6 — Agent layer: profiles, schemas, context, prompts**

Goal: Each of the six roles is fully described as data — permissions, injected context, output schema, and system prompt.

Implementation changes:

- `src/agents/profiles.ts`: `AgentProfile` per role exactly as spec §4.3 — cwd kind, tools, allowedTools, sandbox, timeout, budget.
- `src/agents/schemas.ts`: one zod schema per role extending the shared `Base` (`outcome`, `escalate_reason`, `notes_markdown`), fields per spec §5. `toJSONSchema()` conversion happens here so the CLI contract and runtime validation cannot drift apart.
- `src/agents/context.ts`: `ContextRecipe` per role per spec §6.2; `buildContext(recipe, storage, item)` returning the prompt string plus a size report. Over `context_warn_chars`, drops the lowest-priority document and **records the truncation in the returned report** so it reaches the event log.
- `src/agents/registry.ts`: `AGENTS: Record<Role, AgentDefinition>` binding profile + schema + recipe + prompt file into one lookup.
- `prompts/pm.md`, `tl_plan.md`, `dl.md`, `developer.md`, `code_reviewer.md`, `qa.md`: the six system prompts. Each states its role, its output contract, the hard rules from requirements §7 (never edit `## Raw Requirement`; never guess on destructive actions; escalate rather than invent), and — because agents cannot write to the vault — that its structured output *is* its entire work product.

Unit tests to write:

- `test/unit/agents/schemas.test.ts`: the output contract is the interface between two systems; a loose schema lets malformed work through.
  - [ ] each role schema accepts a valid fixture payload
  - [ ] each rejects a payload missing a required field
  - [ ] each rejects unknown extra fields (`additionalProperties: false` survives JSON Schema conversion)
  - [ ] `code_reviewer.verdict` accepts only `approve`/`request_changes`
  - [ ] `qa.verdict` accepts only `pass`/`fail`
  - [ ] `outcome: 'escalate'` with a null `escalate_reason` is rejected
  - [ ] every generated JSON Schema is valid JSON and has `type: 'object'` at the root
- `test/unit/agents/context.test.ts`
  - [ ] developer recipe includes ticket, tech-plan, `project.md`, and the target repo's `CLAUDE.md` when present
  - [ ] the retry recipe additionally includes prior `## Review Notes` and `## QA Notes`
  - [ ] a missing optional document is skipped silently; a missing required one throws
  - [ ] oversize context drops the lowest-priority document and reports the truncation
  - [ ] no recipe ever injects another ticket's content (cross-ticket leakage check)
- `test/unit/agents/profiles.test.ts`
  - [ ] `pm` has no tools at all
  - [ ] only `developer` has `Edit`/`Write`
  - [ ] `tl_plan`, `dl`, `code_reviewer` use `repo_scratch_worktree`, never `ticket_worktree`
  - [ ] every profile has a timeout ≤ `agent_timeout` and a non-zero budget

Integration tests to write:

- [ ] For each role, build a real spec against a fixture vault and assert the full argv + settings JSON is well-formed and the schema round-trips
- [ ] Every file in `prompts/` has a matching entry in `AGENTS`, and vice versa — a missing prompt file must fail at startup, not mid-run
- [ ] **Section names come from `SECTION_ORDER`, never string literals** *(added after Phase 3 review)*: context recipes extract note sections by heading, and four of those heading names were inferred rather than specified. A literal `'## Review Notes'` typed into a recipe silently extracts nothing. Grep the phase's code for hardcoded `## ` strings and assert none exist outside the constant.
- [ ] Regression: Phase 1–5 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [ ] **STILL OWED — a human reads the six prompts end-to-end as a set.** They are the system's actual behaviour and no test can assess whether they are *good*. A review agent did a mechanical pass (every prompt states the hard rules, none asks for a field its schema lacks or omits one it requires, none reads as padding) and that pass found three things worth a human's attention: `tl_plan.md`'s `tech_doc_updates` is ambiguous enough that two competent agents would return different things; `code_reviewer.md` and `qa.md` omit the "never edit `## Raw Requirement`" rule; and `tl_plan.md:20-22` asserts that its `notes_markdown` becomes `tech-plan.md`, which is a Phase 7 orchestrator contract invented inside a prompt. **This is the one Phase 6 condition the orchestrator cannot close.**
- [x] **`--tools ""` probed against the real CLI** *(carried forward from Phase 5)* — **answered: the CLI accepts it.** A `pm` run given an empty `--tools` on v2.1.220 reports only `StructuredOutput` in `system/init`, calls no model-driven tool despite a prompt explicitly asking it to run Bash, and still returns valid structured output. `StructuredOutput` surviving the empty list is load-bearing — it is how the payload comes back, so a no-tools role keeps its output contract. If a future CLI version strips that too, the `pm` role loses its contract entirely, and the test says so. Original wording follows:: the `pm` profile is the first role with no tools at all, and the empty tools list is so far only asserted in unit tests and against the stub. A stub cannot tell us whether the real CLI accepts an empty `--tools`, ignores it, or errors. One cheap real run settles it, and Phase 6 is the first phase that can.
- [x] **Output-size spike done:** one real DL run producing four tickets, payload size measured against the model's output ceiling and recorded. If it is anywhere near the limit, the DL contract changes to one-ticket-per-run before Phase 7 depends on it. *Ticked, then **partly invalidated by Phase 7b** — the ceiling this measured against was the model's, not the one that actually binds. See the superseding note in the measurement section. Original wording: ticked with a deviation the orchestrator accepted, the run produced **three** tickets, not four, because that is how the DL judged the work to split. The condition exists to answer one question — is the payload near the ceiling — and the answer is 4.9%. A fourth ticket moves it to roughly 6.5%. Neither is near, so spending another ~$0.44 to satisfy the literal wording would have bought a number, not an answer. **Decision: the DL contract stays multi-ticket-per-run.** See the measurement section below.*
- [x] **Cost baseline recorded:** one real PM + TL + DL sequence at the configured model, `total_cost_usd` summed and written into this plan. *Measured: **$1.34** for one PM + TL + DL at `claude-sonnet-5`, ~8 minutes wall clock — **60× the $0.022 haiku probe** the warn-only budget decision currently rests on. `tl_plan` is the expensive role at $0.62. Extrapolated across a full feature at 12+ runs with up to 3 attempts each, an M3 feature plausibly costs **$5–15**. **Gate 1's warn-only `run_budget` decision should now be re-examined against this number** — that is a human decision, not one this plan can make.*

Risk: Medium — mechanically simple, but prompt quality determines output quality and cannot be unit-tested. Budget real time for prompt review, not just code review.
Touches shared/core files: Yes — `src/agents/**`, `prompts/**`.

#### Phase 6 measurement results — real PM → TL → DL, 2026-09-01

*(Recorded here rather than only in a review comment, because a chat report does not survive a context clear. Both done-condition boxes above have since been ticked by the orchestrator, one of them with an accepted deviation. See "Deviation" below.)*

**What was run.** One real PM → TL → DL sequence against the toy repo, at the configured model, driven by hand the way Phase 7a's `dispatch.ts` will drive it: build the context from the vault with `buildContext`, run the agent with `ClaudeCodeRunner`, validate with `validateAgentOutput`, write the payload into the vault with `MarkdownStorage.appendSection`, then build the next agent's context from what was written. The requirement was a genuine four-ish-ticket ask on `fixtures/toy-app` — add `evaluate("2 + 3 * 4")` with precedence, parentheses, error types, and a CLI entry point. Each run was capped with `--max-budget-usd 1`, so the arithmetic worst case was $3.

**Model.** `config.models.default: sonnet` resolved to **`claude-sonnet-5`** on CLI v2.1.220 (read from each run's `system/init` event). Every run also shows `claude-haiku-4-5-20251001` in `modelUsage` — the CLI's own internal calls, not ours.

| Role | `total_cost_usd` | Turns | Wall | Prompt | Payload | Output tokens (run) | Output tokens (largest message) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pm` | 0.2837189 | 5 | 102 s | 1,369 ch | 5,573 ch | 11,719 | 2,384 |
| `tl_plan` | 0.6167201 | 13 | 252 s | 3,355 ch | 11,863 ch | 25,906 | 4,854 |
| `dl` | 0.4397178 | 11 | 132 s | 10,324 ch | 15,370 ch | 15,794 | 6,268 |
| **Total** | **1.3401568** | 29 | 486 s | | | | |

```json
[{"role":"pm","costUsd":0.2837189,"numTurns":5,"durationMs":101611,"payloadChars":5573,"outputTokensTotal":11719,"outputTokensLargestMessage":2384},
 {"role":"tl_plan","costUsd":0.6167201,"numTurns":13,"durationMs":251898,"payloadChars":11863,"outputTokensTotal":25906,"outputTokensLargestMessage":4854},
 {"role":"dl","costUsd":0.4397178,"numTurns":11,"durationMs":131855,"payloadChars":15370,"outputTokensTotal":15794,"outputTokensLargestMessage":6268}]
```

**Cost baseline.** **$1.34 for one PM + TL + DL sequence at Sonnet**, ~8 minutes wall clock. Two things about that number are worth carrying forward. It is **60× the $0.022 haiku probe** the warn-only budget decision currently rests on, so the M1–M3 planning stage alone costs about a dollar-fifty per feature before a single line of code is written. And the per-run costs are not flat: `tl_plan` is the most expensive role at $0.62 — more than twice the PM — because it explores the repo with `Read`/`Grep`/`Glob` across 13 turns. Extrapolating the whole feature at 12+ runs with up to 3 attempts each, a single M3 feature plausibly costs **$5–15**. `run_budget` is warn-only by decision (Gate 1); this is the number that decision should now be re-examined against.

**Output-size spike.** The DL returned a **15,370-character payload**; the assistant message that carried it was **6,268 output tokens**. Claude Sonnet 5's per-response output ceiling is **128,000 tokens** (source: the bundled model catalog — *not* verified live, see caveats). That is a ratio of **4.9%**, i.e. a **~20× margin**. Per ticket the payload runs ~5,100 characters / ~2,090 output tokens, so the ceiling is not reached until roughly **60 tickets in one payload** — an order of magnitude beyond anything the DL should ever emit.

> **SUPERSEDED BY PHASE 7B — this measurement measured the wrong limit.** The reasoning below is sound about the *model's* 128,000-token output ceiling, and that ceiling really is 20× away. But the binding constraint is not the model. It is the **CLI's `StructuredOutput` mechanism, which exhausts its internal retries well below the model's ceiling** — Phase 7b's second round observed rejections at **~13,200–14,400 characters**, and the unparseable-JSON shape at **7,158 bytes**, so the ~20,000 figure first recorded here is too generous — and Phase 7b's richer DL prompt moved payloads from the 15,370 characters measured here to 18,500–21,000, straight into it. The symptom is `failure: api_error`, `terminalReason: structured_output_retry_exhausted`. Clean runs make **one** `StructuredOutput` call; failing runs make **five** and give up. Two Phase 7b runs degraded to a single ticket titled `"test"` — a minimal payload that validates — and looked like catastrophic prompt failures when they were nothing of the kind. **The 4.9% figure below is real and irrelevant; the number that matters is ~20k characters, and we were at 90–105% of it.** Resolution taken: trim the duplicated boilerplate that ticket `technical_notes_md` repeats, keeping the multi-ticket contract. Revisit if a larger feature hits the ceiling again.

**Recommendation: the DL contract stays multi-ticket-per-run. Do not change it to one-ticket-per-run.** The trigger condition in the done-condition above is "if it is anywhere near the limit", and 4.9% is not near it by any reading. Splitting to one ticket per run would multiply DL invocations by the ticket count, and at $0.44 per DL run that is a direct and pointless cost increase — it would take the planning stage from $1.34 to roughly $2.65 for a four-ticket feature and buy nothing, because the constraint it defends against does not bind. Revisit only if a future feature's payload grows by more than an order of magnitude, which the per-ticket rate above makes easy to check.

**Deviation from the done-condition as written.** The condition asks for "one real DL run producing **four** tickets". This run produced **three** — the DL judged the work to split into parser → CLI wrapper → build-script launcher, and that is a defensible split, not a failure. A second run to force a fourth ticket was not made: at ~2,090 output tokens per ticket the fourth would take the payload to roughly 6.5% of ceiling, which does not change the recommendation, and the run would have cost another ~$0.44 to move a number from 4.9% to 6.5%. **The orchestrator should decide whether that satisfies the condition.** The three tickets, with their sizes and their `depends_on` chain:

| # | Title | Size | `depends_on` |
|---|---|---:|---|
| 1 | `Implement evaluate() expression parser in src/evaluate.ts` | 5,018 ch | — |
| 2 | `Implement CLI wrapper in src/cli.ts` | 3,720 ch | ticket 1's title |
| 3 | `Emit dist/cli.js launcher from scripts/build.mjs` | 3,771 ch | ticket 2's title |

Worth noting for Phase 7a: the DL used the title-based `depends_on` convention correctly and unprompted — each entry names a real, unique title from the same payload, so the new payload-level schema rule (titles unique, every dependency resolvable, no self-dependency) passed on the first real run rather than being a rule only the tests exercise.

**Caveats on these numbers.**

1. **The 128K ceiling was not verified live.** There is no `ANTHROPIC_API_KEY` and no `ant` CLI on this machine, so the Models API could not be queried. The figure comes from the bundled model catalog. If it is wrong it is wrong in the direction of a *larger* ceiling for newer models, which only widens the margin — but the ratio should be re-derived from a live `models.retrieve` before anyone relies on it for a tighter decision.
2. **We never pass `--max-tokens`,** so the effective per-response cap is whatever the CLI defaults to, which may be lower than the model's ceiling. What is empirically established is narrower and is the thing that matters: a 6,268-token structured payload came back **complete and schema-valid**, with no truncation.
3. **One sample, one requirement, one repo.** These are calibration numbers, not a distribution.
4. **The driver was scaffolding and has been deleted** — it duplicated the dispatch flow Phase 7a builds for real, and a second copy of that flow would drift from the real one. To re-measure after the Phase 7b prompt revisions, run it through the real `dispatch.ts`; the method is described at the top of this section.

---

**Phase 7a — Orchestrator loop mechanics (MockRunner only)**

Goal: The loop, locking, claiming, and crash recovery are correct and fully tested, with no real agent involved.

*(Split from the original Phase 7 after `/devils-advocate`: lock bugs and prompt-quality problems need different mental modes, and interleaving them makes both harder to debug. 7a is deterministic and testable; 7b is exploratory.)*

Implementation changes:

- `src/orchestrator/lock.ts`: instance lock per spec §7.4 — `wx` create, heartbeat per cycle, stale when heartbeat exceeds `3 × poll_interval` or PID is dead. `factory stop` signals the recorded PID.
- `src/orchestrator/claim.ts`: item claim via `locked_by`/`locked_at`, atomic write then read-back confirmation, `lock_ttl` expiry.
- `src/orchestrator/scan.ts`: read all feature and ticket notes; a malformed note is quarantined with a `note_malformed` event and excluded from the actionable set, never fatal.
- `src/orchestrator/loop.ts`: the cycle from spec §9, steps 1–10, minus worktrees and gates (Phases 8–9).
- `src/orchestrator/dispatch.ts`: map state → agent role → build spec → run → validate → apply transition → persist → regenerate index → release claim.
- `src/orchestrator/actions.ts`: `approve(id, note)`, `reject(id, reason)`, `kill()` — the single write path the CLI and (later) the dashboard both call.
- `src/orchestrator/checkpoints.ts`: pause helper writing `status: needs_human` plus `pause_reason`, `pause_detail`, `resume_to`, `reject_to`, `paused_at` (spec §3.4–3.5).
- `src/cli/start.ts`, `stop.ts`, `featureAdd.ts`, `approve.ts`, `reject.ts`, `kill.ts`.
- `NEEDS_HUMAN.md` at vault root, regenerated whenever the needs-human set changes.

Unit tests to write:

- `test/unit/orchestrator/lock.test.ts`
  - [ ] a live lock with a fresh heartbeat is refused to a second instance
  - [ ] a lock whose PID is dead is reclaimed with a warning event
  - [ ] a lock whose heartbeat is older than `3 × poll_interval` is reclaimed
  - [ ] a lock file containing malformed JSON is treated as stale, not fatal
- `test/unit/orchestrator/claim.test.ts`
  - [ ] a claim writes `locked_by`/`locked_at` and reads back as won
  - [ ] a claim whose read-back shows a different `locked_by` reports as lost, with no state change
  - [ ] an expired claim is released at the top of the cycle
- `test/unit/orchestrator/checkpoints.test.ts`
  - [ ] `approve` moves the item to `resume_to` and appends the note to history
  - [ ] `reject` moves to `reject_to` and appends the reason where the next agent's context will pick it up
  - [ ] approving an item that is not `needs_human` is refused
  - [ ] a checkpoint disabled in config is skipped entirely, with the transition going straight through

Integration tests to write:

- [ ] **The M2 pipeline, on `MockRunner`:** `factory feature add sample.md` → `intake`; loop runs PM → feature pauses at `after_pm_refinement`; `factory approve` → `planning`; TL runs → `ticketing`; DL runs → 4 tickets created (2 of them parallelizable via `depends_on`) → pauses at `after_ticket_breakdown`; `factory approve` → `in_development`. Zero manual file edits beyond the two approvals.
- [ ] TL requesting refinement sends the feature back to `refining` and the PM's next run receives the TL's questions in context
- [ ] An agent returning `outcome: 'escalate'` pauses that feature at `needs_human` with the reason recorded, **and the rest of the pipeline keeps running** — assert a second feature advances in the same cycle
- [ ] A malformed ticket file is quarantined and the cycle completes normally
- [ ] `factory kill` stops new claims; in-flight runs finish
- [ ] **`factory start` against a vault whose `target_repo` was deleted spawns no agent process** *(moved here from Phase 4)*: assert by injecting a Runner that throws if called. Phase 4 covers the validation half; this is the half that needs a real `start` command and a real Runner to inject, neither of which existed at Phase 4.
- [ ] Crash recovery: kill the loop mid-dispatch, restart, assert the item is unclaimed and re-run, with no duplicate history lines
- [ ] `index.md` and `NEEDS_HUMAN.md` reflect state after every transition
- [ ] **Unknown-key survival through a full cycle** *(added after Phase 3 review)*: plant a human-authored frontmatter key on a note, drive a complete transition plus checkpoint cycle, assert it is still there. `Note<T>` has no type slot for unknown keys, so code that spreads frontmatter preserves them and code that rebuilds it field-by-field destroys them — with no type error either way. This test is the only thing that converts that silent-destruction risk into a red build.
- [ ] Regression: Phase 1–6 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] Every scenario above runs on `MockRunner` — no real agent is invoked in this phase at all. *Reinforced during execution: `factory start` now **refuses** to construct a non-mock Runner while no `WorkspaceProvider` exists, so this condition is enforced by code rather than by discipline. Before that refusal, a default-initialised vault would have run real `tl_plan` and `dl` agents with the operator's main checkout as their working directory.*

Risk: High — the loop is where every prior layer meets, and it is the first phase with real concurrency-adjacent behaviour (locks, claims, crash recovery). Splitting out 7b keeps that risk isolated from prompt work.
Touches shared/core files: Yes — `src/orchestrator/**` is the system's spine; Phases 9–11 extend it rather than replace it.

---

**Phase 7b — First real agents and prompt iteration (completes M2)**

> **REORDERED DURING EXECUTION — Phase 8 now runs before Phase 7b.** Phase 7a's review found that `factory start` on a default-initialised vault was fully reachable and would run real `tl_plan` and `dl` agents with the operator's **main checkout** as their working directory — so the sandbox's kernel write region surrounded their real files, with only the tool list in between, which is exactly the boundary ADR-003 says is not a boundary. Phase 7a closed it by making `factory start` refuse when `config.runner` is `claude-code` and no `WorkspaceProvider` exists. That refusal is what holds the line until Phase 8 supplies one, and it means 7b cannot run a real agent until Phase 8 lands. This is not a detour: spec §4.3 already required throwaway worktrees for `tl_plan` and `dl`, so 7b always depended on Phase 8 — the original order simply hid that dependency behind an unfenced default. **Build Phase 8 first, then return here.**

Goal: The paper pipeline runs on real PM, TL, and DL agents, and the prompts are revised until it does so reliably.

Implementation changes:

- `prompts/pm.md`, `tl_plan.md`, `dl.md`: revised against real behaviour. Expect this to be most of the phase's work. The failure modes to hunt: PM writing untestable acceptance criteria; TL producing a plan too vague for the DL to decompose; DL producing tickets that are not self-contained, which is the one that poisons Phase 9 silently.
- `src/orchestrator/attempts.ts`: **a schema-validation failure does not consume an attempt on first occurrence.** Retry once with the validation error injected into the prompt; only a second failure counts. Prevents a near-miss output contract from eating a ticket's whole budget three runs at a time.
- `src/agents/context.ts`: adjustments driven by what the agents actually turned out to need.

Unit tests to write:

- `test/unit/orchestrator/attempts.test.ts` (extends the file created in Phase 9's plan — created here instead, Phase 9 adds to it)
  - [ ] a first schema failure triggers a retry and leaves `attempts` unchanged
  - [ ] the retry prompt contains the specific validation error
  - [ ] a second consecutive schema failure increments `attempts` normally
  - [ ] a schema failure followed by a gate failure counts as one attempt, not two

Integration tests to write:

- [ ] The full M2 pipeline on real agents, run three times against the same requirement: all three reach `in_development` with valid tickets. Flakiness here is a prompt defect, not test flake, and must be fixed rather than retried.
- [ ] DL output for a 4-ticket feature produces a valid DAG with at least two parallelizable tickets
- [ ] Regression: Phase 7a's MockRunner suite still green — real-agent work must not require loosening any mechanical test

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] Three consecutive real runs succeed without prompt edits between them. ***Six** consecutive, not three, prompts byte-identical throughout — every one reaching `in_development` with a resolvable three-ticket DAG, two parallelizable tickets, and zero self-containment findings, verified offline from preserved transcripts. **Ticked under the plan's own wording, which is "reach `in_development` with valid tickets".** Under a stricter reading — "first time, every time, no retry anywhere" — it is **not** met: two of six needed the orchestrator's ordinary attempt-retry, and four of six had a failed delivery *within* a run. **No prompt edit closes that gap**; it is the CLI parameter-boundary parsing fault recorded in the measurement section, and it is the reason Phase 12 should not be surprised by it. One caveat recorded rather than hidden: `dl.md` changed after all six runs, by a one-line cross-reference fix (`below` → `above`) that is a pointer, not an instruction, so the tree no longer byte-matches the state that produced the evidence.*
- [x] Actual cost of one full M2 run recorded here. *Post-trim mean **$0.998**, down from Phase 6's $1.34, despite considerably more demanding prompts. Runs needing the attempt-retry cost roughly double ($2.02, $1.79). Full per-run table in the measurement section below.*


#### Phase 7b measurement results — real PM → TL → DL, 2026-09-01

*(Recorded here rather than only in chat, for the same reason as Phase 6's: a chat report does not survive a context clear. **The done-condition boxes above are deliberately left unticked — that is the human's call**, and the last subsection below says exactly which reading is satisfied and which is not.)*

**What was run.** Fourteen real PM → TL → DL sequences through the production `factory start` path — real `ClaudeCodeRunner`, real throwaway worktrees via `realWorktrees`, real instance lock, two real `factory approve` calls per run, zero manual file edits. The harness is `test/integration/pipeline-real.test.ts`, gated on `FACTORY_REAL_PIPELINE=1` and deliberately **not** on `FACTORY_REAL_CLI`: the latter is on for every `npm run test:all`, which costs ~$0.064, and folding a ~$1 pipeline into it would make the standard paid suite twenty times more expensive without anyone choosing that.

**Model.** `claude-sonnet-5` on CLI v2.1.220, read from each run's `system/init` event. The `tl_plan` and `dl` runs were confirmed to receive exactly `Glob, Grep, Read, StructuredOutput` — no write tools — inside their throwaway worktrees, which is Phase 8's isolation holding under a real agent rather than a probe.

##### Cost of one full M2 run

**$0.998 mean, range $0.80–$1.32**, across the six final runs at frozen prompts. That is *below* Phase 6's $1.34 baseline despite substantially more demanding prompts, because the Phase 7b trim (below) cut ~32% of the payload.

| Batch | Run | pm | tl_plan | dl | Total |
|---|---|---:|---:|---:|---:|
| A | 1 | 0.3343 | 0.5997 | 0.3826 | **1.3166** |
| A | 2 | 0.2189 | 0.3988 | 0.2618 | **0.8796** |
| A | 3 | 0.1644 | 0.3733 | 0.2599 | **0.7976** |
| B | 1 | 0.2643 | 0.5805 | 0.3992 | **1.2440** |
| B | 2 | 0.2066 | 0.5529 | 0.5588 + 0.6974 | **2.0157** |
| B | 3 | 0.2100 | 0.6129 | 0.7256 + 0.2382 | **1.7868** |

**A run needing an attempt-retry costs roughly double** ($2.02 and $1.79 against a $0.80–$1.32 clean run), because the failed delivery is paid for in full before the retry starts. Two of six needed one. Budget a feature's planning stage at ~$1.00 with a long tail to ~$2.00, not at a flat rate.

Phase-wide spend was **~$27**, most of it on the prompt iteration that produced the trim rather than on the final runs.

##### The Phase 7b trim — payload before and after

The Delivery Lead prompt was cut to stop restating what the Developer already receives. `project.md` and the target repo's `CLAUDE.md` reach every Developer **in full, verbatim**, and were being paraphrased again in every ticket's `technical_notes_md`; `notes_markdown` goes to the feature note for a human at the checkpoint and **no Developer ever sees it**.

| | mean | runs |
|---|---:|---|
| Before | **18,728 ch** | 18,540 / 18,507 / 19,137 |
| After | **12,732 ch** | 12,594 / 13,824 / 12,798 · 10,322 / 12,382 / 14,471 |
| | **−32%** | |

| field | before | after | |
|---|---:|---:|---|
| `notes_markdown` | 2,631 | 612 | −77% |
| `technical_notes_md`, all tickets | 4,331 | 2,557 | −41% |
| `description_md`, all tickets | 7,966 | 6,904 | −13% — substance, largely untouched |

**The trim cut repetition, not substance**, verified by reading a post-trim ticket through the real `buildContext` output. It still carries exact file paths, full export signatures including constructor contracts, the complete grammar, the exact import line, the reused error class's exact contract, an explicit out-of-scope statement, runnable acceptance criteria, and two fences — a file fence and *"must not import anything from a `format.ts` or `cli.ts` file — those do not exist yet in this ticket's worktree"*. It is denser than the pre-trim ticket, not thinner.

*(Measurement caveat: the "before" figures were taken with Python's `json.dumps` defaults, which add separator spaces and escape non-ASCII where the CLI does neither, inflating them ~1%. The pre-trim transcripts were deleted before this was noticed. True reduction is ~31%. Every "after" figure is JS-exact and matches the harness's own output, which is now the authoritative measurement.)*

##### The real failure mode: a parameter-boundary parsing fault, **not** a size ceiling

This supersedes Phase 6's conclusion that the DL payload sat at 4.9% of a 128,000-token ceiling with a ~20× margin. That measured the model's output ceiling; the binding constraint is the CLI's `StructuredOutput` delivery, and it fails far below it with `terminalReason: "structured_output_retry_exhausted"`.

**It is not a size limit.** Measuring the argument the model actually sent on every rejected call across the six recorded runs:

```
smallest REJECTED call:   2,145 characters
largest  ACCEPTED call:  14,471 characters
```

Rejections and acceptances overlap completely. The smoking gun is in the rejected calls' recorded `notes_markdown`, which literally ends:

```
…</notes_markdown>\n<parameter name="tickets">[…
```

The model **did** emit the tickets array; the CLI's parameter-boundary parsing glued it onto the end of the previous string field, which is why the rejection reads `root: must have required property 'tickets'` five times over for a payload that contained them. Three distinct rejection shapes were seen, and they should not be blended:

1. **Parameter-boundary mangling** — `root: must have required property 'tickets'`. The dominant mode, and the one above.
2. **Unparseable JSON** — `InputValidationError: StructuredOutput was called with input that could not be parsed as JSON`, seen at 7,158 bytes on a `pm` run.
3. **A genuine model omission** — `/tickets/0: must have required property 'depends_on'`, where tickets with no dependencies omitted the empty array while the dependent one carried it. This one *is* a prompt-fixable miss; see the unapplied improvement below.

**What size does correlate with is frequency**, not any individual outcome: at ~18,700 characters delivery failed often, at ~12,700 less often. That is what the trim bought — headroom, not immunity, exactly as the risk was framed when it was chosen.

**The orchestrator handled every instance correctly.** A failed delivery is an `api_error`, charged one attempt, retried the next cycle, and it succeeded every time. No feature was lost and no bad payload was written.

##### Two evidenced improvements, deliberately not applied

Both are recorded rather than made, because the done condition requires three consecutive runs with prompts unedited and the six-run evidence above is exactly that — editing a prompt now would make it stale and cost $6+ to rebuild. **Apply and validate these at Phase 12's real-agent acceptance run, where a run is being paid for anyway.**

- **One line in `prompts/dl.md`: "include `depends_on` on every ticket, `[]` when it has none."** Rejection shape 3 above accounted for roughly half of the observed first-call rejections, and it is a model omission of an empty array, not the parsing bug. Zero cost, directly evidenced.
- **The mangled emissions are pretty-printed JSON** (`[   {     "title"`) while the clean ones are compact. If that correlates it is a far cheaper lever than payload size, and it points at generation shape rather than volume. Unverified — worth one run's attention when one is being paid for.

##### Deviation: three tickets, not four

The plan asks for "a 4-ticket feature ... with at least two parallelisable tickets". Every one of the six runs produced **three** tickets with **two** parallelisable — an evaluator and a formatter with no dependency on each other, then a CLI depending on both. That is the honest shape of the requirement; a fourth would have been padding. The condition exists to prove the DAG is a graph rather than a chain, and two independent roots prove exactly that.

Phase 6's requirement was tried first, for cost comparability, and **found to be the wrong size**: under any competent design "evaluate + CLI" is a two-ticket, strictly sequential feature, so the parallelism condition was unreachable honestly on it. The requirement was changed to add an independent second capability, with the independence deliberately *unstated* in the text so that finding it remained a test of the prompt.

##### Reliably, but not cleanly — which reading of the done condition is met

Verified offline from preserved transcripts, all six runs at byte-identical prompts (`pm 8c16be26`, `tl_plan b67f8e25`, `dl 476ede12`):

```
batch A run-1: 3 tickets | 12594 ch | deps resolvable | 2 parallelisable | 0 self-containment findings
batch A run-2: 3 tickets | 13824 ch | deps resolvable | 2 parallelisable | 0 findings
batch A run-3: 3 tickets | 12798 ch | deps resolvable | 2 parallelisable | 0 findings
batch B run-1: 3 tickets | 10322 ch | deps resolvable | 2 parallelisable | 0 findings
batch B run-2: 3 tickets | 12382 ch | deps resolvable | 2 parallelisable | 0 findings
batch B run-3: 3 tickets | 14471 ch | deps resolvable | 2 parallelisable | 0 findings
```
*(`prompts/dl.md` is now `f7e484ee`. The only change made after these six runs is one word in a cross-reference — `See "Do not restate what they already have" below.` → `above.`, because the section is above. No instruction to the agent changed. Recorded because the hash no longer matches the evidence, and a hash that quietly drifts is worth less than one that is accounted for.)*
- **"Three consecutive runs reach `in_development` with valid tickets": MET, twice over.** Six consecutive, no prompt edits between them, every one with a resolvable DAG, two parallelisable tickets and zero cross-ticket references.
- **"Three consecutive runs complete first-time, with no retry anywhere": NOT MET.** Two of the six needed the orchestrator's attempt-retry, and four of six had at least one failed `StructuredOutput` delivery *within* a run.

The gap between those two readings is the parsing fault above. **No prompt edit closes it** — that is why the harness now warns on retries rather than failing on them, and why the remaining lever is a human decision about the DL contract rather than more prompt iteration.

##### What the harness asserts, and what it only warns about

Set from the six-run distribution rather than from guesswork, after an earlier version asserted `costs.length === 3` — a bar two of the six runs fail, in a test that had never been executed against a real run when it was written, with a failure message blaming a `schema_retry` that appears in none of the logs.

**Asserted:** exactly three *successful* agent runs; zero `schema_retry` events (the CLI and `src/agents/schemas.ts` never disagreed about a payload — the Phase 7b rule never had to fire in a real run); at most five agent runs in total; the DL payload under 16,000 characters as a trim-regression alarm.

**Warned only:** the DL payload above `config.payload_warn_chars`, and the DL needing more than one `StructuredOutput` call. Neither predicts failure, and a guard that fires on correct runs is a guard the next person disables.

`config.payload_warn_chars` defaults to **13,000**, just under the 13,113 of the smallest repeatedly-rejected call. It is a drift indicator and is expected to fire on a busy run. Two limits worth knowing: it is evaluated only *after* a payload is accepted, so it never sees the deliveries that failed; and it measures with compact `JSON.stringify` while the mangled emissions are pretty-printed, so it understates what the CLI carried. It fired once in a real run — on `tl_plan` at 15,417 characters.

Risk: Medium–High — no new architecture, but the outcome depends on prompt quality, which is iterative and hard to estimate. This is the phase most likely to overrun.
Touches shared/core files: `prompts/**`, `attempts.ts`, `context.ts`.

---

**Phase 8 — Git worktrees and provisioning**

> **REORDERED DURING EXECUTION — this phase now runs immediately after Phase 7a, before Phase 7b.** Phase 7a's `factory start` refuses to run real agents until a `WorkspaceProvider` exists, so **this phase is what unblocks every real-agent run in the project**. Two things follow. The throwaway worktrees `tl_plan` and `dl` need (spec §4.3) are no longer a Phase 9 concern that happens to be built here — they are the critical path, and 7b cannot start without them. And the `WorkspaceProvider` seam Phase 7a left in `resolveWorkspace` is the interface to fill; do not invent a second one.



Goal: A ticket gets an isolated, dependency-ready worktree, and orphaned worktrees are always cleaned up.

Implementation changes:

- `src/git/git.ts`: the `Git` interface from spec §8.3 — `createWorktree`, `removeWorktree`, `listWorktrees`, `mergeNoFf`, `diff`, `tag`, `branchExists`. All via `git -C`, no libgit2.
- `src/git/worktree.ts`: `provisionWorktree(ticket)` — create the branch from the feature branch, `git worktree add` at `<repo>/../.factory-worktrees/<vault-name>/<ticket-id>` (outside the repo and outside any temp path, spec §10 and §4.2), then **run `config.setup_command` (default `npm ci`) unsandboxed in the new worktree** (resolution A3 — a fresh worktree has no `node_modules`, and a sandboxed agent has no network to install them).
- `src/git/reconcile.ts`: `reconcileWorktrees(storage, git)` — remove any worktree whose ticket is not `in_progress`/`qa`, and recreate a missing worktree for a ticket that claims one. Called at startup and each cycle.
- `src/orchestrator/loop.ts`: wire reconciliation into step 5.
- `src/config/schema.ts`: add `setup_command` and `setup_timeout` (default 300s).

Unit tests to write:

- `test/unit/git/paths.test.ts`
  - [ ] the worktree path is outside the repo, outside `/tmp` and `/private/tmp` (spec §4.2 — a worktree on the sandbox temp allowlist silently disables write fencing)
  - [ ] branch naming `feat/<slug>/t00N-<short-title>` sanitises titles into valid git refs
  - [ ] a title with slashes, spaces, or unicode produces a ref `git check-ref-format` accepts

Integration tests to write (real git, disposable toy repo):

- [ ] `provisionWorktree` creates the worktree on the right branch cut from the feature branch, and `node_modules` exists afterwards
- [ ] `npm test` succeeds inside the freshly provisioned worktree — the assertion that resolution A3 actually fixed the problem
- [ ] Two worktrees for two tickets coexist without interfering; a commit in one is invisible in the other
- [ ] `removeWorktree` deletes the directory and prunes git's metadata
- [ ] Reconciliation removes a worktree whose ticket is `backlog`, and leaves one whose ticket is `in_progress`
- [ ] Reconciliation recreates a worktree deleted from disk while its ticket is `in_progress`
- [ ] A failing `setup_command` marks the ticket `needs_human` rather than handing the agent a broken tree
- [ ] Regression: Phase 1–7 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] Manual: after a full run, `git worktree list` on the toy repo shows no leftovers. *Verified: `.factory-test-repos/` holds only an empty `.factory-worktrees/` after a full `test:all`, and no escape artifact reached the home directory.*

Risk: Medium — git worktree state can desynchronise from disk, and leaked worktrees accumulate silently until a later run fails oddly.
Touches shared/core files: Yes — `src/git/**`, plus a new step in `loop.ts`.

---

**Phase 9 — Gates and the dev loop**

Goal: A ticket is built by the Developer, verified by real deterministic gates, then reviewed and QA'd — bouncing back on any failure until the attempt limit.

Implementation changes:

- `src/gates/runner.ts`: `GateRunner` per spec §8.2 — runs `tests` → `lint` → `build` as orchestrator child processes in the worktree, short-circuiting on first failure. Exit 0 is the only pass. Full output to disk, capped tail into `gate_results`.
- `src/gates/results.ts`: write `gate_results` frontmatter and a summary section into the ticket body.
- `src/orchestrator/dispatch.ts`: add the `in_progress → gates → code_review → qa` handlers. **The Developer's self-reported `outcome: 'ok'` never advances the ticket** — only a green gate run does (spec §5, rule 2).
- `src/orchestrator/commit.ts`: **the orchestrator commits, not the agent** (resolution A6). After the Developer exits, stage everything in the worktree and commit with the agent's proposed `commit_message`, unsandboxed. Refuses to commit an empty diff — an agent that changed nothing is a failed attempt, not a no-op success. Gates then run against the committed state, so what is verified is exactly what will be merged.
- `src/orchestrator/attempts.ts`: increment on gate failure, review `request_changes`, QA `fail`, timeout, crash, or schema failure; at `> max_attempts` pause with `pause_reason: attempts_exhausted` and the log paths linked.
- `src/agents/context.ts`: on retry, inject the gate output, review findings, and QA evidence so the Developer sees exactly why it bounced.

Unit tests to write:

- `test/unit/gates/runner.test.ts`
  - [ ] exit 0 → `pass`; any non-zero → `fail`
  - [ ] `lint` and `build` are not run after `tests` fails (short-circuit)
  - [ ] output longer than `gate_output_chars` is tailed in frontmatter but written whole to the log file
  - [ ] a gate command that does not exist reports `fail` with a clear message, not a thrown error
  - [ ] a gate exceeding its timeout is killed and reported `fail`
- `test/unit/orchestrator/attempts.test.ts`
  - [ ] each failure kind increments exactly once (no double-counting a gate failure that also fails schema validation)
  - [ ] at `max_attempts` the ticket pauses rather than retrying a final time (off-by-one)
  - [ ] a ticket-level `max_attempts` overrides the config default (spec §11)
  - [ ] a successful run resets nothing — `attempts` is a lifetime count, and the history shows every bounce

Integration tests to write (real git, real gates, `MockRunner`):

- [ ] Happy path: mock Developer writes a passing change → gates green → mock reviewer approves → mock QA passes → ticket reaches `merge`
- [ ] Mock Developer writes a genuinely failing test → gates red → ticket returns to `in_progress`, `attempts` = 1, gate output present in the next run's context
- [ ] Three consecutive failures → `needs_human`, `pause_reason: attempts_exhausted`, transcript paths in `pause_detail`
- [ ] Reviewer `request_changes` bounces to `in_progress` with findings appended to `## Review Notes`
- [ ] QA `fail` bounces to `in_progress` with evidence appended to `## QA Notes`
- [ ] **A ticket whose gates are red never reaches `code_review`** — assert the reviewer Runner was never invoked (requirements §6.2 hard gate)
- [ ] A Developer that reports `outcome: 'ok'` while leaving tests red is still bounced — the trust boundary
- [ ] A Developer that changes nothing produces no commit and a failed attempt, not a silent pass
- [ ] The commit on the ticket branch carries the agent's proposed message and is authored by the orchestrator (resolution A6)
- [ ] **A real Developer agent cannot commit**: with the Phase 5 fence in place, its own `git add` attempt fails and the orchestrator's commit is the only one on the branch
- [ ] Crash during a gate run: restart re-runs the gate rather than trusting a partial result
- [ ] Regression: Phase 1–8 suites still green

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] Manual: one real Developer agent run on the toy repo produces a commit that passes real gates. *Automated rather than done by hand, in `test/integration/dev-loop-real-cli.test.ts` (opt-in, CLI 2.1.220, ~$0.17). It also closes the harder half: told to run `git add -A` and `git commit`, the real agent got `unable to create temporary file: Operation not permitted`, exit 128 — and the verdict comes from `git log`, `for-each-ref` and `git diff --cached` being byte-identical before and after, never from the agent's prose. The orchestrator's commit is then the only one on the branch.*

Risk: High — the most moving parts, real subprocesses, and the place where agent unpredictability first meets deterministic checks.
Touches shared/core files: Yes — `dispatch.ts`, `context.ts`, and the ticket frontmatter shape.

---

**Phase 10 — Ticket merge to the feature branch**

Goal: A verified ticket lands on the feature branch, deterministically, with conflicts escalating rather than being guessed at.

Implementation changes:

- `src/orchestrator/merge.ts`: on `merge`, run `git merge --no-ff <ticket-branch>` into `feature/<slug>` in the **main checkout, not a worktree**; on success run gates on the feature branch; on green, remove the worktree, delete the ticket branch, set `done`. On conflict, abort the merge cleanly and pause with `pause_reason: merge_conflict` and the conflicted paths listed. No agent involvement (spec §3.1, ADR-004).
- `src/orchestrator/dispatch.ts`: wire the `merge` state.
- `src/domain/guards.ts`: `allTicketsDone` drives feature `in_development → awaiting_feature_close`.

Unit tests to write:

- `test/unit/orchestrator/merge.test.ts` (against a mocked `Git`)
  - [ ] a clean merge result triggers gates on the feature branch
  - [ ] green feature-branch gates set the ticket `done` and request worktree removal
  - [ ] **red feature-branch gates do not set `done`** — the ticket pauses, and the bad merge is reported
  - [ ] a conflict result pauses with the conflicted file list in `pause_detail`
  - [ ] a conflict always leaves the repo clean — `git merge --abort` is called on every conflict path, including when gates throw

Integration tests to write (real git):

- [ ] Two sequential tickets both merge into the feature branch, and the branch contains both commits in order
- [ ] Two tickets editing the same lines: the second conflicts, pauses, and the repo is left with no in-progress merge (`git status` clean)
- [ ] A ticket that passes its own gates but breaks the feature branch when combined is caught by the post-merge gate run and does not reach `done`
- [ ] After `done`, the worktree is gone and the ticket branch is deleted
- [ ] Feature moves to `awaiting_feature_close` only once the last ticket is `done`
- [ ] Regression: Phase 1–9 suites still green

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Manual: `git log --graph` on the toy repo shows one clean `--no-ff` merge commit per ticket

Risk: Medium — git merge itself is well understood; the risk is leaving the repo in a half-merged state on an error path, which the abort tests target directly.
Touches shared/core files: Yes — `dispatch.ts`, and it is the first code to write to a shared branch.

---

**Phase 11 — Final acceptance, feature merge, and tag (completes M3)**

Goal: You approve once, and the feature lands on the base branch, tagged and `done`.

Implementation changes:

- `src/orchestrator/featureClose.ts`: on `awaiting_feature_close`, run gates on `feature/<slug>`; on green, pause at the `final_acceptance` checkpoint with an approval summary (tickets, commits, gate results). On `factory approve`: `git merge --no-ff feature/<slug>` into the effective base branch, tag `factory/<slug>/<ISO date>`, set feature `done`. On `factory reject`: back to `in_development` with the reason recorded. Conflict escalates, never retries (spec §10).
- `src/orchestrator/actions.ts`: extend `approve` to trigger the merge path when the item is a feature at `final_acceptance`.
- `src/cli/status.ts`: show `done` features with their tag.
- `src/domain/states.ts`: confirm `done` means merged-and-tagged; no separate `deployed_ready`.

Unit tests to write:

- `test/unit/orchestrator/featureClose.test.ts`
  - [ ] red feature-branch gates block the checkpoint from ever being offered
  - [ ] the approval summary lists every ticket and its merge commit
  - [ ] approve triggers merge then tag, in that order, and neither runs if the other's precondition fails
  - [ ] the tag name is derived deterministically from slug and date
  - [ ] reject returns the feature to `in_development` and records the reason
  - [ ] a merge conflict into base pauses with `merge_conflict` and does not tag
  - [ ] `final_acceptance: false` in config merges without pausing

Integration tests to write (real git):

- [ ] Full close: all tickets done → gates green → checkpoint → `factory approve` → feature merged into base, tag present, feature `done`
- [ ] Base branch moved ahead since the feature branch was cut: the merge either succeeds or conflicts cleanly, and never silently drops commits
- [ ] Reject at final acceptance returns the feature to `in_development` and a subsequent new ticket flows normally
- [ ] The base branch is never written by any path other than this one — assert by checking base branch SHA is unchanged after Phases 9–10 scenarios
- [ ] Regression: Phase 1–10 suites still green

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Manual: the toy repo's base branch contains the feature and `git tag` lists it

Risk: Medium — small surface, but it is the only code that writes to the base branch, so the blast radius of a bug is the highest in the system.
Touches shared/core files: Yes — `actions.ts`, and the base branch itself.

---

**Phase 12 — Real-agent acceptance run**

Goal: Prove the whole thing works with real agents, end to end, and fix what only reality reveals.

Implementation changes:

- `docs/features/factory-m1-m3-acceptance.md`: the recorded run — feature used, cost, wall-clock, every escalation and why.
- `prompts/*.md`: revisions driven by what the real agents actually did. Expect this to be the bulk of the phase's work.
- Bug fixes across earlier phases as found; each gets a regression test in the phase it belongs to, not here.
- `README.md`: how to run the factory.

Unit tests to write:

- None new — this phase adds regression tests to earlier phases' files as bugs surface.
  - [ ] Every bug found gets a failing test in its home phase's file **before** the fix

Integration tests to write:

- [ ] The requirements §16 acceptance list, as far as M1–M3 reaches: sample feature with 4 tickets (2 parallelizable) to `done` with only the three approvals; a ticket failing tests 3× lands in `needs_human` with logs linked; a deliberately red base branch blocks merge; killing and restarting mid-run loses no state; the vault renders cleanly in Obsidian
- [ ] Regression: the entire suite, Phases 1–11

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] One real feature has gone `intake → done` on the toy repo with three human approvals and no manual file edits
- [ ] Cost of that run is recorded, so the M4 parallelism decision has a real number behind it

Risk: Medium — no new architecture, but real agents will find prompt and context problems that no mock could.
Touches shared/core files: Potentially all — treat every fix as a change to its original phase and re-run that phase's tests.

---

## Section C — Full test summary

**New test files:**

- `test/unit/scaffold.test.ts`: toolchain and toy-repo fixture helper
- `test/unit/domain/transitions.test.ts`: the full state machine rulebook, legal and illegal
- `test/unit/domain/dag.test.ts`: dependency resolution, cycles, diamonds, dangling refs
- `test/unit/domain/ids.test.ts`: deterministic ID generation
- `test/unit/domain/schedule.test.ts`: stage-priority ranking and determinism (M4 rules stubbed)
- `test/unit/vault/note.test.ts`: frontmatter round-trip, byte stability, type preservation
- `test/unit/vault/atomic.test.ts`: crash-safe writes, orphan temp sweeping
- `test/unit/vault/paths.test.ts`: path containment and traversal defence
- `test/unit/vault/storage.test.ts`: `Storage` interface behaviour and `appendSection` canonical ordering *(added during Phase 3 — omitted from the original list, but `appendSection`'s ordering is specified behaviour that nothing else covered)*
- `test/helpers/vaultFixtures.ts`: the adversarial frontmatter corpus (not a test file, but the thing the round-trip guarantee is worth exactly as much as)
- `test/unit/vault/index-md.test.ts`: index regeneration and idempotence
- `test/unit/config/resolve.test.ts`: all five resolution branches and their precedence
- `test/unit/config/schema.test.ts`: defaults, unknown keys, multi-error reporting
- `test/unit/config/validate.test.ts`: startup validation failures
- `test/unit/config/registry.test.ts`: the project registry, and the home fence around it *(added during Phase 4 — omitted from the original list. It is the only direct coverage of the one component that writes outside the vault and the target repo, and it carries the tests proving no suite run can reach the operator's real registry directory.)*
- `test/unit/runner/settings.test.ts`: sandbox JSON correctness — the fence itself, including the `.git` `denyWrite` paths
- `test/unit/runner/models.test.ts`: per-role model resolution and Sonnet default
- `test/unit/runner/argv.test.ts`: required and forbidden CLI flags
- `test/unit/runner/streamParse.test.ts`: JSONL parsing, all failure modes
- `test/unit/log/transcript.test.ts`: live-readable transcripts, `.runs` lifecycle
- `test/unit/agents/schemas.test.ts`: per-role output contracts
- `test/unit/agents/context.test.ts`: context recipes, truncation, cross-ticket leakage
- `test/unit/agents/profiles.test.ts`: per-role permission shape
- `test/integration/agents.test.ts`: per-role spec build, the prompts↔`AGENTS` bidirectional check, and the grep test forbidding heading string literals in `src/agents/**` *(added during Phase 6)*
- `test/integration/agents-real-cli.test.ts`: the real-CLI probes this phase owed — `--tools ""` on a no-tools role, and the converted JSON Schema being accepted by the CLI. Opt-in, same mechanism as `isolation.test.ts`; its non-spending checks run on every `npm test`. *(added during Phase 6)*
- `test/helpers/agentFixtures.ts`: the anti-tautology mechanism — builds context fixtures through `MarkdownStorage.appendSection` so the real writer and the real reader can be caught disagreeing *(added during Phase 6)*
- `test/unit/orchestrator/lock.test.ts`: instance lock and staleness
- `test/unit/orchestrator/claim.test.ts`: item claim and read-back
- `test/unit/orchestrator/checkpoints.test.ts`: pause, approve, reject
- `test/unit/orchestrator/attempts.test.ts`: attempt counting and limits
- `test/unit/orchestrator/merge.test.ts`: ticket merge decisions and abort paths
- `test/unit/orchestrator/featureClose.test.ts`: final acceptance, merge, tag
- `test/unit/git/paths.test.ts`: worktree location and branch-name sanitising
- `test/unit/gates/runner.test.ts`: gate execution, short-circuit, timeout, output capping
- `test/integration/vault.test.ts`: bulk fidelity and mid-write crash recovery
- `test/integration/cli-init.test.ts`: init, registry, startup validation, owner ref
- `test/integration/runner-stub.test.ts`: `ClaudeCodeRunner` against a stub `claude` executable
- `test/integration/isolation.test.ts`: **`verify-isolation`** — the real-CLI blast-radius probe; the only test that must not use a stub
- `test/integration/pipeline-paper.test.ts`: the M2 PM → TL → DL run on `MockRunner` (Phase 7a)
- `test/integration/pipeline-real.test.ts`: the same pipeline on real agents, run three times (Phase 7b)
- `test/integration/worktree.test.ts`: provisioning, coexistence, reconciliation
- `test/integration/dev-loop.test.ts`: developer → gates → review → QA, all bounce paths
- `test/integration/merge.test.ts`: ticket merges, conflicts, post-merge gates
- `test/integration/feature-close.test.ts`: final acceptance, base merge, tag
- `test/integration/acceptance.test.ts`: the requirements §16 list for M1–M3

**Modified test files:**

- None — greenfield. Every phase adds files; no phase rewrites a previous phase's tests. If a phase needs to change an earlier test's expectations, that is a spec change and gets raised at `/phase-review` rather than edited quietly.

**Regression test targets:**

Each phase must leave every earlier phase's suite green. The invariants that matter most, and are most likely to be broken by a later phase:

- `test/unit/domain/transitions.test.ts` — Phases 9, 10, 11 all add states; none may loosen an existing guard
- `test/unit/vault/note.test.ts` — Phases 9 and 11 add frontmatter fields; round-trip and byte stability must survive
- `test/unit/runner/settings.test.ts` — no later phase may weaken the sandbox to make a test pass
- `test/integration/isolation.test.ts` — must pass on every CLI upgrade; a failure here is a security regression, not a flake
- `test/integration/pipeline-paper.test.ts` — the M2 path must keep working once M3 states exist

---

## Section D — Recommended PR structure

**Five PRs.** One PR per milestone boundary would be too large to review; one per phase would be 12 PRs of which several are trivially coupled.

| PR | Phases | Why grouped |
|---|---|---|
| **PR 1 — Foundations (M1)** | 1, 2, 3, 4 | Scaffold, pure domain, vault I/O, and config together form the first thing that can be demonstrated: `factory init` producing a valid vault. Phases 2–3 have no user-visible output alone, so splitting them makes for unreviewable PRs. Ends on the M1 acceptance criteria. |
| **PR 2 — Agent invocation** | 5, 6 | Runner and agent definitions are one concern: how we talk to Claude Code. Both are testable entirely against stubs and mocks, with no orchestration. Reviewing them together means the sandbox settings and the profiles that produce them are read side by side — which is where a mistake would hide. |
| **PR 3 — Orchestrator loop** | 7a | The loop, locking, and crash recovery alone, all on `MockRunner`. Highest-risk phase; it deserves an undistracted review with no prompt discussion in the thread. |
| **PR 3b — Real agents (M2)** | 7b | Prompt revisions plus the schema-retry rule. Mostly `prompts/**`, reviewed for content rather than code. Ends on a demonstrable real PM → TL → DL run. |
| **PR 4 — Dev loop (M3 core)** | 8, 9 | Worktrees and the gate/dev cycle are inseparable: gates are meaningless without a worktree, and a worktree with nothing to verify proves nothing. |
| **PR 5 — Close the loop (M3)** | 10, 11, 12 | Both merge paths plus the acceptance run. Grouped because the ticket merge and the feature merge share `Git` methods and error handling, and the acceptance run is what proves both. |

Six PRs after the Phase 7 split. Every PR contains its phases' implementation and tests together. No PR contains implementation whose tests land in a later PR.

**PR 2 deserves the closest review in the set.** It carries the sandbox settings builder and the `verify-isolation` test — the only things standing between an agent and your base branch. A mistake there fails open and silently.

---

## Section E — What must NOT change

Greenfield, so there is no pre-existing product behaviour to preserve. What must not change are the invariants established as they are built — each maps to a regression target in Section C.

1. **The vault is never corrupted.** Every write stays atomic, and a crash at any point leaves a parseable vault. (Phase 3; `atomic.test.ts`, `vault.test.ts`)
2. **A no-op write produces a zero-byte diff.** No later phase may introduce a serializer that reformats notes. (Phase 3; `note.test.ts`)
3. **A red gate always bounces the ticket.** No role, verdict, config flag, or later feature may override it, and the Code Reviewer must never see a ticket with failing gates. (Phase 9; `dev-loop.test.ts`)
4. **The agent's self-report is never trusted.** Advancement comes from a gate run, never from `outcome: 'ok'`. (Phase 9)
5. **Agents never write to the vault.** The orchestrator is the sole writer. Any later convenience that hands an agent a vault path breaks ADR-002. (Phase 5–6; `profiles.test.ts`)
6. **Every agent runs with `--safe-mode` and `sandbox.enabled`.** No phase may drop either to make something work; the fence is the reason worktree isolation means anything. (Phase 5; `argv.test.ts`, `settings.test.ts`)
7. **Worktrees never live under a temp path.** The sandbox write allowlist covers `/tmp/claude*`, so a worktree there is silently unfenced. (Phase 8; `git/paths.test.ts`)
8. **Only Phase 11's code writes to the base branch.** (Phase 11; `feature-close.test.ts`)
8a. **No agent can ever stage, commit, install a git hook, move a ref, or edit `.git/config`.** The `denyWrite` fence on `.git/{hooks,config,refs,objects}` is not an optimisation — dropping it reopens a full sandbox escape into the orchestrator's permissions. (Phase 5; `isolation.test.ts`)
8b. **Nobody edits vault notes in Obsidian while the orchestrator is running.** There is no lost-update guard by decision (A8); this is a usage constraint the README must state plainly.
9. **A malformed note never stops the pipeline.** (Phase 7; `pipeline-paper.test.ts`)
10. **Scheduling is deterministic** — the same vault snapshot yields the same claim order. (Phase 2; `schedule.test.ts`)

---

## Section F — ADR update

`docs/adr/` does not exist. Phase 1 creates `docs/adr/README.md` and `docs/adr/TEMPLATE.md` (Context / Decision / Consequences), then these four ADRs are added. None supersedes anything — they are the first four. **Not created yet, pending your approval.**

---

### ADR-001 — Markdown vault as the source of truth

**Context.** The system needs durable state for features, tickets, and their history. The requirement is that state be human-readable, editable in Obsidian, and git-versioned, and that a human can understand the pipeline by reading files. A database would give transactions and queries but would make state opaque and would need a separate view layer to satisfy the Obsidian requirement.

**Decision.** All state lives in markdown files with YAML frontmatter, inside an Obsidian-compatible vault. Access goes through a `Storage` interface (`src/vault/storage.ts`) so SQLite can become the source of truth later with markdown as a generated view. No database in M1–M3.

**Consequences.** Positive: state is inspectable and diffable; a human can fix a stuck pipeline in a text editor; no schema migrations. Negative: no transactions, so correctness depends entirely on atomic writes and the single-writer rule of ADR-002; no indexed queries, so every cycle rescans every note, which is fine at POC scale and will not be at thousands of tickets; concurrent writes are a real hazard that ADR-002 exists to remove. Frontmatter round-trip fidelity becomes a load-bearing property needing its own test suite.

---

### ADR-002 — The orchestrator is the only writer of the vault

**Context.** Requirements §7 gives most agent roles "Write vault" access, and §13 acknowledges the resulting frontmatter races, proposing a partial single-writer rule for frontmatter only. Meanwhile the isolation work in ADR-003 fences agents into their worktrees, which would require deliberately re-opening a hole to let them write vault files.

**Decision.** Agents never write to the vault at all. Each returns a validated structured payload (via `--json-schema`), and the orchestrator writes every file — frontmatter, body sections, and history alike.

**Consequences.** Positive: the write race disappears rather than being mitigated; the sandbox fence becomes simple, since agents need no vault access; every run is replayable from its recorded output, making the pipeline testable with a `MockRunner`; validation happens at one boundary. Negative: a deviation from the requirements document that needs sign-off; large outputs such as `tech-plan.md` travel through a JSON field, so output size limits need watching; the orchestrator now owns note-formatting logic that agents would otherwise have handled, making it a larger component.

---

### ADR-003 — Agent isolation is enforced by the OS sandbox, not by tool permissions

**Context.** Requirements §7 assumes `--allowedTools` scopes an agent to its worktree. Fourteen probe runs against Claude Code v2.1.220 showed it does not: a `Bash`-enabled agent read and wrote freely outside its working directory, and `Read(...)` deny rules — which do catch `cat` — were bypassed entirely by `node -e "fs.readFileSync(...)"` with nothing recorded in `permission_denials`. Since a Developer agent must have Bash to run tests, the documented model provides no filesystem boundary at all. Separately, headless runs inherit the operator's personal `~/.claude/CLAUDE.md`.

The OS sandbox fixes the general case but not the git case. A linked worktree's real git directory lives at `<repo>/.git/worktrees/<id>`, outside the worktree, and the sandbox must permit writes there or `git commit` could not work. Since `.git` is shared by every worktree, an agent that can write it can move `refs/heads/main`, edit `.git/config`, or plant a `pre-commit` hook that later executes unsandboxed under the orchestrator — a complete escape. The default fence therefore satisfies "cannot touch other worktrees" but not "cannot touch the base branch".

**Decision.** Three layers, none sufficient alone:

1. `--safe-mode` on every run, excluding user and project instruction files, hooks, skills, plugins, and MCP servers.
2. `sandbox.enabled: true` with `filesystem.denyRead: ["~/"]` and an explicit `allowRead`; worktrees placed outside any temp path, because `/tmp/claude*` is on the sandbox's default write allowlist.
3. `denyWrite` on `<repo>/.git/{hooks,config,refs,objects}`, and **agents never commit** — the Developer leaves a dirty tree and proposes a commit message; the orchestrator stages and commits after it exits.

Read-only roles get a throwaway worktree that is force-removed afterwards, rather than relying on a deny-all glob. `test/integration/isolation.test.ts` asserts all of it against the real CLI.

**Consequences.** Positive: enforcement is at the kernel (macOS Seatbelt) and covers arbitrary child processes, verified as `EPERM` for the main checkout, sibling worktrees, the home directory, and every sensitive `.git` path; the agent retains `git status` and `git diff`, so it loses nothing it needs; git history gets a single writer, matching ADR-002's treatment of the vault; `--safe-mode` removes a class of nondeterminism from hooks and plugins.

Negative: the guarantee is coupled to one CLI version's sandbox behaviour, so `verify-isolation` runs on every upgrade and spec §14 is explicitly a calibration rather than a proof — the `.git` hole existed for a full planning cycle precisely because the first nine probes never used git. Sandboxed agents have no network, so dependency installation must be done by the orchestrator beforehand. The target repo's own `CLAUDE.md` is suppressed and must be injected deliberately. macOS and Linux only. And `--safe-mode` is documented as a troubleshooting flag, not a security control — we are relying on it off-label, and should watch its behaviour across releases.

---

### ADR-004 — Quality gates and merges are deterministic, never agent-driven

**Context.** Requirements §7 defines a `TL (merge)` agent that merges branches and resolves conflicts, and §9 requires gates to be hard requirements. An LLM resolving conflicts on a shared branch is the highest-blast-radius action in the system, and an agent reporting its own test results is a trust boundary with no verification behind it.

**Decision.** Gates run as orchestrator child processes, never inside an agent run, and their exit codes are the only signal that advances a ticket. Merges are plain `git merge --no-ff` performed by the orchestrator; a conflict escalates to a human. The `tl_merge` role is removed from M1–M3.

**Consequences.** Positive: the quality signal is deterministic and reproducible; an agent claiming success while tests fail cannot advance anything; no LLM ever holds write access to a shared branch; conflicts surface to a human while context is fresh. Negative: conflicts that an agent could plausibly have resolved now need a human, so throughput drops when tickets overlap — an argument for better ticket decomposition rather than for a merge agent; a deviation from the requirements document; if M4's parallelism makes conflicts frequent, this decision should be revisited with real data from the Phase 12 run.

---

## Section G — Feature done checklist

- [ ] All phases complete and committed
- [ ] Full test suite green — `npm test` (vitest, unit + integration), `npm run typecheck`, `npm run lint`
- [ ] E2E tests pass — `test/integration/acceptance.test.ts`, plus the Phase 12 real-agent run
- [ ] Plan doc updated with final session summary (`/session-summary factory-m1-m3`)
- [ ] PR open and linked to feature docs
- [ ] ADR-001 through ADR-004 added to `docs/adr/` (Section F)

### Debts carried forward — raised during execution, deliberately not fixed in the phase that found them

- **There is no CI, so "mandatory in CI" is currently a statement about the future.** `test/integration/isolation.test.ts` is the only proof the sandbox fence is real, and it is opt-in (`FACTORY_REAL_CLI=1` or `CI`). This repo has no `.github/workflows` or any other pipeline config, so nothing runs it automatically. Two always-on tests limit the drift window — a CLI-version pin, and a negative control that runs the probe unsandboxed and asserts every escape *succeeds*, so the probe cannot silently lose its ability to detect an unfenced world. But until a pipeline exists, a CLI upgrade can quietly void ADR-003 and no automated check will notice. **Set up CI before this is used against a repo that matters.**
- **The sandbox guarantee is macOS-only in practice.** ADR-003 claims macOS and Linux; every probe has been run on macOS Seatbelt at CLI 2.1.220. `XDG_CONFIG_HOME=/dev/null` is also unverified on Linux, and it applies to every tool the agent's Bash runs, not only git.
- **`assertStandardSandboxPath` catches the two syntax mistakes we know about**, `//abs` and `Tool(...)` form, but cannot catch a bare relative path where an absolute was meant, `~user` forms, trailing slashes, or symlinked paths. The real-CLI probe is the backstop. Accepted residual risk, documented in the module.
- **`prompts/tl_plan.md` asserts that the TL's `notes_markdown` becomes `tech-plan.md`.** That is a Phase 7 orchestrator contract invented inside a prompt — spec §5 and §6.2 never say where `tech-plan.md` comes from. **Phase 7a must either honour it or change the prompt**, because if 7a writes `tech-plan.md` from something else, the TL has been told to put the plan in a field nobody reads.
- **A squeezed retry may not know why it bounced.** `buildContext`'s truncation drops `## QA Notes` then `## Review Notes` before it drops `project.md`, so a context over `context_warn_chars` sacrifices exactly the bounce notes the retry exists to act on. The drop *is* recorded in the returned report. **Phase 9 should treat a dropped retry-note as escalate-worthy rather than merely logging it** — a retry that cannot see its own failure reason is a burned attempt.
- **`tech_doc_updates` on the `tl_plan` schema is ambiguous and has no consumer.** Two competent agents would return different things — filenames, or full updated contents — and nothing downstream is defined to read it. Settle its meaning or drop the field before anything depends on it.
- **`code_reviewer.md` and `qa.md` omit the "never edit `## Raw Requirement`" rule** that the phase's own text says every prompt states. Defensible, since both roles are told they cannot reach the vault at all, but it is a deviation from the plan and is recorded here rather than silently accepted.
- ~~**`test/integration/runner-stub.test.ts` has a wall-clock flake.**~~ **FIXED** after Phase 7a, once the orchestrator saw it fire for real (one failure in three consecutive suite runs). Both pid-file reads now poll until the JSON parses, with a deadline. No assertion changed — the diff removes exactly the two racing `JSON.parse(readFileSync(...))` calls and nothing else. Honest limit: an intermittent failure cannot be proven absent, only its mechanism removed; three consecutive runs are green where one in three previously was not. Original description follows.
- *(historical)* **The flake was:** The abort case aborts after a fixed 300 ms and then immediately reads a pid file the stub `claude` writes after node startup and a grandchild spawn; under a loaded suite the read can land in the open-truncate-before-write window and fail with `SyntaxError: Unexpected end of JSON input`. Verified as a **harness race, not an abort-semantics defect** — the failing line runs *after* the `failure === 'aborted'` assertion has already passed. Fix by polling for the file with a deadline. Left alone for now because a flake this well understood is safer than an unreviewed edit to Phase 5's runner tests, but it must be fixed before anyone can trust a red suite here.
- **A narrow lost-update window on `approve`/`reject`.** Those actions write without taking an item claim, so a startup `forceReleaseClaim` could in principle race a concurrent human approval. Reasoning only — never demonstrated with a test — and it needs two hosts to matter, which M1–M3's single-instance guarantee forbids. Revisit with M4's parallelism.
- **An agent that *modifies* a pre-existing ignored file is invisible to every check.** The commit snapshot, the ignored-artefact prune, and the post-commit clean check all miss it, so if a Developer patches something inside `node_modules` to make its tests pass, the gates verify the patched dependencies and report green. This is exactly the "make the tests pass by editing the deps" move, and it is the one shape of it the orchestrator cannot see. Phase 10's post-merge gates catch it on the feature branch, because that merge does not carry the patch — so it fails late and confusingly rather than silently. Worth closing properly if this ever runs against a repo that matters.
- **`DEFAULT_GATE_TIMEOUT_MS` is a constant, not a config key**, because spec §11's key set is closed and `config.yml` rejects unknown keys. A target repo whose test suite runs longer than ten minutes will bounce three times and park at `needs_human`. The reason is legible in the gate log ("timed out"), but an operator cannot raise the limit without a code change.
- **The `StructuredOutput` call-count early warning still lives only in a skipped paid test.** Phase 7b's ledger asked Phase 9 to surface it on `AgentRunResult` via `streamParse`, so the payload-mangling failure mode is visible in production rather than only to someone reading transcripts. Phase 9 did not do it and did not list it as outstanding. **Carried to Phase 10.**
- **The target repo must gitignore `node_modules` (or whatever `setup_command` installs).** Reconciliation decides whether a worktree holds uncommitted work with `git status --porcelain`, so a target repo that does not ignore its install output reads **every** provisioned worktree as dirty, retains all of them forever, and leaks worktrees silently. It fails toward retention, which is the safe direction — nothing is destroyed — but the disk fills and `git worktree list` grows without bound. This is an operator requirement the README must state.
- **`config.setup_command` is a deliberate trust boundary.** It runs **unsandboxed, with network, as the orchestrator**, in a directory built from the target repo, and `npm ci` executes whatever install hooks that dependency tree carries. That is the design (resolution A3) — a sandboxed agent has no network, so someone must install dependencies before the agent starts, and it cannot be the agent. What *is* fenced is the blast radius: a deadline, captured and capped output, and a failure that removes the worktree and marks the ticket `needs_human` rather than handing an agent a broken tree. The operator's real protection is that they chose `target_repo` themselves.
- **Latent, `stripForCli`:** the recursive `$schema` strip deletes any key with that name, including inside a `properties` map. A role field literally named `$schema` would lose its definition while remaining in `required`, producing a schema no payload can satisfy. No schema has such a field today.

---

## Delivery ledger

One row per phase, filled at commit time. This is the durable state — if every process died, `/resume factory-m1-m3` plus `git log` should be enough to carry on from here.

| Phase | Commit | Tests (pass/skip/files) | Gates | Review verdict | Carried forward |
|---|---|---|---|---|---|
| ADRs | `805b744` | — | — | — | Four ADRs accepted; 002/003/004 deviate from the requirements document by approved decision |
| 1 + 2 | `6f17366` | 143 / 6 / 7 | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — `mergeVerified` refusal tests added and mutation-proven on the second pass | Fixture `build` gate does not catch type errors (see Phase 1); frontmatter field set is inferred and first tested for real in Phase 3; Phase 10's `merge.ts` must thread `mergeClean` and `featureBranchGatesGreen` into the transition context or `merge → done` refuses |
| 3 | `ebf474d` | 418 / 6 / 14 | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — fence-aware history extracted to `src/domain/markdown.ts`, three nits closed | Fence fix verified by orchestrator, not the agent: the build agent stalled before reporting its final gates, so gates, the no-weakened-assertions diff, and a 16-test mutation proof were re-run here. `SECTION_ORDER` has four inferred section names — Phase 6 must reference the constant, never literals. Unknown keys ride on the runtime object with no type slot: spread frontmatter, never rebuild it. |
| 4 | `1f84372` | 537 / 6 / 19 | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — symlink-unsafe owner-ref comparison fixed and mutation-proven; two nits closed; the `~/.factory` collision escalated to a human decision and resolved by rename | Registry home is now `~/.app-factory/` (`~/.factory/` belongs to Factory.ai's CLI); `FACTORY_HOME` overrides it. Gate commands are only checked for *resolvability* — the sandboxed probe run of spec §11.1 needs Phase 5's runner and Phase 8's worktrees, so a green `validateStartup` does **not** mean `npm test` works in the target repo. Instance-lock check is Phase 7a, so `projects`/`status` always report `stopped`. Registry YAML shape is unverified against requirements §3.1, which is not in this repo. Symlink handling proved on macOS only. |
| 5 | `647956c` | 614 / 6 / 28 (`npm run test:all`); 613 / 7 / 28 (`npm test`, real-CLI case skipped) | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — the fence itself was found sound and kernel-verified; the reviewer reproduced the real-CLI probe independently at $0.023 and re-probed with the `denyWrite` removed to confirm which protections are ours. One real divergence fixed: mock and real runner disagreed on what an external abort meant. | **Spec §4.5 was wrong about read-only git.** `git status`/`git diff` fail exit 128 on `~/.gitconfig` under `denyRead: ["~/"]` — the fence blocked something the agent legitimately needs, before the `.git` fence was even reached. Fixed with `GIT_CONFIG_GLOBAL=/dev/null` + `XDG_CONFIG_HOME=/dev/null` rather than a read hole into the operator's home, since that file can carry credential helpers and token rewrites. **Probe 13 is partly stale:** on v2.1.220 the CLI's own default sandbox already blocks `.git/hooks` and `.git/config`; our fence is what still closes `.git/refs`, `.git/objects`, and `git add`. Do not read the CLI default as a reason to drop the fence. **`AgentFailure` gained a fifth kind, `'aborted'`** (spec §8.1 deviation, recorded there) — **Phase 7a owns whether it burns an attempt.** `AgentRunSpec` gained `itemId`/`featureSlug`/`attempt` (spec §12 needs them, §8.1 does not carry them) and an optional `validateStructured`; `AgentProfile.model` from spec §4.3 dropped in favour of `AgentRunSpec.model` + `resolveModel`. **`AgentProfile` is declared in `src/runner/types.ts`, not `src/agents/profiles.ts` — Phase 6 must import it, never redeclare it.** `--tools ""` for a no-tools role is asserted in unit tests only and **never exercised against the real CLI** — added as a Phase 6 done condition. See also the debts section under Section G: there is no CI, so nothing runs the isolation probe automatically. |
| 6 | `9589adb` | 716 / 6 / 33 (`npm run test:all`); 714 / 8 / 33 (`npm test`) | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — the reviewer reproduced the `$schema` rejection itself, re-proved both mutation defences with its own mutations, and spent $0.06 running the one schema whose keywords no real run had exercised. Three fixes landed: two cross-field refines and the `depends_on` payload refine. | **The CLI rejects zod's JSON Schema as emitted.** `z.toJSONSchema` writes `$schema: .../draft/2020-12/schema` and CLI 2.1.220 refuses it at exit 1 before spending a token — every agent run from Phase 7b onward would have failed identically, and no stub or unit test could have caught it. `$schema` is now stripped recursively. **`.refine()` never reaches the CLI** (verified: `.min()`/`.max()`/`.regex()`/`.nonempty()` all survive; `.refine()` alone is dropped), so every cross-field rule is orchestrator-side only — spec §5 rule 1 calls re-validation "belt and braces", but for those rules it is the only belt. **Schema-document comparison cannot prove nested strictness**: zod emits byte-identical output for `z.strictObject` and `z.object`, while loose *strips* an unknown key and strict refuses it — only a runtime test distinguishes them. `depends_on` carries ticket **titles**, not ids, because ids do not exist until the orchestrator writes the notes; a payload refine now enforces in-payload uniqueness and resolvability, which is what makes Phase 7's title→id resolution possible at all. **Cost baseline: $1.34** per PM+TL+DL at sonnet, 60× the haiku probe; a full feature plausibly $5–15, so Gate 1's warn-only `run_budget` deserves a second look. DL payload is 4.9% of the output ceiling — contract stays multi-ticket. **A human still owes an end-to-end read of the six prompts** — the only Phase 6 condition the orchestrator cannot close. |
| 7a | `11c7037` | 830 / 8 / 39 | typecheck 0, lint 0, test 0 | **STOP, then PROCEED after fixes** — the reviewer found `factory start` was fully reachable on the default path and would run real agents in the operator's own checkout. Escalated to the human, who chose the refusal plus a phase reorder. Two should-fixes also landed: the one-atomic-write test covered only one path, and a DL re-run after `reject` destroyed human ticket edits. | **Phase 8 now runs before Phase 7b** — `factory start` refuses real agents until a `WorkspaceProvider` exists, and Phase 8 is what supplies it. Spec §4.3 always required throwaway worktrees for `tl_plan`/`dl`, so 7b always depended on 8; the original order hid that behind an unfenced default. **`'aborted'` does not burn an attempt** — an orchestrator cancel is not the agent's failure, so three `factory stop`s cannot exhaust an innocent ticket. **A cycle advances several items sequentially**: spec §9 step 8's "claim the top item" is a concurrency cap, not a throughput cap, or one stuck feature would serialise the whole factory — the spec sentence should be reworded. `## Notes` was added to `SECTION_ORDER` for agent notes, TL questions, and human approve/reject reasons. Agent text containing `##` headings is now fenced, because a literal `## Acceptance Criteria` in a requirement **shadowed the real section** for the QA recipe. A same-state retry writes no history line (the state machine has no self-transition); `attempts` and the event log carry it instead. **A known flake lives in `test/integration/runner-stub.test.ts`** — see the debts section. Untested and carried deliberately: `feature add --priority`, the CliError paths, and `factory status`'s `running` branch. `dispatch.ts` is 1030 lines and should split at Phase 9 into role effects, attempt policy, and workspace resolution. |
| 7b | `b8b130b` | 967 / 10 / 46 (`npm test`) | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — the reviewer found the paid test as finally written **had never been executed** and would have failed 2 of the 6 preserved runs, so the done-condition headline rested on an offline check rather than on the committed test. Corrected and replayed: all six recorded runs now pass the committed bars. | **The binding limit is a CLI parsing bug, not payload size.** A rejected `dl` call's `notes_markdown` literally ended `…</notes_markdown>\n<parameter name="tickets">[…` — the model emitted the tickets array and the CLI's parameter-boundary parsing glued it into the previous string field, producing `root: must have required property 'tickets'`. **Rejected and accepted payload sizes overlap completely** (smallest rejected 2,145 chars; largest accepted 14,471), so **no threshold discriminates** — `payload_warn_chars` is a frequency-drift indicator only, and its comment says so. It also measures accepted payloads only, with compact JSON, so it never sees a failed delivery. **A first schema-validation failure no longer consumes an attempt** (spec §9.1 and §5 rule 4 corrected); forgiveness is per dispatch, giving a hard 2× bound on runs, and Phase 9 extends `attempts.ts`. Two evidenced improvements are deliberately **unapplied** so the six-run evidence stays valid, both queued for Phase 12: a `dl.md` line requiring `depends_on: []` on independent tickets (would remove roughly half the observed first-call rejections), and checking whether pretty-printed versus compact emission correlates with mangling. The early-warning signal still lives only in a skipped paid test — Phase 9 should surface the `StructuredOutput` call count on `AgentRunResult`. |
| 8 | `3b40d88` | 932 / 6 / 44 (`npm run test:all`); 929 / 9 / 44 (`npm test`) | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — the fence-critical evidence held completely: the reviewer ran the provisioned-worktree probe itself, traced the call to confirm the worktree comes from the real `provisionWorktree`, and reproduced the relocation mutation. Four should-fixes landed after. | **This phase lifts Phase 7a's refusal — real agents can now run.** The worktree root is **salted per vault** (`<vault-name>-<8 hex of sha256(realpath(vaultRoot))>`), a spec §10 deviation recorded there: the bare vault name collides, and while provisioning failed safe, **destroying did not** — one vault's reconciliation would `rm -rf` another's live worktree, and agents never commit, so that destroys work existing nowhere else. `destroyWorktree` also refuses a worktree whose `.git` points at a different repo. **The temp-root guard now resolves symlinks**; before, a path reaching a temp root through a symlink passed, and the module documented a protection it did not have. **Owning a worktree and creating one are now separate**: `needs_human` owns (so a paused ticket's tree survives for inspection) but does not create, or a persistently failing `setup_command` re-ran `npm ci` every cycle forever with no backoff. `setup_command` is a **deliberate trust boundary** — unsandboxed, with network, running the target repo's own install hooks; see the debts section. The target repo **must gitignore `node_modules`** or every worktree reads as dirty and leaks. `WORKTREE_OWNING_STATES` is deliberately a superset of the plan's literal `in_progress`/`qa` rule, because the literal reading deletes the tree of a ticket sitting at `gates` — which is where **Phase 9 runs gates**. Three `Git` methods beyond spec §8.3 (`pruneWorktrees`, `createDetachedWorktree`, `ensureBranch`), each forced by a required test. Still macOS-only, still no CI. |
| 9 | `1952b9e` | 1069 / 11 / 51 (`npm test`) | typecheck 0, lint 0, test 0 | PROCEED WITH FIXES — the reviewer found three leaks at the ignored-file edge, each proven with a live probe, all inside the phase's own central guarantee. It also established that **all three** red-gate locks are individually pinned, not two as reported. | **Gates run against the commit, not the dirty tree** — and that only holds because two mechanisms force the worktree to equal the commit. Without them spec §9's sentence is aspirational. **Staging never uses `git add -A`**: it diffs against a snapshot taken before the agent ran, which turns Phase 8's operator requirement ("the target repo must gitignore `node_modules`") into a property of the orchestrator instead. Three leaks fixed at that edge: git's collapsed `--ignored` view hid a fresh file inside a **pre-existing** ignored directory, so the flagship escape reopened on attempt 2; the staging filter ignored `snapshot.ignored`, so an agent deleting `.gitignore` swept in the dependency tree; and `--no-verify` closes only `pre-commit`/`commit-msg`, leaving `prepare-commit-msg` and `post-commit` to run **unsandboxed as the orchestrator** — now closed with `core.hooksPath=/dev/null`. **A red gate is locked three deep** (the gate verdict, the transition guard, and a dispatch role guard for a ticket a human hand-moved), each individually pinned, and the reviewer's Runner is asserted never invoked rather than merely the end state. The fixture's `build` gate still does not catch plain type errors — Phase 1 said "revisit if it bites", and it did not: the bounce is proven by a genuinely red `tests` gate. See the debts section for the ignored-file residual, the fixed gate timeout, and Phase 7b's `StructuredOutput` count now carried to Phase 10. |
| 10 | | | | | |
| 11 | | | | | |
| 12 | | | | | |

## Open Questions

*(None currently. Anything raised mid-execution that the plan does not cover gets recorded here before work continues, per the ambiguity rule.)*

---

## Session log — 2026-09-01

### 1. Phases completed this session

Gates 1–3 also ran this session: the spec (`factory-m1-m3-technical.md`) and this plan were both written from scratch, challenged by `/devils-advocate`, and revised. The plan is current — trust it over any memory.

- **ADR groundwork** (`805b744`) — created `docs/adr/` with a README and template, then the four founding ADRs. Also brought the working tree under version control; there was no git repo before this session.
- **Phase 1 — Scaffold and toy repo** (`6f17366`) — TypeScript project (ESM, Node 22, strict tsconfig with `noUncheckedIndexedAccess`), commander CLI root, and `fixtures/toy-app`, the dependency-free target repo with real `test`/`lint`/`build` gates that every later phase develops against.
- **Phase 2 — Pure domain** (`6f17366`, batched with Phase 1) — roles, states, types, the declarative ticket and feature transition tables with their guards, DAG resolver, deterministic ID generation, and the scheduling comparator. No I/O, enforced by an eslint boundary rule that is itself proven to fire.
- **Phase 3 — Vault I/O** (`ebf474d`) — atomic writes, the frontmatter parser/serializer, path containment, the `Storage` seam, and `index.md` regeneration. Also fixed a latent Phase 2 bug found during the work (see deviations).

Test count went 0 → 143 → 418 passing (6 skipped). All three gates exit 0 at every commit.

### 2. Files created or modified

**`805b744` — ADRs and version control**
- `docs/adr/README.md`, `TEMPLATE.md` — ADR convention and skeleton.
- `docs/adr/001-markdown-vault-source-of-truth.md` — markdown as source of truth, `Storage` seam for a later SQLite swap.
- `docs/adr/002-orchestrator-sole-writer.md` — agents never write the vault; they return schema-validated payloads.
- `docs/adr/003-os-level-agent-isolation.md` — `--safe-mode` + OS sandbox + `.git` denyWrite; agents never commit.
- `docs/adr/004-deterministic-gates-and-merges.md` — gates and merges stay out of agent hands.
- `.claude/commands/**` — pre-existing, tracked for the first time.

**`6f17366` — Phases 1 and 2**
- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore` — project scaffold.
- `eslint.config.js` — lint config plus the `src/domain` purity boundary (restricted imports and restricted syntax).
- `src/cli/main.ts` — commander root, version read from `package.json`. No subcommands yet.
- `src/index.ts` — public exports.
- `src/domain/roles.ts`, `states.ts`, `types.ts` — role and state enums, frontmatter types.
- `src/domain/transitions.ts` — declarative transition tables, `canTransition`, `applyTransition`, history formatting.
- `src/domain/guards.ts` — `allDependenciesDone`, `gatesAllGreen`, `allTicketsDone`, `attemptsRemaining`, `mergeVerified`.
- `src/domain/dag.ts` — actionable-set resolution, cycle detection, descendant counting.
- `src/domain/ids.ts`, `schedule.ts` — ID generation; stage-priority comparator.
- `fixtures/toy-app/**` — the target repo: `src/calc.ts`, `src/calc.test.ts`, `scripts/lint.mjs`, `scripts/build.mjs`, `package.json`, `package-lock.json`, `tsconfig.json`, `CLAUDE.md`.
- `test/helpers/toyRepo.ts`, `test/helpers/notes.ts` — fixture cloning and note builders.
- `test/unit/domain/{transitions,dag,ids,schedule,boundary}.test.ts`, `test/unit/scaffold.test.ts`, `test/integration/scaffold.test.ts`.

**`ebf474d` — Phase 3**
- `src/vault/atomic.ts` — `atomicWrite` (temp in same dir → fsync → rename → fsync dir), `sweepOrphanTemps`.
- `src/vault/note.ts` — `FRONTMATTER_ORDER`, `parseNote`, `serializeNote`, `NoteParseError`. Custom yaml engine so js-yaml's YAML 1.1 date coercion never runs.
- `src/vault/paths.ts` — every vault path in one place, segment validation and containment re-check.
- `src/vault/storage.ts` — `Storage` interface, `MarkdownStorage`, `SECTION_ORDER`, pure `appendToSection`.
- `src/vault/index-md.ts` — `buildIndex`, `regenerateIndex`.
- `src/domain/markdown.ts` — **new**, the shared fence-aware heading scan (`scanMarkdown`, `findHeading`, `sectionEnd`).
- `src/domain/transitions.ts` — **modified**, `appendHistoryLine` and `historyLines` now use the shared scan.
- `src/index.ts`, `eslint.config.js` — **modified**, vault exports and lint scope.
- `test/helpers/toyRepo.ts` — **modified**, added scratch-dir helpers and a runtime assertion rejecting temp roots.
- `test/helpers/vaultFixtures.ts`, `test/helpers/crashDuringWrite.mjs` — adversarial corpus; SIGKILL child.
- `test/unit/vault/{note,atomic,paths,storage,index-md}.test.ts`, `test/unit/domain/markdown.test.ts`, `test/integration/vault.test.ts`.
- `test/unit/domain/transitions.test.ts` — **modified, purely additive** (fence-awareness block).

### 3. Deviations from original plan

All are recorded in the plan and spec; none is outstanding.

1. **Toy fixture has zero npm dependencies.** Plan and spec §13 said vitest/eslint/tsc; shipped `node --test` plus hand-written lint and build scripts. A fixture needing `npm install` would make the suite slow, network-dependent, and non-hermetic. **Plan and spec both updated.** Accepted cost: the fixture's `build` gate catches syntax, resolution, and non-erasable TS, but **not plain type errors** — and Phase 9 treats a red build as a hard gate.
2. **Dev-dep list was missing a TypeScript parser.** eslint cannot parse TS without one, so `npm run lint` would have silently checked nothing in `src/`. Added `typescript-eslint` and `@eslint/js`. **Plan updated.**
3. **Test repos must not live in `os.tmpdir()`.** The sandbox write allowlist covers `$TMPDIR` and `/tmp/claude*` (ADR-003), so a fixture repo there would silently unfence sibling worktrees in Phases 8–11 and void Section E item 7. They go in a gitignored `.factory-test-repos/` with a runtime assertion. **Plan updated.**
4. **Scheduling rule numbering was off by one.** Requirements §8.1 rule 5 *is* the lexicographic tiebreaker that M1–M3 ships, so the deferred set is rules 2, 3, 4 plus the starvation guard — not "rules 2–5". Verified against the requirements document. **Plan and spec updated.**
5. **`applyTransition` takes `now` injected**, not read from a clock, or the domain could not stay pure and every later phase would need time-mocking. **Spec updated.**
6. **Unknown frontmatter keys are preserved by value and order, not "verbatim".** Byte preservation would need a side channel outside `Note<T>`, which `applyTransition`'s frontmatter spread would silently drop — destroying the human-authored keys the rule exists to protect. **Spec §7.2 updated.**
7. **Every string is emitted double-quoted**, not only timestamps, because Obsidian reads YAML 1.1 where bare `no` becomes `false` and `012` becomes `10`. **Spec updated.**
8. **Latent Phase 2 bug fixed during Phase 3.** `appendHistoryLine` and `historyLines` found `## History` by plain line match, so a fenced code block containing that text captured every history entry — on the path `applyTransition` runs on every transition. Extracted the fence-aware scan `appendToSection` already had into `src/domain/markdown.ts` and pointed both at it. Disabling fence tracking now turns 16 tests red.
9. **`test/unit/vault/storage.test.ts` added** — absent from Section C's file list, but `appendSection` ordering is specified behaviour nothing else covered. **Plan Section C updated.**

### 4. Current state

**Phase 3 is complete and committed (`ebf474d`, ledger row `9a0c8bb`). The working tree is clean and all gates are green.**

Nothing is mid-flight. The next phase not started is **Phase 4 — config, project resolution, and `factory init`**, which completes M1.

Execution settings agreed for this run, which carry forward: commits are **pre-authorised** (never `git push`, never a PR); Phases 1+2 were batched and everything after runs one phase per agent; ADRs were written before code.

### 5. Watch out for

- **`src/domain/dag.ts` contains a raw NUL byte** at offset 3220, inside the `rotated.join(...)` call in the cycle-key builder — a literal control character in the source instead of a `\u0000` escape sequence. Git therefore classifies the file as **binary and will not diff it**, which silently defeats code review on that file for every future phase. Not fixed; this session was summary-only by the time it was found. One-character fix, worth doing first thing next session.
- **The fixture `build` gate does not catch type errors** (deviation 1). Phase 9 treats a red build as a hard gate, so revisit there if the fidelity gap bites.
- **`SECTION_ORDER` has four inferred section names.** Phase 6's context recipes must reference the constant, never heading string literals — a literal typo silently extracts nothing. Already added as a Phase 6 done-condition.
- **Unknown frontmatter keys have no type slot on `Note<T>`.** Code that spreads frontmatter preserves them; code that rebuilds it field-by-field destroys them, with no type error either way. Phase 7a has a test queued to turn that into a red build. Spread, never rebuild.
- **Phase 10's `merge.ts` must thread `mergeClean` and `featureBranchGatesGreen` into the transition context**, or `merge → done` refuses. Deliberate — it fails toward a stuck ticket rather than a bad merge.
- **A build agent stalled mid-run during Phase 3** and never reported its gates. Treat a stalled or truncated agent report as a failed phase: re-run the gates yourself, diff pre-existing tests to confirm nothing was weakened, and re-do any mutation proof before committing. That is what happened here, and the work turned out sound.
- **Mutations must actually disable the behaviour under test.** A first attempt at the fence mutation zeroed the `fenced` array but left the `continue` that excludes fenced headings, so it proved nothing and briefly looked like two weak tests. The correct mutation killed 16.
- **`priority` on `FeatureFrontmatter` is written and read but unused** until M4 ranking. Not dead code — just not load-bearing yet.

### 6. Next action

```
/resume factory-m1-m3

Phases 1-3 are committed and green (418 tests, all gates 0). Start Phase 4 —
config, project resolution, and factory init. First, fix the raw NUL byte in
src/domain/dag.ts that makes git treat the file as binary. Commits are
pre-authorised; never push, never open a PR.
```

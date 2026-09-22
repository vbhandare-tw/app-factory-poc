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
- [x] `verify-isolation` passes against the installed CLI version, and that version is recorded in the test file so a future failure is immediately attributable to an upgrade. *`PROBED_CLI_VERSION` now lives in `test/helpers/cliVersion.ts` and reads `'2.1.258'` (re-probed 2026-09-02, see the ledger); it was `'2.1.220'` when this box was first ticked. Asserted by an always-on test. The real-CLI case is opt-in (`FACTORY_REAL_CLI=1` or `CI`) via `npm run test:isolation` / `npm run test:all`, ~$0.023 per run. **Ticked on evidence the orchestrator reproduced independently**, not on the implementer's report: the review agent ran the probe itself, confirmed the binary executed is the real 2.1.220 rather than the test stub, confirmed the probe arena is outside every temp path, and re-probed with the `.git` `denyWrite` removed to establish which protections are actually ours.*

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

  **Corrected during Phase 10 — this paragraph was wrong about the hard case.** It says a red post-merge gate "pauses and reports", which is not sufficient: by the time those gates run the merge is already **committed**, and `git merge --abort` only works on a merge still in progress. Pausing would leave the feature branch permanently carrying a merge that fails its own gates, so every later ticket merges onto a broken branch and the *next* ticket's merge looks like the cause. The implementation therefore **resets the feature branch to the SHA it had before the merge** and records both SHAs. Nothing is destroyed — the ticket branch still holds every commit, agents never commit (ADR-003), and a merge commit is reproducible by definition. The gates also run in a throwaway worktree detached at the merge commit, not in the main checkout, for the same reason Phase 9 runs ticket gates against the commit rather than the tree.

  Two further corrections, both from the Phase 10 review and both about the same destructive path. The post-merge gates reach `git reset --hard` in the operator's own checkout, so: the checkout is restored to its starting branch **before** any revert, which lets git move the branch by reference and touch no working tree at all; and `resetBranch` re-checks for uncommitted tracked changes immediately before the reset and **refuses** rather than resetting. The original single pre-merge dirty check left a window as long as the target repo's test suite, and a human edit made inside it was destroyed in a live probe.
- `src/orchestrator/dispatch.ts`: wire the `merge` state.
- `src/orchestrator/attempts.ts`: two new failure kinds, `merge_conflict` and `merge_gates`, **neither charging an attempt** (spec §9.1 updated). Not in the original plan, which said only that merge failures belong here.
- `src/domain/guards.ts`: `allTicketsDone` drives feature `in_development → awaiting_feature_close`.

Unit tests to write:

- `test/unit/orchestrator/merge.test.ts` (against a mocked `Git`)
  - [x] a clean merge result triggers gates on the feature branch
  - [x] green feature-branch gates set the ticket `done` and request worktree removal
  - [x] **red feature-branch gates do not set `done`** — the ticket pauses, and the bad merge is reported. *Stronger than specified: the merge is also reverted, since it is already committed by then. Mutation-proven twice — the orchestrator re-ran the reviewer's mutation independently.*
  - [x] a conflict result pauses with the conflicted file list in `pause_detail`
  - [x] a conflict always leaves the repo clean — `git merge --abort` is called on every conflict path, including when gates throw. *Weaker than specified in one respect, recorded by the reviewer: no unit test observes the abort call itself, because it lives inside `ShellGit` and there is no fake-exec test for it. The real-git integration case proves the end state, and removing the abort makes that case fail, so the abort is proven load-bearing rather than proven called.*

Integration tests to write (real git):

- [x] Two sequential tickets both merge into the feature branch, and the branch contains both commits in order
- [x] Two tickets editing the same lines: the second conflicts, pauses, and the repo is left with no in-progress merge (`git status` clean)
- [x] A ticket that passes its own gates but breaks the feature branch when combined is caught by the post-merge gate run and does not reach `done`
- [x] After `done`, the worktree is gone and the ticket branch is deleted
- [x] Feature moves to `awaiting_feature_close` only once the last ticket is `done`
- [x] Regression: Phase 1–9 suites still green. *1145 passed / 11 skipped / 54 files, re-run by the orchestrator itself after every round of fixes.*

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] Manual: `git log --graph` on the toy repo shows one clean `--no-ff` merge commit per ticket. *Done by the orchestrator with a throwaway probe over the real integration harness, then deleted. Two merge commits, each with **two parents** (`48f7aa7` ← `b135d93`+`e3c6cc4`, `b135d93` ← `bb06f38`+`551a837`), each ticket's own commit reachable, base commit at the root. The two-parent count is what distinguishes a real `--no-ff` merge from a fast-forward or a squash, and the existing integration test asserts the merge subject lines but not the topology — so this condition was worth closing by hand rather than by citing that test.*

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

*(Recorded during Phase 11 execution — five things this block did not anticipate.)*

1. **The block does not mention the transition guard, and it was the phase's largest finding.** `awaiting_feature_close → done` carried **no `guard` field at all**, while its own description in `src/domain/transitions.ts` already claimed the thing it did not check: "merged into base and tagged". Neither did `needs_human → done`, which is the route `factory approve` actually takes — the `final_acceptance` checkpoint parks the feature at `needs_human` with `resume_to: done`. So a human running `factory approve` could drive a feature to `done` while the base merge conflicted, failed, or never ran, and `done` is terminal, so nothing ever re-checked. Both rules now carry `featureCloseVerified`, in the same fail-toward-stuck shape as the ticket side's `mergeVerified`: `baseMergeClean` and `featureTag` arrive in the transition context, nothing else in the system sets them, and `!== true` means an absent fact refuses.
2. **`awaiting_feature_close` was not actionable at all**, in either `loop.ts` or `dispatch.ts` — `roleForFeatureState` returns `null` for it, so a feature that got there was permanently terminal. Phase 11 adds `ActionableOptions.featureClose`, gated on `canCloseFeature`, and a `handle` branch. That also means the state stopped being terminal, which is what made one Phase 10 assertion stale (see the ledger row).
3. **`final_acceptance: false` records the transition with the `orchestrator` actor, and the transition table was widened to permit it.** *(Escalated to the human mid-phase and decided by them; the first attempt recorded `human` in order to keep `test/unit/domain/transitions.test.ts`'s `rule.actors === ['human']` assertion intact. That was the wrong trade: `actor` is the one machine-readable field in a history line and a later query would trust it, so a line claiming a person approved a feature no person saw is a false audit trail — which matters more than one pinned assertion.)* `awaiting_feature_close → done` now permits `[orchestrator, human]`; the history note still carries the reason (`final acceptance auto-approved (the final_acceptance checkpoint is disabled in config)`).

   **Actor lists are not conditional on config**, so that widening applies to every run — including the ones where `final_acceptance` is **on**. The human checkpoint is not decorative anyway, and the reason is not in the transition table:

   - **`needs_human → done` stays human-only.** It is the route that resolves the checkpoint pause, and if the orchestrator could take it the approval the checkpoint exists to demand would be optional. Pinned per-route rather than table-wide.
   - **The checkpoint decision is made before any base-branch write.** `runFeatureClose` reads the config switch and returns at the pause; `mergeAndFinish` — the only caller of `closeFeature` on the dispatcher's side — is never reached, so the two facts `featureCloseVerified` demands are never produced for a feature that should be waiting on a person. The guard alone would *not* have saved this: the close is the code that produces those facts, so by the time it asked it could answer.
   - **A second lock in `mergeAndFinish` re-reads the config switch and refuses**, before `closeFeature`, for the route a future caller (a retry path, a resume, an M7 dashboard action) would otherwise open. Same shape as `dispatch.ts`'s second lock on the hard gate: not redundant, because it closes a different way in.

   Proven by mutation rather than asserted from reasoning: with the **first** lock removed the base branch still did not move (probed on real git — base SHA unchanged, `git tag` empty, no `feature_close_started` event, feature parked with the refusal); with **both** removed it moved and was tagged with nobody having approved, and both required "never advanced past" cases went red. The *property* is pinned by `test/unit/orchestrator/featureClose.test.ts` (dispatches driven) and `test/integration/feature-close.test.ts` (cycles driven, with `cycle_started` counted so the assertion cannot pass because the loop had stopped, and an approval afterwards as the control that the machinery worked throughout).

   ~~Pinned by...~~ **Corrected after review — the second lock itself was NOT pinned when that sentence was written.** The review found it unreachable and untested: `mergeAndFinish` was not exported, no production path calls it with the checkpoint on, and removing the lock left all 224 tests green. The property tests above cover the *first* lock and the ordering; they say nothing about the second. It is now exported for `test/unit/orchestrator/featureClose.test.ts`'s `the second lock in mergeAndFinish` block — a refusal case and a `final_acceptance: false` control — and removing the lock now fails the refusal case. Exported solely for that, in the same spirit as `payloadChars` and `parsePorcelainZ`: the part that can be wrong invisibly is the part that gets a seam.
4. **The approval summary reads each ticket's merge SHA back out of its `## History`.** The ticket branch is deleted on a successful merge and `TicketFrontmatter` has no field for the commit, so the `merge → done` history note (`merged <sha> into <branch>`) is the only surviving record. `mergeCommitOf` parses it and returns `null` rather than guessing — a summary that invented a plausible SHA would be worse than one that admits it does not know, since the whole point of the number is that a human can check it.
5. **The gate verdict went stale between the checkpoint and the approval, and the base branch took an unverified commit.** *(Found by the Phase 11 review, reproduced independently, and the most serious defect in the phase.)* The feature-branch gates run **before** the checkpoint; the approval arrives whenever a person gets to it. Nothing re-checked in between, so anything landing on `feature/<slug>` inside that window went to the base branch unverified and was tagged as a delivery. Probed on real git: a failing test committed after the checkpoint reached the base branch, `pause_reason: null`, `status: done`, tagged. That is the same class of bug Phase 10 found one level down — a check made once with a window after it — except the window is as long as a human's attention span rather than as long as a test suite, and it breaches Section E item 3 in spirit because a **stale green** does what no red gate is permitted to do.

   Fixed the way Phase 10 fixed its window. `FeatureFrontmatter` gains **`verified_sha`**, written in the same single write as the checkpoint pause, and `factory approve` re-checks it against the feature branch tip before it merges anything. `null` refuses, for the same reason `featureCloseVerified` reads `!== true`. It **refuses rather than re-running the gates**: refusing fails toward a stuck feature rather than an unverified base branch, and re-running them from `approve` would need a gate runner and a worktree provider in the CLI's action context — handing every `approve`/`reject`/`kill` the ability to run subprocesses in the target repo to do a job the loop already does on its next cycle. The refusal rewrites `resume_to` to `awaiting_feature_close`, so approving again sends the feature back to be verified afresh; a refusal with no way out is its own bug. Note the check is **not** "do the gates still pass": a commit added after the checkpoint may be perfectly green and is still one no approver ever saw, and `refuses even when the branch moved and is still green` is the case that separates the two designs.

6. **The approval summary promised a tag name the tag would not have.** The summary is written at checkpoint time and the tag created at approve time, each formerly reading its own clock. The review could not demonstrate it (its probe straddled midnight and landed on one date by luck); pinned down here with injected clocks — checkpoint at `2026-09-02T23:00:00Z` promised `factory/sample/2026-09-02`, approval at `2026-09-03T09:15:00Z` created `factory/sample/2026-09-03`. **`paused_at` is now the single authority**: `runFeatureClose` reads the clock once, that instant becomes `paused_at` via `pauseItem`, and `approve` re-derives the name from it. So the delivery is dated by when it was *verified* rather than by when somebody got round to clicking, and the date is stable across a retry — which is also why `reparkFeature` deliberately does not touch `paused_at`.

7. **Four review should-fixes, folded in.** *(a)* `leaves the operator's checkout on the branch it was on` was **vacuous** — the toy repo starts on the base branch, which is what the close checks out, so the assertion held with `restoreCheckout` stubbed to a no-op. Replaced by two cases starting on `wip/mine` and on the feature branch, and the no-op mutation now fails. *(b)* `restoreCheckout` emitted `feature_close_refused`, whose contract is "nothing was attempted, the base branch was not touched at all" — on that path the merge has landed. It now emits a distinct `feature_close_cleanup_failed`. *(c)* `ignores SHAs on lines that are not the merge` decoyed with `gates → code_review`, which the `endsWith('done')` half already skips, so it survived dropping `startsWith('merge ')` entirely; the decoy is now `needs_human → done`, which only the `merge ` half rejects. *(d)* A feature's `attempts` never moves, so every close verification wrote `attempt 1` log paths and a re-verification after a reject **overwrote the earlier run's gate logs** — destroying the run whoever is debugging a rejected feature came to read. The log path now carries the verified commit. Deliberately *not* fixed by incrementing `attempts`: nothing reads a feature's attempt count, and `attempts.ts`'s own rule is that a number nobody acts on should not be written.

8. **A refused approval is recorded in the event log, and deliberately not in `## History`.** `feature_close_refused` is emitted from the stale-verdict path so that spec §12's "one line per decision" holds for a decision that changes nothing. It gets no `## History` line because History is the transition audit trail and a refused approval is not a transition — writing `needs_human → needs_human` to make the attempt visible would put a move that never happened into the one record that is supposed to be only real moves.

9. **`FeatureVerifyRequest` gained an optional `label`.** The close reuses Phase 10's `FeatureWorkspaceProvider` (same question: "a tree that is exactly this commit, with dependencies"), but the provider named the directory `<ticketId>-merge-verify`, and a directory claiming to be a merge verification before anything has been merged misleads whoever finds it. Additive; the ticket merge's behaviour is unchanged.

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

- [x] All phases complete and committed
- [x] Full test suite green — `npm test` (vitest, unit + integration), `npm run typecheck`, `npm run lint` — 1347 / 12 / 58, build clean
- [x] E2E tests pass — `test/integration/acceptance.test.ts`, plus the Phase 12 real-agent run (`docs/features/factory-m1-m3-acceptance.md`)
- [ ] Plan doc updated with final session summary (`/session-summary factory-m1-m3`)
- [ ] PR open and linked to feature docs
- [x] ADR-001 through ADR-004 added to `docs/adr/` (Section F)

### Debts carried forward — raised during execution, deliberately not fixed in the phase that found them

- **CI now exists, but the fence job has never executed — the debt is half-closed, not closed.** `.github/workflows/ci.yml` runs typecheck, lint, build and the free suite on every push to `main` and every PR, with `CI: '0'` at job level so the three real-CLI files' paid `describe.skipIf` suites stay off while every free assertion in them — the version pin, the unfenced-world negative control, the profile checks — still runs. `.github/workflows/sandbox-fence.yml` is the one that closes the original debt: weekly and on manual dispatch, it installs the CLI at `@latest`, runs the three probe files, and lets the same pin assertion fail there when upstream moves. `test/unit/ci/workflow-contract.test.ts` holds both workflows to that contract by evaluating the real `RUN_REAL_*` expressions against each step's reconstructed environment, so the opt-out cannot silently stop working. **What is still owed: there is no git remote, so neither workflow has ever run.** Nothing here proves GitHub accepts the files, that Seatbelt behaves the same inside a hosted macOS VM as it does on a laptop, or that `ANTHROPIC_API_KEY` auth observes what a subscription session observes. The first `workflow_dispatch` of the fence job must be read as a first run, not trusted. Note also that GitHub disables `schedule` triggers after 60 days of repo inactivity, and routes scheduled-run failures only to the last committer of the workflow file — two silent ways the fence stops running.
- **It is not only the sandbox guarantee that is macOS-only — the whole test suite is.** ADR-003 claims macOS and Linux; every probe has been run on macOS Seatbelt, at CLI 2.1.220, 2.1.258 and 2.1.276. `XDG_CONFIG_HOME=/dev/null` is also unverified on Linux, and it applies to every tool the agent's Bash runs, not only git. **Measured while writing the CI workflows:** the free suite does not pass in a `node:22.13.0` Linux container. Three files fail — one of them a real product defect (next bullet), one a git-identity environment issue now handled by a CI step, and `merge.test.ts` timing-sensitive with the cause not established. Both CI jobs therefore run on `macos-latest`, which bills at a higher multiplier on private repos. That is a deliberate trade, not an oversight.
- **`src/git/exec.ts` kills the shell but not the command under it, so on Linux a hung gate hangs the factory forever.** Found while establishing why the suite fails on Linux; reproduced independently by the orchestrator and by the implementing agent. `execCapture` spawns with `shell: true` and then calls `child.kill('SIGTERM')` and `child.kill('SIGKILL')`, which signal the shell only. On macOS `/bin/sh` is bash and `exec`s its single command, so the signal reaches the real process. On Debian/Ubuntu `/bin/sh` is dash, which does not — the shell dies, the grandchild is reparented to PID 1 and survives. Worse, that surviving grandchild holds the stdout and stderr pipes open, so Node's `close` event never fires, and `finish()` is reachable only from `close` or `error`. **The promise never settles at all**: the timeout fires, `timedOut` is set, and nothing is ever delivered. Probe results — macOS `{closeEventFired: true, grandchildStillAlive: false}`, Linux/dash `{closeEventFired: false, grandchildStillAlive: true}`. It reaches both `src/gates/runner.ts:150` (every quality gate) and `src/git/worktree.ts:348` (the `npm ci` provisioning step). Section E item 3 says a red gate always bounces the ticket; a gate that never returns never bounces anything. **Not fixed here** — it is Phase 9 code and needs its own regression tests. The fix is a process-group kill (`detached: true` plus `process.kill(-pid)`). **Done condition for this debt: `checks` moves to `ubuntu-latest`**, which is currently blocked on it — and which would also cut the CI bill tenfold.
- **`factory approve` now runs git in the operator's checkout while a running orchestrator may be doing the same for another feature's ticket merge.** There is no cross-process lock on the checkout, and M1–M3 has no `max_active_features`, so this is reachable rather than theoretical. **Phase 11 is the first time `approve` touches git at all**, which is why it appears now. Related to the recorded approve/reject lost-update hazard. Raised by the Phase 11 reviewer as uncertain and **not probed**.
- **The recorded diagnosis of the `runner-stub.test.ts` external-abort flake is unconfirmed and probably wrong.** It blames the 300 ms `setTimeout` that fires the abort. But the failure takes ~5300 ms, and both `readPids` and `waitForDeath` carry **5-second** deadlines, which fits far better. Nobody has captured the actual error text: the orchestrator saw it fail twice under heavy machine load and then pass four consecutive times once the load cleared, in isolation, and the Phase 11 reviewer ran the file **fourteen** more times (eight under real-git load) at 12/12 every time. Do not re-diagnose it without the failure message — fixing the timer would be acting on a signal that merely pattern-matches a known failure.
- **`git update-index --assume-unchanged` hides a modification from `git status`, so no dirty check can see it.** Probed: such an edit was destroyed. Git's own documentation disclaims this state, and Phase 10's restore-before-revert reorder removes the `reset --hard` that reaches it in the common case, so what is left is the operator-started-on-the-feature-branch case. `skip-worktree` survived the same probe. Accepted residual.
- ~~**Two Phase 11 paths were reported as unverifiable.**~~ **BOTH CLOSED by the Phase 11 review**, which found ways to reach them on real git, and both are now committed cases in `test/integration/feature-close.test.ts`. A **tag that git itself refuses after the merge has landed** is reachable by planting a non-empty directory where the tag's loose ref would be written; the designed behaviour held exactly (`feature_tag_failed`, escalation, base moved, no tag, both SHAs in the detail) and a second approval completed the close without moving the base branch again — so the recovery claim is no longer mock-only. A genuine **`git checkout <base>` refusal** is reachable by giving the base branch a tracked file while the operator sits on an older branch holding an untracked copy of that path; escalation, base unchanged, the operator's bytes intact, no tag. Recorded here because the original report listed both as limitations, and a limitation that has since been closed should not keep warning people off.
- **Three Phase 10 paths are untested and deliberately so.** The `refused` outcome for a real `git checkout` refusal is proven only against a simulated raise in the unit fixture; the reviewer reproduced the real refusal but the fix consumes whatever message is raised, so the end-to-end path is unexercised. The base-branch guard is unit-tested only — no test puts `feature_branch: main` in a real vault note and drives the loop. And the empty-conflict-list detail text has no test at all, because reaching that string means driving the untracked-overwrite refusal through the whole loop; judged not worth it, recorded instead.
- **The `HOOK_CAPABLE` set in `test/unit/git/hooks.test.ts` covers subcommands `ShellGit` does not use** (`push`, `rebase`, `stash`, `cherry-pick`, `switch`). Those entries are untested by construction — nothing calls them — so they are drift protection for future methods, not a claim about present behaviour.
- **`assertStandardSandboxPath` catches the two syntax mistakes we know about**, `//abs` and `Tool(...)` form, but cannot catch a bare relative path where an absolute was meant, `~user` forms, trailing slashes, or symlinked paths. The real-CLI probe is the backstop. Accepted residual risk, documented in the module.
- **`prompts/tl_plan.md` asserts that the TL's `notes_markdown` becomes `tech-plan.md`.** That is a Phase 7 orchestrator contract invented inside a prompt — spec §5 and §6.2 never say where `tech-plan.md` comes from. **Phase 7a must either honour it or change the prompt**, because if 7a writes `tech-plan.md` from something else, the TL has been told to put the plan in a field nobody reads.
- **A squeezed retry may not know why it bounced.** `buildContext`'s truncation drops `## QA Notes` then `## Review Notes` before it drops `project.md`, so a context over `context_warn_chars` sacrifices exactly the bounce notes the retry exists to act on. The drop *is* recorded in the returned report. **Phase 9 should treat a dropped retry-note as escalate-worthy rather than merely logging it** — a retry that cannot see its own failure reason is a burned attempt.
- **`tech_doc_updates` on the `tl_plan` schema is ambiguous and has no consumer.** Two competent agents would return different things — filenames, or full updated contents — and nothing downstream is defined to read it. Settle its meaning or drop the field before anything depends on it.
- **`code_reviewer.md` and `qa.md` omit the "never edit `## Raw Requirement`" rule** that the phase's own text says every prompt states. Defensible, since both roles are told they cannot reach the vault at all, but it is a deviation from the plan and is recorded here rather than silently accepted.
- ~~**`test/integration/runner-stub.test.ts` has a wall-clock flake.**~~ **FIXED** after Phase 7a, once the orchestrator saw it fire for real (one failure in three consecutive suite runs). Both pid-file reads now poll until the JSON parses, with a deadline. No assertion changed — the diff removes exactly the two racing `JSON.parse(readFileSync(...))` calls and nothing else. Honest limit: an intermittent failure cannot be proven absent, only its mechanism removed; three consecutive runs are green where one in three previously was not. Original description follows.
- *(historical)* **The flake was:** The abort case aborts after a fixed 300 ms and then immediately reads a pid file the stub `claude` writes after node startup and a grandchild spawn; under a loaded suite the read can land in the open-truncate-before-write window and fail with `SyntaxError: Unexpected end of JSON input`. Verified as a **harness race, not an abort-semantics defect** — the failing line runs *after* the `failure === 'aborted'` assertion has already passed. Fix by polling for the file with a deadline. Left alone for now because a flake this well understood is safer than an unreviewed edit to Phase 5's runner tests, but it must be fixed before anyone can trust a red suite here.
- **A narrow lost-update window on `approve`/`reject`.** Those actions write without taking an item claim, so a startup `forceReleaseClaim` could in principle race a concurrent human approval. Reasoning only — never demonstrated with a test — and it needs two hosts to matter, which M1–M3's single-instance guarantee forbids. Revisit with M4's parallelism.

  **Widened by Phase 11, and now about git rather than only about notes.** `factory approve` is the first action that touches git at all: it checks the base branch out in the operator's own checkout, merges and tags. A running orchestrator may be doing the same thing for a *different* feature's ticket merge at that moment — `mergeNoFf` also checks out and leaves the repo on its target — and there is **no cross-process lock** between the two. The instance lock stops a second orchestrator; it says nothing about the CLI. M1–M3 has no `max_active_features`, so two features in flight is reachable rather than hypothetical. Flagged by the review as uncertain and **not probed** by it or by this phase, so the failure mode is reasoned only: two interleaved `git checkout`es in one working tree, with each side's restore putting the checkout back to what *it* remembers. Worth closing before this runs against a repo that matters; the natural fix is for `approve` to take the instance lock, or a repo-level lock file both paths respect.
- **An agent that *modifies* a pre-existing ignored file is invisible to every check.** The commit snapshot, the ignored-artefact prune, and the post-commit clean check all miss it, so if a Developer patches something inside `node_modules` to make its tests pass, the gates verify the patched dependencies and report green. This is exactly the "make the tests pass by editing the deps" move, and it is the one shape of it the orchestrator cannot see. Phase 10's post-merge gates catch it on the feature branch, because that merge does not carry the patch — so it fails late and confusingly rather than silently. Worth closing properly if this ever runs against a repo that matters.
- **`DEFAULT_GATE_TIMEOUT_MS` is a constant, not a config key**, because spec §11's key set is closed and `config.yml` rejects unknown keys. A target repo whose test suite runs longer than ten minutes will bounce three times and park at `needs_human`. The reason is legible in the gate log ("timed out"), but an operator cannot raise the limit without a code change.
- ~~**The `StructuredOutput` call-count early warning still lives only in a skipped paid test.**~~ **CLOSED** before Phase 12, after slipping Phases 9, 10 and 11. `AgentRunResult.structuredOutputCalls` is required, not optional, and is computed into `interpretRun`'s `base` so it survives all six exit paths — including `is_error: true`, which is the one that matters, since that is how an exhausted delivery arrives. It reaches `run_finished`, and `warnIfDeliveryRetried` in `dispatch.ts` emits a warn-only `delivery_retried` event when the count exceeds 1, modelled on the existing `payload_large` warning: no refusal, no effect on the ticket. **Verified against the 20 preserved Phase 7b transcripts in `.factory-test-repos/pipeline-real-logs{,-batchA}/`**, which settled the assumption the ledger had been resting on: a retried delivery really is a separate streamed `tool_use` block, each with its own id and its own rejected `tool_result`. The production rule and `pipeline-real.test.ts`'s `payloadSizes()` agree on all 20. **The cap is 5**, stated by the CLI itself in the terminal event's `errors[0]`: "Failed to provide valid structured output after 5 attempts". 9 of the 20 runs needed more than one call, and one `dl` run succeeded on its fifth and final permitted try — the exact near-miss this warning exists to surface, and which nothing would have reported before.
- **The target repo must gitignore `node_modules` (or whatever `setup_command` installs).** Reconciliation decides whether a worktree holds uncommitted work with `git status --porcelain`, so a target repo that does not ignore its install output reads **every** provisioned worktree as dirty, retains all of them forever, and leaks worktrees silently. It fails toward retention, which is the safe direction — nothing is destroyed — but the disk fills and `git worktree list` grows without bound. This is an operator requirement the README must state.
- **`config.setup_command` is a deliberate trust boundary.** It runs **unsandboxed, with network, as the orchestrator**, in a directory built from the target repo, and `npm ci` executes whatever install hooks that dependency tree carries. That is the design (resolution A3) — a sandboxed agent has no network, so someone must install dependencies before the agent starts, and it cannot be the agent. What *is* fenced is the blast radius: a deadline, captured and capped output, and a failure that removes the worktree and marks the ticket `needs_human` rather than handing an agent a broken tree. The operator's real protection is that they chose `target_repo` themselves.
- **Latent, `stripForCli`:** the recursive `$schema` strip deletes any key with that name, including inside a `properties` map. A role field literally named `$schema` would lose its definition while remaining in `required`, producing a schema no payload can satisfy. No schema has such a field today.
- **A colliding feature-close tag needs a hand edit to get past, and there is no automatic resume.** `closeFeature` refuses when `factory/<slug>/<ISO date>` already exists, for the reasons in its header — the tag is never moved and never suffixed. The narrow case that costs an operator real work is a close that merged, tagged, and then failed to write the note: approving again hits the collision, and the fix is to set `tag` and `status: done` on the feature note by hand. The refusal message says so and distinguishes that case ("it already points at the tip of `<base>`") from a foreign tag, but nothing automates it. Deliberate: the alternative is a machine guessing about a delivery record, and the window is one atomic note write wide.
- **`mergeCommitOf` couples the approval summary to a history *string* written by `runMerge`.** The merge writes `merged <sha8> into <branch>` as the history note of the `merge → done` line, and `featureClose.ts` parses the SHA back out of it because the ticket branch is gone by then and `TicketFrontmatter` has no field for the commit. Reword that note and the summary silently degrades to "merge commit not recorded" — it fails visibly rather than lying, and the integration suite catches a total break, but a *changed* SHA format would not go red. The proper fix is a frontmatter field on the ticket, which is a note-schema change and `FRONTMATTER_ORDER` compile-time change nobody needed for this phase.
- ~~**The base branch is never verified as green *before* the feature merges into it.**~~ **CLOSED.** Requirements §16's "a deliberately red base branch blocks merge" is now satisfied and pinned by test. The gate asks *"has the tree that will land been gated?"* rather than *"is the base green?"*, which is what makes it cheap: when the base tip is already an ancestor of the verified feature commit, `git merge --no-ff` produces that commit's tree and the feature gates already passed it, so **nothing extra runs**. A second gate run happens only when the base has genuinely diverged. That equivalence was proven on real git across eight cases — including exec-bit and symlink changes, `merge.ff=only`, and `merge.renormalize` with CRLF — not reasoned. Enforced at three points: `verifyBaseBranch` (dispatcher side, the only place that can run gates), `baseIsCovered` inside `closeFeature` (the last-moment lock before `mergeNoFf`, covering **both** close paths because both funnel through that one function), and `staleBaseVerdict` in `actions.ts`. A base that cannot be judged is never assumed green.
- **The human's approval is now bound to the feature commit, not to a moment in time.** *(Behaviour change, decided by the human mid-round.)* As first built, any commit landing on the base branch between the checkpoint and `factory approve` — even a green one — forced a second approval, up to three invocations. On a busy shared trunk a person could lose that race indefinitely. The approval summary never shows the base SHA: the human is judging `verified_sha`. So `approve` now records `approved_sha`/`approved_note`/`approved_tag` and defers; the loop re-gates the moved base and closes on that standing approval. A person is asked again only when the **feature** commit changes. Normal case is one `approve`; a genuinely red base costs two, and the second is "I fixed the base", not a re-approval — pinned by a `checkpoint final_acceptance` history count that stays at 1. The safety property is unchanged and was attacked directly: `approved_sha` has exactly one non-null writer, `recordStandingApproval`, reachable only from `factory approve`; forcing the standing approval always-on turns 7 unit tests red. **This guarantee now rests jointly on the transition table and on that single writer** — a second writer added later would break it without touching `transitions.ts`.
- **A hand-edited ticket note can put agent work straight onto the base branch, bypassing the feature close entirely — reproduced on real git.** `provisionWorktree` (`src/git/worktree.ts:133`) takes `branch` unchecked from the ticket's frontmatter via `workspace.ts:261` and `reconcile.ts:294`. A ticket with `branch: main` gets a worktree checked out on the base branch, and the orchestrator's `commit()` lands the agent's work there before `mergeTicket`'s guard ever runs. Probed: base moved from `eb118233` to `06270cc3` carrying "feat: agent work", with `closeFeature` never involved. **The only thing preventing it today is where the operator's checkout happens to be** — git's own "already checked out" refusal, which the negative control confirmed (exit 128). Nothing in `worktree.ts`, `workspace.ts`, `reconcile.ts` or `commit.ts` guards it. This is a real breach of Section E item 8, it predates the base-branch gate, and it was found only because that unit's review was asked to enumerate every path to the base branch. **Not fixed** — the fix (refuse `branch === config.base_branch`, and the feature branch too, inside `provisionWorktree`) gets its own commit.
- **Nothing gates the *merged* tree.** The base branch is judged alone and the feature branch is judged alone, so a semantic conflict that breaks neither side by itself would still land. Correctly deferred for M1–M3, but the stronger design costs the same single gate run and should be the M4+ shape: when the base has diverged, do a trial `--no-ff` merge in the throwaway worktree, gate *that* tree, and record its tree hash; at close time assert the real merge produced the same tree. Merge tree hashes were proven deterministic across three separate worktrees. That also makes the ancestor shortcut a special case of tree equality rather than a separate rule, and it finds conflicts before a human is asked to approve.
- **`test/integration/runner-stub.test.ts`'s abort case is a load-dependent flake, and the recorded diagnosis is unconfirmed.** It failed twice under heavy load during Phase 11 and passed in four consecutive runs afterwards; the reviewer then ran the file **fourteen times, eight of them under real-git load, and got 12 of 12 every time**. Neither the orchestrator nor the reviewer captured the failure text, so nothing has actually been diagnosed.

  **The 300 ms abort timer is the wrong suspect.** Both `readPids` and `waitForDeath` in that file carry **five-second deadlines**, which matches the duration of the failures observed and the 300 ms timer does not. Treat those two deadlines as the likelier cause and the old "wall-clock dependence of the abort timer" reading as a guess that was never checked. **Nothing about this test changed in Phase 11** — it is not this phase's flake — but Phase 11 adds roughly 65 seconds of real-git work to the suite, so the load it runs under did change. Whoever fixes it should capture the failure output first rather than trusting either diagnosis.

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
| CLI pin repair | `fa04fc5` | **1102 / 11 / 53 as measured, which is not this commit's own figure** — Phase 10's files were already sitting uncommitted in the tree when the suite was run, so 31 of those tests belong to Phase 10 and two to its `commit.test.ts` additions. The repair itself adds no tests; the last clean standalone figure is Phase 9's 1069 / 11 / 51. Caught by the Phase 10 reviewer. All three real-CLI files green under `FACTORY_REAL_CLI=1`. | typecheck 0, lint 0, test 0 | n/a — orchestrator repair, no agent involved | **The fence holds on CLI 2.1.258.** The tripwire fired on a CLI upgrade from 2.1.220, so all three paid probes were re-run before the pin moved: seven-of-seven escapes still `EPERM` in **both** arenas, own worktree still writable, `git status`/`git diff` still exit 0, `git add` still exit 128, and the Developer still leaves a dirty tree with the orchestrator's commit the only one on the branch. Re-probe cost ~$0.38. Two defects fixed while there: the probe log lines printed `PROBED_CLI_VERSION` rather than the version they actually ran against, so a stale pin would have produced evidence logs vouching for a version never tested; and the constant existed in **three** copies, where bumping the file you happen to be reading leaves two unverified claims asserting green. Now one constant in `test/helpers/cliVersion.ts`, whose header states the re-probe procedure. **Still no CI**, so this remains a manual tripwire that only fires when someone runs the suite. |
| 10 | `9f797eb` | 1145 / 11 / 54 (`npm test`) | typecheck 0, lint 0, test 0 | **STOP, then PROCEED after fixes** — the reviewer probed the destructive path against real git in twenty porcelain states and found the predicate itself correct, then found the hazard was **timing, not the predicate**. It also found a sandbox escape the project had already closed once. | **Two blockers, both reproduced on real git and both fixed.** (1) **The hook escape reopened one command over.** Phase 9 fenced `commit` with `core.hooksPath=/dev/null` and wrote a long comment on why; Phase 10's `mergeNoFf` was added later and ran plain git, so a probe watched four agent-authored hook scripts execute in the operator's checkout as the orchestrator. Closing it exposed that the whole *class* was open — `worktree add` fires `post-checkout` and every ref move fires `reference-transaction` — which matters more than the merge did, because **`worktree add` is the most frequently executed git command in the factory** (once per ticket, again per post-merge gate run) and the chain needs no agent to commit anything: the orchestrator commits agent work to the ticket branch, the merge lands it on the feature branch, and the next ticket's worktree is cut from a branch now carrying the script. Fixed as a class with one shared config helper and pinned by `test/unit/git/hooks.test.ts`, which asserts an **invariant over recorded argv** and fails on any `ShellGit` method that is neither classified as a writer nor as a read — so a method added later cannot join the gap silently. `worktree remove`/`prune` are fenced on reasoning only; no hook was observed for either on git 2.39.5, and the agent declined to claim evidence it did not have. (2) **The pre-merge dirty check left a window as long as the target repo's test suite.** `git reset --hard` runs in the operator's own checkout; the check ran once, before the merge, and the post-merge gates run in between. A human edit made inside that window was destroyed in a probe, and an edit to a file the merge brought in was deleted outright. Closed twice over: the checkout is restored to its starting branch **before** any revert, so `git branch --force` succeeds and no working tree is touched at all; and `resetBranch` re-checks at the last possible moment and **raises instead of resetting**, which surfaces as `merge_revert_failed` and a pause telling a human to move the branch by hand. That direction is deliberate — an unwanted commit on a branch is recoverable, an overwritten edit is not. Four should-fixes also landed: an uncaught `GitCommandError` from the checkout step retried every cycle with no pause and no attempt charged, forever, unattended; nothing stopped a hand-edited vault note (`feature_branch: main`) from making the merge write and rewind the **base branch**, breaching Section E item 8 with Phase 11 not yet written; merge commits carried the operator's own name and email, breaking the visible half of resolution A6; and the unit fixture used a **staged** porcelain code (`M `) where the realistic human state is unstaged (` M`), so the reviewer's mutation of the predicate passed all 20 unit tests and only the integration case caught it. **Both blocker fixes were re-mutated by the orchestrator independently**, not accepted on report: stripping the hook fence fails 19 tests including three real-git ones, and disabling the last-moment reset refusal fails the gate-window test. Every claim in this row traces to a command run in the main conversation. Carried forward: `dispatch.ts` is now **2428 lines** and the reviewer says **split it before Phase 11**, not after, since Phase 11 adds `featureClose` and `actions.ts` wiring that will want `pauseAtMerge`-style helpers — leaving it means splitting fresh code twice. Phase 7b's `StructuredOutput` call count has now slipped **twice** (9, then 10) and must land as its own commit **before** the Phase 12 run, or that run's evidence lacks the signal it was built to carry. ~~`tag` is safe today only because it makes a *lightweight* tag — Phase 11 must not switch to `-a`/`-s` without adding `-c tag.gpgsign=false`, or a signing repo hangs a headless run.~~ **WRONG ON BOTH COUNTS, corrected in Phase 11.** Lightweight is not what made it safe, and nothing hangs. `tag.gpgsign=true` promotes a bare `git tag <name> <ref>` into a *signed* tag, which then has no message and exits 128 with `fatal: no tag message?` — probed on git 2.39.5. So a target repo that signs its tags broke the feature close outright, with no `-a`/`-s` anywhere and an error naming a message nobody asked to write. `tag.gpgsign=false` is now in the shared `orchestratorGitConfig`. See the debts section for the `assume-unchanged` residual and three untested paths. |
| `dispatch.ts` split | `d2e1fd5` | 1155 / 11 / 54 (`npm test`) | typecheck 0, lint 0, test 0, build 0 | n/a — pure-move refactor, no behaviour change, orchestrator-verified | **Not a phase.** The plan has said since Phase 7a that this file should split; Phase 10's reviewer made it *before Phase 11*, since Phase 11 adds feature-close and `actions.ts` wiring that would otherwise be split twice. `dispatch.ts` **2439 → 1250 lines**, into `roleEffects.ts` (619), `attemptPolicy.ts` (289), `dispatchTypes.ts` (210), `noteWrites.ts` (111) and `workspaces.ts` (75). **Proven a pure move mechanically, in both directions**: 26 regions diffed against `git show HEAD:...` with a leading `export ` normalised away, all byte-identical; then a coverage check confirming no HEAD line is claimed twice and every unclaimed line is blank. The only hand-authored code is six header/import blocks. The orchestrator independently re-diffed the largest region (218 lines) and confirmed all three test-file diffs are import-only. **The suite went 1145 → 1155, and that is not a pure move violating itself.** `test/unit/orchestrator/headings.test.ts` enumerates `src/orchestrator/*.ts` with `readdirSync` at load time and runs two `it.each` blocks over it, so five new modules add ten parameterised cases. Independently verified: 16 files now, two blocks, +10. No test file gained an `it`; skips and file count unchanged. **The split removed two pre-existing import cycles** rather than adding any — `git/workspace.ts` and `merge.ts` now take their types from `dispatchTypes.ts`, which imports neither. Checked under both edge definitions (type imports erased by `verbatimModuleSyntax`, so value-only edges were graphed separately), on the emitted JS, and by loading the built entrypoint plus each new module standalone. **Nothing enforces this** — there is no `import/no-cycle` lint rule, so a future edit can reintroduce one. Two judgement calls worth knowing: a **fifth module was needed** beyond the three the plan named, because `attemptPolicy` calls the note-write helpers while `dispatch` calls `attemptPolicy` — a types module cannot break a cycle made of function calls, so the write layer had to sit below both. And `refuseEffect` stayed in `dispatch.ts` despite sitting inside the moved region: it is a persistence function called only by code that stayed. Two stale comments fixed by the orchestrator, one of which claimed merges were "dispatched by nothing yet". |
| 11 | `fa667d1` | 1263 / 11 / 56 (`npm test`) | typecheck 0, lint 0, test 0, build 0 | **PROCEED WITH FIXES** — the reviewer enumerated every caller itself and answered the question the phase exists to answer: with `final_acceptance` enabled there is **no path** by which the base branch is written, or a feature reaches `done`, without a human `approve`. Held under 17 of its own mutations and 6 real-git probes. It then found the approval could be given against **stale evidence**, plus two tests that vouched for nothing. | **M3 is complete.** `featureClose.ts` is the feature-level twin of `merge.ts`: gates on `feature/<slug>` in a throwaway worktree, the `final_acceptance` checkpoint, then `git merge --no-ff` into `config.base_branch` and the tag. It does **not** route through `mergeTicket`, and `merge.ts` is byte-identical to HEAD, so Phase 10's `forbiddenBranch` guard is intact. **The phase found `awaiting_feature_close` was not actionable anywhere** — no role owned it, so a feature that got there was permanently terminal. Every earlier test of that state passed by accident of nothing acting on it. **The guard gap was wider than the plan's own note.** `awaiting_feature_close → done` had no guard, *and* so did `needs_human → done`, which is the route `factory approve` actually takes. Guarding only the first would have left the reachable one open. Both now carry `featureCloseVerified` (`baseMergeClean` + `featureTag`), `ctx.x !== true` so absent refuses. **The checkpoint does not rest on that guard, and this is the subtle part.** Once a close has merged and tagged, the guard is satisfied by construction. What holds the checkpoint is **ordering**: the config switch is read and the pause taken *before* any git write, so the guard's facts are never produced for a feature that should be waiting on a person. A second lock inside `mergeAndFinish` closes the route a future caller would open. `needs_human → done` stays **human-only** — the orchestrator must never be added, or it resolves its own approval. **The actor list on `awaiting_feature_close → done` was widened to include the orchestrator** — a human decision, escalated. An auto-close (`final_acceptance: false`) previously recorded `human` in the history when nobody looked; the actor field is the machine-readable one and a later query would trust it. **A failed base merge reverts nothing, deliberately.** The factory owns a feature branch outright, but nobody owns the base branch except humans, so a reset to a remembered SHA can drop a colleague's commit — unrecoverable in a way a feature-branch rewind is not. The only post-merge failure is a failed tag, answered by leave-it-and-escalate; re-approving is safe because `--no-ff` of an already-merged branch reports success and goes straight to the tag. **A colliding tag refuses before the base branch is touched** — never moved, never suffixed. Moving it erases the record of a delivery that already happened. **Three human-approved assertion edits**, each confirmed by the reviewer to preserve its original claim and assert more: a status proxy replaced by a history check (the state stopped being terminal), a satisfied guard context added to a reachability check, and `rule.actors` split per route. Fixed after review: **the gate verdict went stale between the checkpoint and the approval** — reproduced on real git, a failing commit added to the feature branch after the checkpoint reached `done`, became an ancestor of base and got tagged. Now `verified_sha` frontmatter records what the gates saw and the approval **refuses** if the tip moved. Also fixed: a restore-the-checkout test that started on the base branch and so exercised nothing (a no-op restore left it green); the second lock was unreachable and untested, now exported and driven directly; a `feature_close_refused` event emitted after a *successful* merge while its own doc said nothing was attempted; a `mergeCommitOf` decoy that only pinned one of two conditions; and feature `attempts` never incrementing, so a re-verification overwrote the earlier run's gate logs. **`tag.gpgsign` — the Phase 10 comment was wrong twice and it broke this phase.** It claimed the setting applies only to annotated tags and would *hang*. Reproduced independently on git 2.39.5: `tag.gpgsign=true` promotes a bare `git tag <name> <ref>` into a signed tag, which then fails **exit 128, `fatal: no tag message?`**. `tag.gpgsign=false` is now in the shared `orchestratorGitConfig`; spec §10 and the Phase 10 row corrected. Two gaps previously declared unverifiable are now **proven on real git**: a tag failing after a successful merge escalates with both SHAs named and a second approve completes it; and a genuinely refused `git checkout <base>` leaves the base unchanged, nothing tagged, and the operator's bytes intact. Carried forward — **Phase 12 must ADD a pre-merge base-branch gate, not discover one.** Nothing gates the base branch, so requirements §16's "a deliberately red base branch blocks merge" is **not** satisfied; confirmed by probe (red base commit becomes an ancestor, feature `done`, tagged). Phase 7b's `StructuredOutput` call count has now slipped **three** times (9, 10, 11) and must land as its own commit **before** the Phase 12 run, or that run's evidence lacks the signal it was built to carry. Three nits are open and unverified: the approval summary and the tag each read their own clock so a close spanning midnight may name a tag it does not create (plausible, **undemonstrated**); a failed approval writes no `## History` line; and one unit assertion is tautological, its integration counterpart sound. See the debts section for the approve-races-the-orchestrator hazard and the flake diagnosis correction. |
| CLI pin repair (2.1.276) | `21afcb0` | 1263 / 11 / 56 (`npm test`) — unchanged; this repair adds no tests, and the figure is Phase 11's own, re-measured on a clean tree before the commit | typecheck 0, lint 0, test 0, build 0 | n/a — orchestrator-run repair, no build agent and no reviewer. The evidence is the probe output itself, quoted in the session log below. | **Not a phase.** The always-on tripwire fired on a CLI upgrade from 2.1.258 to 2.1.276 — the second fire in two sessions, which makes this a recurring cost rather than an incident. All three paid probes were re-run **before** the pin moved, per the procedure in `test/helpers/cliVersion.ts`: seven of seven escapes still `EPERM` in both arenas (hand-built and real-`provisionWorktree`), `git add` still refused at exit 128 by the object-store fence rather than by `~/.gitconfig`, `git status`/`git diff` still exit 0, `--tools ""` still granting only `StructuredOutput` at both init and use, and the Developer still leaving a dirty tree with the orchestrator's commit the only one on the branch. The negative control still detects a fully unfenced world, so the probe has not quietly lost its ability to tell the two apart. **$0.276** across four real runs. Still **no CI**, so nothing re-runs any of this automatically — the tripwire remains the only thing that notices, and it only notices after the upgrade has already happened. |
| CI (unplanned) | `5d23d7d` | 1275 / 11 / 57 (`npm test`) — +12 on Phase 11's 1263 / 11 / 56, skips unchanged and verified identical **by name**, not by count | typecheck 0, lint 0, test 0, build 0 | **PROCEED WITH FIXES** — the reviewer ran 11 mutations of its own and found four cases where the contract test passed and should not have, including `pull_request_target` on the job that holds `ANTHROPIC_API_KEY`. All six fixes landed and the orchestrator re-mutated the three security-critical ones itself rather than accepting them on report. | **Not a phase.** Closes half of the oldest debt: `ci.yml` (per-push, free) and `sandbox-fence.yml` (weekly + dispatch, paid probes) plus `test/unit/ci/workflow-contract.test.ts`, which evaluates the real `RUN_REAL_*` expressions against each step's reconstructed environment instead of grepping YAML. **Neither workflow has ever run — there is no git remote.** Two findings came out of the work and are recorded as debts above: the whole suite is macOS-only, not just the sandbox guarantee; and `src/git/exec.ts` kills the shell but not the command under it, so on Linux a hung gate never settles its promise and hangs the factory indefinitely. The second is a real product defect, found by CI work rather than by any test. |
| `StructuredOutput` call count | `05f2046` | 1296 / 11 / 57 (`npm test`) — +21 on the CI row's 1275, skips unchanged and verified identical **by name** | typecheck 0, lint 0, test 0, build 0 | **PROCEED WITH FIXES**, then a second correction from the orchestrator. The reviewer confirmed the design by mutation and found three defects the suite could not catch, all of the still-green-for-the-wrong-reason kind: a shared stub double-delivering so every healthy run in `runner-stub.test.ts` silently became a retried one; the mock reporting 1 delivery where the real runner reports 0 on an interrupted run, held shut by a hardcoded fixture value; and `retried_delivery` calibrated to 3 calls when reality is always 5. It also found the field had **no consumer**, so the debt was relocated rather than closed. | **Closes the call-count debt** (see above) and adds the `delivery_retried` event. **One error worth recording:** the implementer reported that the real terminal event carries no `terminal_reason`, dropped it from the stub, and described the fixture as transcribed from the recording. It does carry it, in both recorded failures, as `structured_output_retry_exhausted` — the field had fallen off the end of a truncated dump, and an absence was reported that was never tested for. Caught by the orchestrator checking the transcript directly; it had already propagated into six assertions and put them in direct contradiction with `pipeline-real.test.ts`, which was right all along and is byte-untouched. **A fixture whose comment claims it was transcribed, and was not, is worse than an admittedly synthetic one** — every later reader trusts it. Both the mock-divergence fix and the warn placement were re-mutated by the orchestrator rather than accepted on report. |
| Pre-merge base gate + standing approval | `642aa56` | 1336 / 11 / 57 (`npm test`) — +40 on the call-count row's 1296, skips unchanged and verified identical **by name** | typecheck 0, lint 0, test 0, build 0 | **PROCEED WITH FIXES** twice, across two reviews and three orchestrator fix rounds. Review 1 proved the ancestor shortcut on real git across eight cases and ruled the fixture changes sound. Review 2 traced every writer of `approved_sha` and found no route to `done` without a human. **Both reviewers ran out of room mid-verification and said so precisely; the orchestrator ran the unfinished mutations itself** — eight in total, every one fired, every file restored byte-identical. | Closes the §16 base-branch debt and changes the approval flow on the human's decision (both above). **The most important finding is a lesson this project has now learned three times:** the standing approval reopened the stale-check window, because the commit that merges is read *after* the gate run, not the one the approval named. Phase 10 hit it, Phase 11 hit it with `verified_sha`, and this is the third — now closed at the last statement before `mergeNoFf`, on **both** close paths, and proven by a test that lands a commit *during* the gate run. Two smaller truth-in-record fixes: the transition table carried three statements this change made false, and the tag could be dated differently from the one the approval summary promised — the same defect Phase 11 note 6 fixed once already. **One pre-existing assertion was reworded**, on the orchestrator's ruling: it pinned the phrase `by hand` in a message that told operators to edit a note, which decision A8 forbids; it now pins the actual recovery commands, which is strictly narrower. |
| 12 | `PENDING` | 1347 / 12 / 58 (`npm test`) — +11 on the base-gate row's 1336; the 12th skip is the new paid acceptance case, named and accounted for | typecheck 0, lint 0, test 0, build 0 | n/a — orchestrator-run phase. The verdict is the paid run itself, recorded in `docs/features/factory-m1-m3-acceptance.md`. | **PASS on the second paid run.** One real feature went `intake → done` on the toy repo with exactly three approvals and no manual file edits, merged to base and tagged `factory/calculator/2026-09-22`: 4 tickets (three independent roots, one dependent), all done on first attempt, 0 escalations, $3.1225, 21 min, 16 runs / 15 ok. **Run 1 failed and was worth more.** Twelve runs, two tickets done, the third parked by QA — not a code defect: 9 of 12 acceptance criteria invoked a `.ts` file bare, which fails at Node's ESM loader before any feature code runs. `fixtures/toy-app/CLAUDE.md` said Node does type stripping but never that it needs `--experimental-strip-types`, and every gate script carried the flag so the gap was invisible. QA verified all 9 cases, confirmed the 48-test suite passed with the right flags, and **refused to bounce it to the developer** — Section E item 4 cutting the right way. Fixed in two kinds: the repo's own `CLAUDE.md`, and a generalisable `prompts/pm.md` rule (take the invocation from the repo, never from habit) whose own example row had been teaching the trap. No Node flag was hard-coded into the factory. **Three things built this session proved themselves live:** `delivery_retried` fired 6 times including a `dl` run that exhausted all five delivery attempts; the orchestrator handled that exhaustion exactly as Phase 7b designed (one attempt charged, retried, succeeded — the 15-of-16); and the `depends_on` fix held on every ticket in both runs. Phase 12 spend $6.30. |


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

---

## Session log — 2026-09-02

### 1. Phases completed this session

Six phases plus two standalone repairs. **M1, M2 and the M3 dev loop are complete.** Tests went 418 → 1069 passing (11 skipped, 51 files); typecheck and lint clean at every commit.

- **NUL byte repair** (`1a2ea41`) — `src/domain/dag.ts` held a literal NUL control character, so git classified it as binary and refused to diff it. Every future change to the DAG resolver would have gone through review unseen.
- **Phase 4 — config, resolution, `factory init`** (`1f84372`), completing M1. Config schema, `loadConfig`, the project registry, the five-step vault resolution, startup validation, `vault-template/`, and the `init`/`projects`/`status` commands.
- **Phase 5 — runner, sandbox fence, run logging** (`647956c`). The `Runner` seam with `ClaudeCodeRunner` and `MockRunner`, the transcript, the event log, the `.runs` registry — and the sandbox settings builder, proved at the kernel by a real-CLI blast-radius probe.
- **Phase 6 — agent layer** (`9589adb`). Six role profiles, six zod schemas with JSON Schema conversion, context recipes, and the six system prompts.
- **Phase 7a — orchestrator loop** (`11c7037`). Instance lock, item claim with a real disk read-back, malformed-note quarantine, the spec §9 cycle, dispatch for the three M2 roles, the three human checkpoints, `approve`/`reject`/`kill`, six CLI commands, and `NEEDS_HUMAN.md`.
- **Stub-runner flake repair** (`dbeafe2`) — two pid-file reads raced the stub's write. Fixed once it fired for real, one run in three.
- **Phase 8 — git worktrees** (`3b40d88`), **reordered ahead of 7b**. `Git`, provisioning with `setup_command`, reconciliation, throwaway worktrees, and the `WorkspaceProvider` that lifts Phase 7a's refusal.
- **Phase 7b — real agents and prompts** (`b8b130b`), completing M2. The schema-retry policy in `attempts.ts`, and the three M2 prompts revised against fourteen real runs.
- **Phase 9 — gates and the dev loop** (`1952b9e`). `GateRunner`, `commit.ts`, the `in_progress → gates → code_review → qa` handlers, gate failures in `attempts.ts`, and retry context injection.

### 2. Files created or modified

Rather than restate the tree, the per-phase file lists live in each phase's commit message, and every commit is listed above. The **shared files touched by more than one phase**, which is what a later phase needs to know about:

- `src/orchestrator/dispatch.ts` — created in 7a, extended by 7b (retry loop) and 9 (ticket states, gates, commit, bounce). **~1030 lines before Phase 9 added to it; it should be split at Phase 10 or 11** into role effects, attempt policy, and workspace resolution.
- `src/orchestrator/attempts.ts` — created in 7b, widened in 9. Phase 10 adds merge failures.
- `src/agents/context.ts` — 6, then 7b (`retryGuidance`), then 9 (`PRIOR_GATES`).
- `src/config/schema.ts` — 4, then 8 (`setup_command` was already there), then 7b (`payload_warn_chars`).
- `src/vault/storage.ts` — `SECTION_ORDER` gained `## Notes` in 7a. **Never write a heading literal; ask `SECTION_ORDER` by name.**
- `src/vault/paths.ts` — 4 (root-containment bug fix), 9 (`gateLogPath`).
- `src/git/**` — all Phase 8, extended in 9 (`statusEntries`, `add`, `commit`, `revParse`).
- `src/cli/{deps,start,main}.ts` — 4, 7a, 8, 9.
- `docs/features/factory-m1-m3-technical.md` — corrected in 4, 5, 6, 7b, 8, 9. Every correction is marked inline.

### 3. Deviations from the original plan

All are recorded in the plan or the spec at the point they apply; none is outstanding.

1. **Phase 8 runs before Phase 7b.** Phase 7a's review found `factory start` was reachable on the default path and would run real agents with the operator's **main checkout** as their working directory — and the sandbox fences an agent *to* its working directory. `factory start` now refuses without a `WorkspaceProvider`, which made Phase 8 the critical path. Spec §4.3 always required worktrees for `tl_plan`/`dl`, so 7b always depended on 8; the original order hid that. **Both phase blocks carry a reorder banner.**
2. **Registry moved from `~/.factory/` to `~/.app-factory/`** — the original belongs to Factory.ai's installed CLI. Human decision. Spec §11 updated.
3. **`sandbox_extra_read`/`write` ship empty**, contradicting spec §11's example. Resolution A2 probed it. Spec updated.
4. **`AgentFailure` gained a fifth kind, `'aborted'`** (spec §8.1 deviation, recorded there). Mock and real runner disagreed about an external abort, invisibly, and Phases 7–11 all run on the mock. **Phase 7a decided it does not burn an attempt.**
5. **A first schema-validation failure is forgiven** (spec §9.1 and §5 rule 4 corrected). Per dispatch, not per lifetime, so runs are bounded at 2×.
6. **The worktree root is salted per vault** (spec §10 deviation, recorded there) — the bare vault name collides, and while provisioning failed safe, *destroying* did not.
7. **`git status --porcelain` is never used with `add -A`** — staging diffs against a pre-run snapshot, which turns Phase 8's operator requirement into an orchestrator property.
8. **The DL emits ticket *titles* in `depends_on`, not IDs**, because IDs do not exist until the orchestrator writes the notes. A payload refine enforces in-payload uniqueness, which is what makes resolution possible.
9. **Phase 6's output-size spike is superseded.** It measured the model's 128K ceiling and found a 20× margin — correct and irrelevant. **The binding limit is the CLI's, around 13–14k characters.** Marked superseded in place.
10. **The fixture's `build` gate still does not catch plain type errors.** Phase 1 said "revisit at Phase 9 if it bites". Phase 9 decided it did not, twice reviewed.

### 4. Current state

**Phase 9 is complete and committed (`1952b9e`, ledger `989602f`). The working tree is clean and all gates are green.** Nothing is mid-flight.

The next phase not started is **Phase 10 — ticket merge to the feature branch**, followed by 11 (feature close, base merge, tag) and 12 (the real-agent acceptance run).

Execution settings that carry forward: commits are **pre-authorised** (never push, never a PR); one phase per agent, no batching; each phase gets an Opus build agent then a Fable review, and the orchestrator triages, re-verifies the gates itself, ticks the done conditions, and writes the ledger row — **agents do neither**.

**Real-CLI spend to date is roughly $29**, almost all of it Phase 7b's prompt iteration.

### 5. Watch out for

- **Phase 10 inherits three things by name.** `merge → done` refuses unless `merge.ts` threads `mergeClean` and `featureBranchGatesGreen` into the transition context — deliberate, it fails toward a stuck ticket rather than a bad merge. `attempts.ts` is where merge failures belong. And Phase 7b's request to surface the `StructuredOutput` call count on `AgentRunResult` was **not done by Phase 9** and is now Phase 10's.
- **There is still no CI.** The real-CLI isolation probe is the only proof the sandbox fence works, and it is opt-in with nothing running it automatically. A CLI upgrade can quietly void ADR-003.
- **An agent that *modifies* a pre-existing ignored file is invisible** to the snapshot, the prune and the clean check — so patched dependencies would pass the gates. Phase 10's post-merge gates catch it, late.
- **The six prompts still owe a human end-to-end read.** It is the one Phase 6 condition the orchestrator cannot close. Three specific spots were flagged for that read.
- **Warn-only budgets deserve re-examination.** One PM → TL → DL sequence costs ~$1.00 and a full feature plausibly $5–15; Gate 1 chose warn-only against a $0.022 probe.
- **`dispatch.ts` is very large** and should be split at Phase 10 or 11, not left to Phase 12.
- **Treat a stalled or truncated agent report as a failed phase.** Re-run the gates yourself, diff pre-existing tests for weakened assertions, redo any mutation proof. This session also proved the inverse worth watching: a mutation can pass for an *accidental* reason — Phase 9's agent caught one of its own and redid it.
- **The plan and the spec are the durable state.** Every correction this session is written into them inline. Trust them over any summary, including this one.

### 6. Next action

```
/resume factory-m1-m3

Phases 1-9 are committed and green (1069 tests, all gates 0). M1, M2 and the
M3 dev loop are done. Start Phase 10 — ticket merge to the feature branch.
Note the phase reorder: 8 ran before 7b, and both are complete. Commits are
pre-authorised; never push, never open a PR.
```

---

## Session log — 2026-09-02 (second session)

### 1. What was completed this session

**M3 is complete.** Phases 10 and 11 landed, plus two pieces of work that were not numbered phases. Tests went 1069 → 1263 passing (11 skipped, 56 files); typecheck, lint and build clean at every commit.

- **CLI pin repair** (`fa04fc5`) — the always-on version tripwire fired on a CLI upgrade from 2.1.220 to 2.1.258. All three paid probes were re-run **before** the pin moved: seven of seven escapes still `EPERM` in both arenas, read-only git intact, `git add` still refused, the Developer still leaving a dirty tree. ~$0.38. Two defects fixed while there: the probe logs printed the *pinned* version rather than the one they ran against, and the constant lived in three copies where bumping one leaves two unverified.
- **Phase 10 — ticket merge** (`9f797eb`, ledger `848dd54`). Reviewer returned STOP on two blockers, both reproduced on real git.
- **`dispatch.ts` split** (`d2e1fd5`, ledger `79acd52`) — 2439 → 1250 lines into five modules, proven a pure move mechanically in both directions. Removed two pre-existing import cycles.
- **Phase 11 — final acceptance, base merge, tag** (`fa667d1`), completing M3. Reviewer returned PROCEED WITH FIXES; six findings fixed.

### 2. Current state

**Phase 11 is committed and the working tree is clean.** The only remaining phase is **Phase 12 — the real-agent acceptance run**, which has not started.

Execution settings that carry forward: commits are **pre-authorised** (never push, never a PR); one phase per agent; each phase gets an Opus build agent then a Fable review, and the orchestrator triages, **re-runs the gates itself**, re-mutates the blocker fixes rather than accepting them on report, ticks the done conditions and writes the ledger row — agents do none of that.

**Real-CLI spend to date is roughly $29.40.** Phase 12 will add materially more: one PM → TL → DL sequence is ~$1.00 and a full feature plausibly $5–15.

### 3. Do this before Phase 12 starts

1. **Land the `StructuredOutput` call count on `AgentRunResult`.** Phase 7b asked for it as an early-warning signal on payload mangling. It has now slipped **three** phases (9, 10, 11). If it is not in before the acceptance run, that run's evidence lacks the signal it was built to carry. Its own small commit, not folded into Phase 12.
2. **Expect to ADD a pre-merge base-branch gate.** Nothing gates the base branch today, so requirements §16's "a deliberately red base branch blocks merge" is **not** satisfied — confirmed by probe: a red base commit becomes an ancestor, the feature reaches `done`, and it gets tagged. Phase 12 must build it, not find it.
3. **A human still owes an end-to-end read of the six prompts.** The one Phase 6 condition the orchestrator cannot close, unchanged across three sessions.

### 4. Watch out for

- **The suite has a load-dependent flake and its recorded diagnosis is probably wrong.** `test/integration/runner-stub.test.ts`'s external-abort case failed twice under heavy machine load, then passed four consecutive times once the load cleared, plus fourteen more runs by the reviewer at 12/12. The recorded cause blames a 300 ms timer; the ~5300 ms failure duration fits the two **5-second** deadlines in `readPids`/`waitForDeath` far better. **Nobody has captured the failure text.** Do not fix it without that message.
- **Do not run agents in parallel with a review.** This session dispatched a fix agent while a reviewer was still reading, so it reviewed a moving tree and had to exclude the in-flight work from its judgement. The fix then needed its own verification instead of inheriting the review's. One at a time.
- **Treat a stalled or truncated agent report as a failed phase.** It happened twice this session. Both times the recovery was the same: check the tree for stray probe files and un-restored mutations, run the gates yourself, and extract whatever evidence the agent produced before it stopped. One stalled reviewer had written seven probes and never read their output — running them found the stale-verdict blocker.
- **A probe file that fails as a suite may still be sound case by case.** The stalled reviewer's probes had a state leak between cases, so the whole file went red in its shared setup. Run them individually with `-t` before concluding anything about the code.
- **Two protections now exist because a single check ran too early.** Phase 10's dirty-checkout check and Phase 11's gate verdict were both correct when taken and stale by the time they mattered. Any new check on a destructive path should be re-taken at the last possible moment, not once at the start.
- **`git` runs hooks far more widely than expected.** Creating a worktree fires `post-checkout` and every ref move fires `reference-transaction`. The class is fenced now and pinned by an invariant test that fails on any unclassified `ShellGit` method — but there is still **no CI**, so nothing runs the real-CLI isolation probe automatically.
- **The plan and the spec are the durable state.** Every correction this session is written into them inline, including two of the orchestrator's own errors: a ledger row whose test figures were measured with a later phase's files in the tree, and a claim that a lock was pinned by a test when it was not. Trust the documents over any summary, including this one.

### 5. Next action

```
/resume factory-m1-m3

Phases 1-11 are committed and green (1263 tests, gates clean). M1, M2 and M3
are done. Before starting Phase 12: land the StructuredOutput call count as its
own commit, and expect to ADD a pre-merge base-branch gate. Phase 12 spends
real money on live agents - $5-15 plausible for one feature. Commits are
pre-authorised; never push, never open a PR.
```

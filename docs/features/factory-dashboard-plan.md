# App Factory Dashboard — Phased Implementation Plan

- **Feature ID:** `factory-dashboard`
- **Spec:** `docs/features/factory-dashboard-technical.md`, `docs/features/factory-dashboard-nontechnical.md` (J1–J8)
- **Gate:** 4 (Execute) — in progress via `/run-phases`
- **Phases:** 9
- **Branch:** `feature/factory-dashboard` (to be created from `main` before Phase 1)
- **Revision:** post-devils-advocate (2026-09-24). Five mitigations folded in: timer-driven
  lock heartbeat (A8), block adding a second active feature (A9), runs addressed by `runId`
  (A10), an interruptible loop sleep so actions take effect at once (Phase 4), and form-safe UI
  rendering plus a second-Ctrl-C forced stop (Phases 4, 7, 8).

---

## Section A — Resolved uncertainties

### A1. Are `index.md` / `NEEDS_HUMAN.md` written atomically? — YES
`regenerateViews` (`src/orchestrator/views.ts:50-51`) writes both through `atomicWrite`, and
`MarkdownStorage.writeNote` (`src/vault/storage.ts:103`) does the same for every note. A
dashboard reading while the loop or a CLI `approve` writes never sees a half-written file.
**Effect:** no locking is needed on the read path. The in-process `Mutex` (tech spec §2.6)
only serialises dashboard `POST`s against each other.

### A2. Does `Git` expose commit listing and diffstat? — NO, two methods to add
The `Git` interface (`src/git/git.ts:202`) has `diff(base, head)` (a full patch), `revParse`,
`isAncestor` and `parentsOf`, but nothing that lists commits or gives per-file counts.
`ShellGit` is the only implementation in `src/` and `test/`, so adding methods breaks no fake.
*Corrected during Phase 1 — that was wrong.* Three unit tests (`test/unit/orchestrator/{commit,featureClose,merge}.test.ts`)
define a fake `Git`, and `test/unit/git/hooks.test.ts` requires every `ShellGit` method to be classified. Adding the
methods broke typecheck and that test until `unsupported(...)` stubs and `READS` entries were added. Those were additions
only, with no assertion changed.
**Effect:** Phase 1 adds `logRange(base, head): Promise<{sha, subject}[]>` and
`diffNumstat(base, head): Promise<{file, added, removed}[]>` to the interface and `ShellGit`,
with unit tests against a real toy repo.

### A3. Does lint cover browser JS? — NO, and it would fail without config
`eslint.config.js` applies `js.configs.recommended` to every file, including a future
`dashboard-ui/**/*.js`, but declares no browser globals. `document`, `window`, `EventSource`
and `fetch` would all be `no-undef` errors. The `globals` package isn't a direct dependency.
**Effect:** Phase 7 adds a config block for `dashboard-ui/**/*.js` with a hand-listed browser
global set, the same pattern the file already uses for `test/**/*.mjs`. No new dependency.

### A4. Can vitest unit-test the plain-JS UI modules? — YES, with sibling `.d.ts` files
`tsconfig.json` has no `allowJs` and includes `test/**/*.ts`, so a test that imports
`dashboard-ui/components/markdown.js` fails `npm run typecheck` (TS7016, no declaration).
**Effect:** only the **pure** UI modules get tested (`markdown.js`, `format.js`, `routes.js`,
`store.js`), and each gets a hand-written sibling `.d.ts`. DOM-touching view modules aren't
unit-tested. They're covered by the demo E2E and the manual browser pass (Phase 9).

### A5. Should the demo project be registered in `~/.app-factory/projects.yml`? — NO
`ProjectRegistry` honours `FACTORY_HOME` (`src/config/registry.ts:48`). Registering `demo`
would put it into `factory projects` and make it the answer for bare commands if it became the
registry default.
**Effect:** `factory demo` uses a fixed location, `<factory home>/demo/{repo,vault}`, and passes
the vault path explicitly. It never touches the registry.

### A6. Can static assets and the toy app be found from `dist/`? — YES
`readManifest()` (`src/cli/main.ts`) already resolves `../../package.json` via
`import.meta.url`, identically from `src/cli/` and `dist/cli/`. `dashboard-ui/` and
`fixtures/toy-app/` sit at the same depth relative to the package root.
**Effect:** one helper, `packageRoot()`, is introduced in Phase 3 and reused by the static
server and `factory demo`. It stays valid while the factory runs from the repo (`npm link`),
which is the only supported install. This is recorded as a known limit in ADR-005.

### A7. Which existing tests guard the code Phase 1 refactors?
`runStart`, `runStatus`, `runFeatureAdd` and `buildProgram` are exercised by
`test/integration/{cli-init,pipeline-paper,feature-close,worktree-workspace,acceptance}.test.ts`.
There's no `test/unit/cli/` directory. **Effect:** those five files are Phase 1's regression
net, and Phase 1 adds focused unit tests for the three extracted functions.

### A8. NEW (devils-advocate) — the lock heartbeat goes stale during every agent run
`InstanceLock.heartbeat()` is called in exactly one place, at the top of each cycle
(`src/orchestrator/loop.ts:270`). `evaluateLock` (`src/orchestrator/lock.ts:94`) calls a lock
**stale** once `heartbeatAt` is older than `STALE_HEARTBEAT_MULTIPLIER × poll_interval`
(3 × 15 s = 45 s), **even when the PID is alive**. A cycle containing one agent run lasts
minutes (the real run: developer 182 s, DL 377 s; the cap is `agent_timeout` 1800 s). So for most
of a real run the lock looks reclaimable, and a second `factory start` would take it over
(`lock_reclaimed`) and put two orchestrators on one vault. This is a pre-existing M1–M3 bug, but
the dashboard would put a Start button in front of it.
**Effect:** Phase 1 fixes it at the source: the orchestrator refreshes the heartbeat on a timer
every `poll_interval` for as long as it holds the lock, independent of cycles. The dashboard's
mode detection additionally treats **a live PID as authoritative** for `external` (heartbeat
age is shown, never used to enable Start). It gets its own ledger row, because it changes
M1–M3 behaviour.

### A9. NEW (devils-advocate) — the factory does not limit active features
`actionableItems` (`src/orchestrator/loop.ts:564`) treats every feature in `intake` (and every
feature in an agent-owned stage) as actionable. There's no `max_active_features` until M4. A second
feature added mid-run would be refined, planned and ticketed alongside the first, on a path
no test covers. The J2 copy "this one will wait" was therefore false.
**Effect (decided):** `addFeature` **refuses** with a clear message while any other feature is
not `done`. This applies to both CLI and dashboard, since `addFeature` is the shared core. The J2
edge case becomes a blocked form with the reason. It's lifted in M4. This changes `factory
feature add` behaviour, so it's recorded as a deliberate exception in Section E.

### A10. NEW (devils-advocate) — log files cannot be reliably addressed by name parts
Real transcript names include variants the `{slug, itemId, attempt, role}` tuple can't
express unambiguously: `FEAT-CALCULATOR-T001-merge-1-gate-lint.log`,
`FEAT-CALCULATOR-close-cd17de7e-2-gate-lint.log`. Parsing names back into parts is fragile.
**Effect:** runs are addressed by **`runId`**. The server builds a `runId → {role, itemId,
attempt, logPath, startedAt, finished}` index from `run_started` / `run_finished` events in
`orchestrator.jsonl` (and keeps it live from the bus). Gate logs are addressed by the
`gate_result` event's recorded path. Every resolved path still passes `confine()`. The client
never sends a path or a filename.

---

## Section B — Implementation phases

---

**Phase 1 — Fix the heartbeat, extract the seams**

Goal: Stop the lock going stale during agent runs (A8), then split three CLI functions into
reusable cores the dashboard can call, and add the two git helpers. Apart from the heartbeat fix
and the A9 single-active-feature refusal, no command's output or behaviour changes.

Implementation changes:

- `src/orchestrator/lock.ts` + `src/orchestrator/loop.ts` (**first, own commit and ledger
  row**): `Orchestrator` starts a heartbeat timer (`setInterval` every `poll_interval`
  seconds, `unref()`'d) as soon as it holds the lock, and clears it in `shutdown()` and on lock
  release. Each tick calls `lock.heartbeat()`. A tick that fails (write error) emits an event
  and doesn't crash the loop. The per-cycle `heartbeat()` at `loop.ts:270` stays, and is
  harmless. `evaluateLock` is unchanged: with a live heartbeat its 45 s rule becomes correct
  again.
- `addFeature` (below) refuses while another feature is not `done` (A9), with the message
  "FEAT-X is still in progress (<stage>). The factory builds one feature at a time until M4;
  finish it first." The CLI surfaces it as a `CliError`.

- `src/cli/status.ts`: extract `buildStatusReport(resolution): Promise<StatusReport>` (*corrected during Phase 1:* no `deps`, because the report half never read it)
  (everything in `runStatus` before printing). `runStatus` becomes resolve → build → print.
  `formatReport` and `StatusReport` are unchanged.
- `src/cli/featureAdd.ts`: extract `addFeature(scope, { slug, priority, requirement }):
  Promise<FeatureAddResult>`, which takes requirement **text**. `runFeatureAdd` keeps
  reading the file, deriving the slug from the filename, and printing, then delegates.
  Duplicate-slug detection moves into `addFeature` [confirm the current duplicate behaviour when
  extracting, and keep it].
- `src/orchestrator/host.ts` (new): `startOrchestrator(input): Promise<OrchestratorHandle>`
  holding everything `runStart` does from `validateStartup` through `Orchestrator.start`
  (runner construction via `makeRunner`, `EventLog`, `RunRegistry`, workspace capability).
  Returns `{ run(opts), requestStop(), shutdown(), events, stopRequested }`. Validation
  failures are returned as a typed `StartupRefused { failures }` error, not a `CliError`.
- `src/cli/start.ts`: becomes `startOrchestrator` + signal handlers + `run()` + `shutdown()`.
  `makeRunner` and `noWorktreesMessage` move to `host.ts` (re-exported from `start.ts` if any
  test imports them).
- `src/git/git.ts`: add `logRange(base, head)` (`git log --format=%H%x09%s base..head`) and
  `diffNumstat(base, head)` (`git diff --numstat base...head`, binary files as `added: null`)
  to `Git` and `ShellGit`.

Unit tests to write:

- `test/unit/orchestrator/heartbeat.test.ts` (fake timers + injected clock):
  - [x] While an agent run takes 5 × `poll_interval`, `heartbeatAt` advances every interval,
        and `evaluateLock` never reports stale for a live PID
  - [x] The timer is cleared on `shutdown()`; no tick writes after release
  - [x] A tick whose write throws emits an event and the loop keeps running
  - [x] Regression: a dead PID is still reported stale at once (crash recovery unchanged)
- `test/unit/cli/status-report.test.ts`: `buildStatusReport` returns the same report that
  `runStatus --json` prints
  - [x] Empty vault → zero features, zero tickets, `orchestrator: 'stopped'`
  - [x] Feature with tickets in mixed states → correct `ticketsByState` and totals
  - [x] `needs_human` feature and ticket both appear in `needs_human`
  - [x] `runStatus --json` output equals `JSON.stringify(buildStatusReport(...))`
- `test/unit/cli/add-feature.test.ts`: `addFeature` from text
  - [x] Creates `feature.md` in `intake` with `## Raw Requirement` equal to the text, verbatim
  - [x] Rejects an unsafe slug (`../x`, empty) with the same message as today
  - [x] Rejects a duplicate slug and names the existing feature
  - [x] Rejects an invalid priority
  - [x] Refuses while another feature is in any stage other than `done`, naming it and its
        stage (A9); succeeds when every other feature is `done`
- `test/unit/orchestrator/host.test.ts`: `startOrchestrator`
  - [x] Validation failure → `StartupRefused` with failures, and the injected runner factory
        is **never called** (keeps the Phase 7a guarantee)
  - [x] Real runner without a workspace capability → refused with `noWorktreesMessage`
  - [x] Success → the instance lock is held; `shutdown()` releases it
  - [x] Lock held by a live PID → `InstanceLockHeldError`
- `test/unit/git/log-numstat.test.ts` (real toy repo via `test/helpers/toyRepo.ts`):
  - [x] `logRange` lists commits on the feature branch only, newest first, with subjects
  - [x] `logRange` on equal refs → `[]`
  - [x] `diffNumstat` reports added/removed per file; a binary file → `added: null`

Integration tests to write:

- [x] Heartbeat: a real `factory start` on a MockRunner vault whose agent fixture delays
      `4 × poll_interval` (with `poll_interval: 1`), plus a second `factory start` launched
      mid-run → the second is refused with `InstanceLockHeldError`, never `lock_reclaimed`
- [x] `factory feature add` of a second feature while the first is in `refining` → non-zero
      exit with the A9 message
- [x] `factory feature add <file>` via `buildProgram` still prints `Added FEAT-X (slug) in intake`
      and writes the same note (existing assertions in `cli-init` / `pipeline-paper`)
      *Corrected during Phase 1:* there were no such existing assertions. Characterisation tests were added
      in `test/unit/cli/add-feature.test.ts` and run green on the old code first.
- [x] *Added during Phase 1 (A9 decision):* the 3 `pipeline-paper` tests that add two features (the escalation,
      quarantine and kill tests) now create `bravo` by writing it directly into the vault instead of through
      `factory feature add`. Their assertions are unchanged (human decision, 2026-09-24).
- [x] Regression: `pipeline-paper.test.ts`, `feature-close.test.ts`,
      `worktree-workspace.test.ts`, `cli-init.test.ts` and the mock half of
      `acceptance.test.ts` pass unchanged

Done condition: Phase is complete when:

- [x] All unit tests pass
- [x] All integration tests pass
- [x] `npm run typecheck`, `npm run lint`, `npm run build` clean
- [x] `git diff` shows no change to any CLI output string, apart from the new A9 refusal message

Risk: High — `runStart` is the production entry point for every real run, and the heartbeat timer changes lock behaviour that crash recovery depends on. A subtle mistake in either reopens a guarantee M1–M3 pinned down.
Touches shared/core files: Yes — `src/orchestrator/lock.ts`, `src/orchestrator/loop.ts`, `src/cli/start.ts`, `src/cli/status.ts`, `src/cli/featureAdd.ts`, `src/git/git.ts`.

---

**Phase 2 — Pure view models: transcript steps, labels, event summaries**

Goal: Turn raw agent transcripts and event-log lines into plain-language data the page can show,
as pure functions with no I/O.

Implementation changes:

- `src/dashboard/constants.ts` (new): the constants in tech spec §1.
- `src/dashboard/labels.ts` (new): `ROLE_LABELS: Record<Role, string>`,
  `PAUSE_REASON_LABELS: Record<PauseReason, string>`, `STAGE_LABELS` for feature and ticket
  states, `EVENT_SUMMARIES: { [K in FactoryEvent['type']]: (e) => string }`. The mapped type
  makes a missing event type a **compile error**. `summariseEvent(e: LoggedEvent)` falls back
  to `e.type` for unknown runtime input.
- `src/dashboard/transcriptView.ts` (new): `toSteps(lines: readonly string[]):
  TranscriptStep[]` per tech spec §5. It also exports `summariseTool(name, input)` and a
  `pageLines(lines, before, size)` helper.
- `test/fixtures/transcripts/` (new): copy three real transcripts from
  `.factory-test-repos/acceptance-logs/real/2026-09-22T07-54-09-066Z/vault/logs/calculator/`
  (developer, qa, pm), with the long absolute paths replaced by `<ROOT>`.

Unit tests to write:

- `test/unit/dashboard/transcriptView.test.ts`:
  - [ ] Real developer transcript → first step `start` with model and tools, last step `end`
        with cost and duration
  - [ ] `tool_use` for Read / Bash / Edit / Write / Grep / Glob → the expected one-line summary
  - [ ] `tool_result` paired to its `tool_use` by id; content over
        `TOOL_RESULT_PREVIEW_CHARS` → `truncated: true`
  - [ ] `StructuredOutput` tool call → `deliver` step, numbered
  - [ ] `thinking` block → `think` step
  - [ ] A malformed JSON line and an unknown event type → `unknown` step, no throw
  - [ ] Empty input → `[]`
  - [ ] `pageLines` returns the last N lines, and the N before a given line
- `test/unit/dashboard/labels.test.ts`:
  - [ ] Every `Role`, `PauseReason`, feature state and ticket state has a label
  - [ ] `summariseEvent` for `item_transitioned`, `gates_finished` (green and red),
        `merge_completed`, `run_started` produces the expected sentence
  - [ ] Unknown runtime `type` → returns the type string, no throw

Integration tests to write:

- [ ] `toSteps` over **every** transcript in the kept real run (`logs/calculator/*.log`
      excluding gate logs) produces no `unknown` steps (guards against format drift)
- [ ] Regression: `test/unit/runner/streamParse.test.ts` unchanged and passing

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Deleting one key from `EVENT_SUMMARIES` fails `npm run typecheck` (checked once, by hand)

Risk: Low — pure functions over recorded data, with no effect on the running factory.
Touches shared/core files: No.

---

**Phase 3 — HTTP server, security and read API**

Goal: A loopback-only server that serves the static shell and every read endpoint, with the
host check, token and path confinement in place before any write endpoint exists.

Implementation changes:

- `src/dashboard/paths.ts` (new): `packageRoot()`, `uiRoot()`, `toyAppRoot()` via
  `import.meta.url` (A6).
- `src/dashboard/security.ts` (new): `checkHost(header, port)`, `checkToken(header, token)`
  (constant-time compare via `crypto.timingSafeEqual`), `confine(file, roots)` (realpath
  inside one of the roots), `newSessionToken()`.
- `src/dashboard/router.ts` (new): `(method, pattern) → handler`, `:param` extraction,
  `405` / `404` handling, JSON body parse with a 1 MB cap.
- `src/dashboard/server.ts` (new): `createDashboardServer(host): http.Server`. Applies
  checks in order: host → method → token (POST only) → route. Serves `/` (reads
  `dashboard-ui/index.html` and replaces the `<meta name="factory-token">` placeholder),
  `/assets/*` (confined to `uiRoot()`, content type by extension, `Cache-Control: no-store`),
  and `/api/*`. Errors come back as `{ message }` JSON, never HTML.
- `src/dashboard/runIndex.ts` (new, A10): `RunIndex` built by replaying `orchestrator.jsonl`:
  `run_started` / `run_finished` → `runId → {role, itemId, attempt, model, logPath,
  startedAt, finished, ok, costUsd, durationMs}`, and `gate_result` → a gate-log entry keyed by
  a stable id (`<itemId>:<gate>:<n>`). `apply(event)` keeps it live (wired to the bus in
  Phase 5). `byItem(itemId)` lists an item's runs and gate logs in order.
- `src/dashboard/handlers/read.ts` (new): `state`, `feature`, `item`, `itemRuns`,
  `activeRuns`, `transcript`, `gateLog`, `delivery`, `activity` per tech spec §5, except that
  transcripts and gate logs are fetched by id: `GET /api/runs/:runId/transcript[?before=]` and
  `GET /api/gate-logs/:gateLogId`. The path comes from `RunIndex`, then `confine()`. It takes a
  minimal `ReadContext { scope: VaultScope, lockView, git, runIndex }`, so Phase 3 has no
  dependency on the host.
- `src/dashboard/sections.ts` (new): `splitSections(body)` → ordered `{heading, markdown}[]`,
  and `parseHistory(markdown)` → `{ts, from, to, actor, note}[]` (the `## History` line format
  `ts | from → to | actor | note`).
- `dashboard-ui/index.html` (new, placeholder): minimal shell with the token meta, so the
  server can be tested. The real UI comes in Phase 7.

Unit tests to write:

- `test/unit/dashboard/security.test.ts`:
  - [ ] `checkHost` accepts `127.0.0.1:<port>` and `localhost:<port>`; rejects `evil.com`,
        a wrong port, an empty header, and `127.0.0.1.evil.com`
  - [ ] `checkToken` rejects missing, wrong, and different-length tokens
  - [ ] `confine` rejects `../` escapes, absolute paths outside the roots, and a symlink
        pointing outside
- `test/unit/dashboard/router.test.ts`:
  - [ ] Param extraction; unknown path → 404; wrong method → 405; body over 1 MB → 413;
        invalid JSON → 400
- `test/unit/dashboard/sections.test.ts`:
  - [ ] `splitSections` on the real `feature.md` returns Raw Requirement, Refined Requirement,
        Acceptance Criteria, Tech Plan, Gate Results, Notes and History, in order
  - [ ] `parseHistory` parses the 9 real history lines, including a note containing `|`
- `test/unit/dashboard/read-handlers.test.ts` (fixture vault built with
  `test/helpers/vaultFixtures.ts`):
  - [ ] `state` includes `mode`, `demo: false`, `killed`, `totalCostUsd`, and `needs_human`
        entries with `resume_to` / `reject_to`
  - [ ] `feature` for an unknown slug → 404; for an unsafe slug → 400
  - [ ] `transcript` for an unknown `runId` → 404, never reads a file
  - [ ] A `run_started` event whose `logPath` points outside `logs/` (a planted jsonl line) →
        refused by `confine()`, 404
  - [ ] `transcript` with `before` pages correctly; missing file → 404 with the spec message
- `test/unit/dashboard/runIndex.test.ts`:
  - [ ] Replaying the real acceptance `orchestrator.jsonl` indexes all 16 runs with the correct
        role, item and attempt, including the retried DL run
  - [ ] `merge` and `close-<sha>` gate logs are indexed under the right item, in order
  - [ ] `apply()` of a new `run_started` then `run_finished` updates `finished` / `ok` / cost
  - [ ] A malformed jsonl line is skipped, not fatal
  - [ ] `delivery` returns commits and numstat from a toy repo feature branch

Integration tests to write:

- `test/integration/dashboard-server.test.ts` (real server on port 0):
  - [ ] `GET /` returns HTML with the session token injected
  - [ ] Any request with `Host: evil.com` → 421
  - [ ] `OPTIONS /api/state` → 405, and no `Access-Control-*` header on any response
  - [ ] `GET /assets/../../package.json` → 404 (confinement)
  - [ ] `GET /api/state` on a vault with one paused feature matches `buildStatusReport`
- [ ] Regression: no existing test changes

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `curl -H 'Host: evil.com' http://127.0.0.1:<port>/api/state` → 421 (manual, once)

Risk: Medium — the first network surface in the system, and the security checks must be right before any write endpoint exists.
Touches shared/core files: No.

---

**Phase 4 — Dashboard host, write API and `factory dashboard`**

Goal: A long-lived host that can run the orchestrator in-process, knows whether the factory is
hosted here, elsewhere or stopped, and exposes approve / reject / add / start / stop / kill
over authenticated `POST`s, launched by one command.

Implementation changes:

- `src/dashboard/mutex.ts` (new): a minimal promise-chain mutex.
- `src/dashboard/host.ts` (new): `DashboardHost` per tech spec §4.1. `mode()`: we hold the
  handle → `hosted`; otherwise `readInstanceLock` + **PID liveness** (`defaultLiveness`) →
  a live foreign PID is `external` **regardless of heartbeat age** (A8; age is reported, never
  used to enable Start); no record or dead PID → `stopped`. `start()` calls
  `startOrchestrator` (Phase 1) and runs `run()` in the background, catching rejection into
  `lastError` + mode `stopped`. `stop()` calls `requestStop()` and awaits settlement.
  `startupFailures` are kept for `/api/state`.
- **Interruptible sleep (devils-advocate mitigation 2):** `host.start()` passes
  `run({ sleep })` (the seam already exists at `loop.ts:237`) with a sleep that resolves early
  when `host.wake()` is called. Every successful write handler (`approve`, `reject`,
  `addFeature`, `resume`) calls `host.wake()`, so the next cycle starts at once instead of up
  to `poll_interval` later. In `external` mode `wake()` does nothing (that loop is in another
  process), and the UI says "The factory will pick this up within 15 s".
- **Forced stop (devils-advocate mitigation 5):** `runDashboard`'s signal handler. The first
  SIGINT/SIGTERM → `host.stop()` (drain) and prints "Stopping after the current agent finishes.
  Press Ctrl-C again to stop it now." A second → `host.forceStop()`, which aborts the
  orchestrator's `AbortController` (the runner kills the agent's process group, the existing
  `aborted` failure path), then `shutdown()` and exit. `POST /api/factory/stop` accepts
  `{ force: true }` for the same thing from the page (behind a second confirm).
- `src/dashboard/handlers/write.ts` (new): `approve`, `reject`, `addFeature`, `start`,
  `stop`, `kill`, `resume`. Every one runs under `host.mutex`, calls the existing function
  (`actions.approve` / `actions.reject` / `addFeature` / `kill` / `clearKill`), maps
  `ActionError` → 409, validation → 400, `StartupRefused` → 422, and wrong mode → 409.
  `approve` adds `held: true` when a feature returns to `awaiting_feature_close`.
- `src/dashboard/handlers/read.ts`: `state` gains `mode`, `lastError`, `startupFailures`.
- `src/cli/dashboard.ts` (new): `runDashboard({ project, vault, port, open, start }, deps)`.
  It resolves the vault (`openVault`), builds the host, binds (port busy → `CliError` naming
  `--port`), prints the URL, runs `open <url>` unless `--no-open` (spawn failure is logged,
  not fatal), starts the orchestrator **only with `--start`** (Gate 2 decision), and on
  SIGINT/SIGTERM does `host.stop()` → `server.close()`.
- `src/cli/main.ts`: register
  `dashboard [project] --vault --port --no-open --start`.

Unit tests to write:

- `test/unit/dashboard/host.test.ts` (injected `startOrchestrator` fake + lock view):
  - [ ] No lock → `stopped`; we hold it → `hosted`; live foreign PID → `external`;
        dead foreign PID → `stopped`
  - [ ] Live foreign PID with a heartbeat 10 minutes old → still `external`, and Start stays
        refused (A8)
  - [ ] `wake()` during the injected sleep resolves it at once; `wake()` with no sleep
        pending is a no-op
  - [ ] `forceStop()` aborts the signal passed to `startOrchestrator`, then shuts down
  - [ ] `start()` in `external` → refused; in `stopped` → `hosted`
  - [ ] `run()` rejecting → mode `stopped`, `lastError` set, host still usable
  - [ ] `stop()` resolves only after `run()` settles
  - [ ] `StartupRefused` → `startupFailures` populated, mode `stopped`
- `test/unit/dashboard/write-handlers.test.ts` (MockRunner vault with a paused feature):
  - [ ] `approve` on a checkpoint → 200, the note moves to `resume_to`, and the note text
        lands in `## Notes`
  - [ ] `approve` twice → the second returns 409 "is planning, not needs_human"
  - [ ] `reject` with an empty reason → 400; with a reason → 200 and `reject_to`
  - [ ] `reject` on a pause with no `reject_to` → 409 with the `actions.ts` message
  - [ ] `addFeature` → 201; a duplicate → 409; while another feature is active → 409 with
        the A9 message
  - [ ] Every successful write calls `host.wake()` once; a failed write doesn't
  - [ ] Two concurrent `approve`s on the same id → exactly one 200, one 409 (the mutex)
  - [ ] `start` / `stop` in `external` mode → 409
  - [ ] A `POST` without `X-Factory-Token` → 403 before any handler runs
- `test/unit/cli/dashboard.test.ts`:
  - [ ] Port in use → `CliError` naming the port and `--port`
  - [ ] Without `--start`, the orchestrator isn't started (the fake is never called)
  - [ ] `--no-open` doesn't spawn `open`

Integration tests to write:

- `test/integration/dashboard-actions.test.ts` (real server, `MockRunner` scripted like
  `pipeline-paper`):
  - [ ] `POST /api/factory/start` → mode `hosted`; the feature advances to the first checkpoint
  - [ ] `POST /api/items/FEAT-X/approve` → advances; `NEEDS_HUMAN.md` regenerated
  - [ ] With `poll_interval: 15`, the transition after an HTTP approve starts in under 1 s
        (wake), not after the sleep
  - [ ] A second SIGINT during a delayed MockRunner run aborts the run (`run_killed` /
        `aborted`), releases the lock, and leaves no child process
  - [ ] Final-acceptance approve over HTTP merges into `main` and creates the tag (toy repo)
  - [ ] `POST /api/factory/stop` → mode `stopped`, instance lock released, no claim left
  - [ ] A second process holding the lock (`test/helpers/crashDuringDispatch.mjs` style) →
        mode `external`; approve still works
- [ ] Regression: the CLI `factory approve` / `reject` tests pass unchanged; `actions.ts` has
      no diff

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `git diff main -- src/orchestrator/actions.ts` is empty
- [ ] `factory dashboard --vault <scratch> --no-open` prints a URL and exits cleanly on Ctrl-C (manual)

Risk: High — this hosts the orchestrator in a long-lived server process and exposes the merge-to-main action over HTTP. Lifecycle, crash and mode bugs here are the ones that would cost real runs.
Touches shared/core files: Yes — `src/cli/main.ts`.

---

**Phase 5 — Live updates (ChangeBus and SSE)**

Goal: The page learns about every change within a second, whether it came from the hosted
loop, a terminal `factory start`, or a CLI `approve`, and can follow one transcript live.

Implementation changes:

- `src/dashboard/changeBus.ts` (new): `ChangeBus` with `subscribe(fn) → unsubscribe` and
  `emit(msg)`, where `msg` is `{kind:'event', event, summary} | {kind:'state_changed',
  itemIds?} | {kind:'transcript_line', runRef, steps}`.
- `src/dashboard/teeEvents.ts` (new): `TeeEventSink implements EventSink` wrapping the
  `EventLog`. Every `emit` writes to the file, then the bus. `startOrchestrator` accepts an
  optional `eventSinkWrapper` (a Phase 1 seam extended here), used only by the host.
- `src/dashboard/watchers.ts` (new):
  - `tailJsonl(file, fromOffset, onLine)` — `fs.watch` + read from offset +
    `JsonlLineSplitter`; handles the file not existing yet, and truncation (offset reset).
    Used in `external` / `stopped` mode, **disabled in `hosted` mode** (the tee covers it,
    so events are never duplicated).
  - `watchVault(paths, onChange)` — `fs.watch(featuresDir, {recursive:true})` + `.runs/` +
    the instance lock + `.kill`, debounced `WATCH_DEBOUNCE_MS`, mapping file paths to
    `itemIds` where possible.
  - `tailTranscript(file, onSteps)` — per-subscriber, ref-counted, closed on the last
    unsubscribe.
- `RunIndex.apply` (Phase 3) is subscribed to the bus, so runs started after launch are
  addressable at once.
- `src/dashboard/handlers/stream.ts` (new): `GET /api/stream[?run=<runId>]` writes
  `text/event-stream`, sends the heartbeat every `SSE_HEARTBEAT_MS`, and unsubscribes on
  `close`.
- `src/dashboard/host.ts`: owns the bus and watchers; switches the tail on and off on mode
  changes.

Unit tests to write:

- `test/unit/dashboard/changeBus.test.ts`:
  - [ ] Fan-out to many subscribers; an unsubscribed one receives nothing
  - [ ] A throwing subscriber doesn't stop the others
- `test/unit/dashboard/watchers.test.ts` (temp dirs):
  - [ ] `tailJsonl` emits only complete lines; a partial line waits for its newline
  - [ ] File created after the tail started → picked up
  - [ ] File truncated → offset resets, no crash
  - [ ] `watchVault` debounces a burst of 3 writes into 1 `state_changed` with `itemIds`
  - [ ] `tailTranscript` closes its watcher when the last subscriber leaves
- `test/unit/dashboard/teeEvents.test.ts`:
  - [ ] Every event reaches both the file and the bus, file first
  - [ ] A bus failure never fails the file write

Integration tests to write:

- `test/integration/dashboard-stream.test.ts` (real server, SSE read with `fetch` + stream):
  - [ ] Hosted mode: `approve` over HTTP → the client receives `item_transitioned`, then
        `state_changed`, each exactly once
  - [ ] Stopped mode: CLI `approve` (via `buildProgram`) → the SSE client receives the
        event from the jsonl tail
  - [ ] Transcript subscription on a growing file receives new steps in order
  - [ ] A client disconnect removes the subscriber (bus subscriber count back to 0)
  - [ ] Heartbeat arrives within `SSE_HEARTBEAT_MS` (run with a shortened constant)
- [ ] Regression: `EventLog` file contents are byte-identical with and without the tee
      (compare a MockRunner pipeline run)

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] No open file handles after server close (vitest leak check, or `lsof` once by hand)

Risk: Medium-High — file watching and long-lived streams are classic sources of flaky tests, leaked handles and duplicated events.
Touches shared/core files: Yes — `src/orchestrator/host.ts` (sink wrapper seam from Phase 1).

---

**Phase 6 — Demo runner and `factory demo`**

Goal: A free, scripted, end-to-end run on a throwaway toy repo, so the dashboard (and anyone
learning the factory) can be exercised at $0. It also gives phases 7–8 a live backend to build
the UI against.

Implementation changes:

- `src/config/schema.ts`: `runner` enum gains `'demo'`. `vault-template/config.yml`
  comment updated.
- `src/runner/demo.ts` (new): `DemoRunner implements Runner`. For each `AgentRunSpec` it
  resolves a step by `<role>:<itemId>` then `<role>` (like `scriptedAgents`), waits
  `DEMO_STEP_DELAY_MS` (abortable via `spec.signal`), writes the step's files into
  `spec.cwd`, writes a short synthetic stream-json transcript (init → a few `tool_use` /
  `tool_result` / `text` → `result`) to the run's log path, registers and completes in `.runs/`,
  emits `run_started` / `run_finished`, and returns the structured payload with
  `costUsd: 0`.
- `src/runner/demoScript.ts` (new): one feature, "Expression calculator", on the toy app. PM
  payload, TL plan, DL breakdown modelled on `MOCK_BREAKDOWN`
  (`test/integration/acceptance.test.ts:255`), 4 tickets / 4 modules, and per-ticket
  developer file writes that pass the toy app's real `npm test` / `lint` / `build`, code
  review `approve`, QA `pass` with per-criterion evidence. It also exports
  `DEMO_REQUIREMENT` (the raw requirement text).
- `src/orchestrator/host.ts`: `makeRunner` handles `'demo'`.
- `src/cli/demo.ts` (new): `runDemo({ port, open, fresh }, deps)`. It resolves
  `<factory home>/demo/`, and with `--fresh` or when missing: copies `toyAppRoot()` → `repo/`,
  writes `.gitignore`, `git init -b main` + commit, runs `runInit` into `vault/` **without
  registering** (A5; needs a `register: false` option on `runInit`), sets `runner: "demo"`,
  writes a demo `project.md`, and `addFeature(DEMO_REQUIREMENT)`. Then it calls
  `runDashboard({ vault, start: true, ... })`.
- `src/cli/init.ts`: add `register?: boolean` (default `true`).
- `src/cli/main.ts`: register `demo --port --no-open --fresh`.

Unit tests to write:

- `test/unit/runner/demo.test.ts`:
  - [ ] Unknown `<role>:<itemId>` and role → throws naming both keys (no silent default)
  - [ ] Writes step files into `cwd`; writes a transcript that `toSteps` renders with no
        `unknown` steps
  - [ ] Abort during the delay → returns the `aborted` failure, writes nothing further
  - [ ] Registers and then completes its `.runs/` entry
- `test/unit/runner/demoScript.test.ts`:
  - [ ] Every structured payload validates against its role schema in
        `src/agents/schemas.ts`
  - [ ] The DL breakdown's modules are pairwise distinct (no merge conflicts), and
        `depends_on` forms a DAG
- `test/unit/config/schema.test.ts` (modified):
  - [ ] `runner: demo` accepted; `runner: fake` still rejected with the key named

Integration tests to write:

- `test/integration/dashboard-demo.test.ts` (with `FACTORY_HOME` pointed at a temp dir,
  `DEMO_STEP_DELAY_MS` shortened via an injected option):
  - [ ] `runDemo --no-open` creates the repo and vault, doesn't touch `projects.yml`, and
        auto-starts
  - [ ] Driving only HTTP: three `approve`s take the feature `intake → done`; the tag
        `factory/<slug>/<date>` exists in the demo repo; `totalCostUsd` is 0
  - [ ] `--fresh` recreates from scratch; without it, re-running resumes the existing demo
- [ ] Regression: `runner: mock` and `runner: claude-code` vaults behave exactly as before
      (the existing pipeline tests)

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `factory demo` reaches the first checkpoint on a real machine in under a minute (manual)

Risk: Medium-High — the scripted developer steps must pass the toy app's real gates, and a demo that parks on a red gate would teach the wrong lesson.
Touches shared/core files: Yes — `src/config/schema.ts`, `src/cli/init.ts`, `src/cli/main.ts`.

---

**Phase 7 — UI shell and read views**

Goal: The page itself: top bar, feature list, overview, feature page (tabs), ticket page and
live transcript view, all fed by the read API and SSE.

Implementation changes:

- `dashboard-ui/index.html`: full shell (top bar, left column, main outlet, toast region,
  DEMO badge slot).
- `dashboard-ui/styles.css`: tokens (light and dark via `prefers-color-scheme`), layout,
  stage strip, pills, board columns, transcript styles, focus states, reduced motion.
- `dashboard-ui/app.js`: boot, hash router (`routes.js`), `api()` fetch wrapper (adds the
  token and turns `{message}` errors into toasts), `EventSource('/api/stream')` with
  reconnect → store updates, tab title `(<n>) App Factory — <project>`.
- `dashboard-ui/routes.js` (+ `.d.ts`): `parseRoute(hash)` / `href(route)` for the six routes.
- `dashboard-ui/store.js` (+ `.d.ts`): state object, `set`, `subscribe`, `selectWaitingCount`.
- `dashboard-ui/format.js` (+ `.d.ts`): money, durations, relative time, stage → colour
  class.
- `dashboard-ui/components/markdown.js` (+ `.d.ts`): the escaping renderer (tech spec §3).
  It returns a **string of safe HTML**; the only element allowlist is `h2–h4, p, ul, ol, li,
  pre, code, strong, em, a[href^=http|#]`.
- `dashboard-ui/components/{stageStrip,pill,gateBadge,toast}.js`.
- **Form-safe rendering rule (devils-advocate mitigation 4)**, enforced by one helper,
  `dashboard-ui/render.js` (+ `.d.ts` for its pure part): each view renders into named data
  regions (`patch(region, html)`), and **never replaces an element that is focused or holds
  unsaved input** (`textarea`, `input`, `select` marked `data-keep`). A refresh that would
  touch one updates the regions around it and leaves the field alone. The run view's
  follow-tail appends steps instead of re-rendering the list.
- `dashboard-ui/views/{overview,feature,ticket,run}.js` per the J1 and J4 journeys: empty
  states, the "running in another window" banner, startup-failure panel, ticket board columns in
  `TICKET_STATES` order, run view follow-tail with scroll-lock, raw toggle, "Show earlier steps".
- `eslint.config.js`: a `dashboard-ui/**/*.js` block with browser globals (A3).

Unit tests to write:

- `test/unit/dashboard-ui/markdown.test.ts`:
  - [ ] `<script>`, `<img onerror>`, `javascript:` links and raw HTML in a note are escaped
        or dropped
  - [ ] Headings, lists, fenced code, inline code, bold and http links render
  - [ ] A code fence containing `<b>` shows literal text
  - [ ] Real `feature.md` sections render without throwing
- `test/unit/dashboard-ui/routes.test.ts`:
  - [ ] Every route round-trips `href → parseRoute`; an unknown hash → overview
- `test/unit/dashboard-ui/store.test.ts`:
  - [ ] Subscribers are notified on `set`; `selectWaitingCount` counts `needs_human` items
- `test/unit/dashboard-ui/format.test.ts`:
  - [ ] `$0.1234 → $0.12`, `1237000 ms → 20m 37s`, every stage maps to a class
- `test/unit/dashboard-ui/render.test.ts` (the pure decision function `shouldReplace(el)` over
  plain objects):
  - [ ] A focused or dirty `data-keep` field → keep; an unfocused, clean one → replace; a
        non-form region → replace

Integration tests to write:

- [ ] `dashboard-server.test.ts` (extended): every file under `dashboard-ui/` referenced by
      `index.html` is served 200 with the right content type
- [ ] `npm run lint` passes on `dashboard-ui/` (and fails on a deliberate `undefinedGlobal`,
      checked once by hand, since the rule would otherwise fail open)
- [ ] Manual, against `factory demo`: overview, feature tabs, ticket page and live run view all
      update without a refresh as the demo advances

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Manual demo walk-through of J1 and J4 done, in light and dark, and at ~400 px width
- [ ] Manual: scroll up in a live run view while the demo advances → the view doesn't jump;
      scroll to the bottom → follow resumes

Risk: Medium — lots of new code, but only reads, and the injection risk is contained in one tested module.
Touches shared/core files: Yes — `eslint.config.js`.

---

**Phase 8 — UI actions: review, add feature, start/stop, notifications**

Goal: Every write the user needs from the page (J2, J3, J5, J6, J7), with in-page confirmations
and no lost input on failure.

Implementation changes:

- `dashboard-ui/components/confirmDialog.js`: an in-page modal (no `window.confirm`),
  focus-trapped, Esc cancels.
- `dashboard-ui/views/review.js`: what is shown per checkpoint (by `pause_reason` +
  feature status + `resume_to`: after_pm_refinement / after_ticket_breakdown /
  final_acceptance / escalation kinds). Final acceptance calls `GET
  /api/features/:slug/delivery`. There's a reply box. **Send back** is hidden when `reject_to` is
  null, with the "Approving is the only way forward" line shown instead. Approve at final
  acceptance goes through `confirmDialog`. A `held: true` response shows the standing-approval
  message. A 409 "not needs_human" shows "Already handled" and refreshes. On any error the note
  text is kept.
- `dashboard-ui/views/add-feature.js`: name → slug preview (same `slugify` rules as the
  server; the server remains the authority), priority, requirement, disabled submit until
  valid. **While another feature isn't `done`, the form is blocked** (A9): fields are disabled and
  a panel names the active feature and its stage, with a link to it. A 409 from the server (a
  race) shows the same panel and keeps the draft.
- `dashboard-ui/app.js`: top-bar Start / Stop (with the Stop confirm), a "More" menu → Stop taking
  new work / Resume new work, button states by `mode`, Stopping… state with a **Stop now**
  button (second confirm: "This aborts the running agent; its work on this attempt is lost")
  → `POST /api/factory/stop {force:true}`. In `external` mode, a successful action shows
  "The factory will pick this up within <poll_interval> s".
- All forms (review reply box, add feature) use `data-keep` so the Phase 7 render rule
  protects them.
- `dashboard-ui/notify.js`: the permission banner (once; "Not now" remembered in
  `localStorage` inside try/catch), one `Notification` per **new** `needs_human` id
  (tracked in memory), click → `#/review/:id`.
- `src/dashboard/slug.ts`: shares `slugify` with `src/cli/featureAdd.ts` so the UI preview
  rule is documented in one place; the UI copy is a mirror checked by a test.

Unit tests to write:

- `test/unit/dashboard-ui/review-model.test.ts` (the pure part of `review.js` extracted to
  `dashboard-ui/reviewModel.js` + `.d.ts`):
  - [ ] Each checkpoint maps to its title question and the sections to show
  - [ ] `reject_to: null` → `canSendBack: false` with the explanation text
  - [ ] `resume_to: 'done'` → `needsMergeConfirm: true`
- `test/unit/dashboard-ui/slug.test.ts`:
  - [ ] The UI `slugify` mirror equals the server `slugify` over a table of 20 names,
        including unicode and punctuation
- `test/unit/dashboard-ui/notify-model.test.ts`:
  - [ ] Only ids not seen before trigger; ids that leave and return trigger again

Integration tests to write:

- [ ] `dashboard-demo.test.ts` (extended): reject at checkpoint 1 over HTTP with a reason →
      the PM re-runs and the reason is in `## Notes`; approve continues to `done`
- [ ] Manual, against `factory demo`: J2 add feature, J3 start / stop / pause / resume, J5 all
      three checkpoints including the merge confirm, J7 notification click-through
- [ ] Manual escalation (J6): hand-edit a demo ticket to `needs_human`, `escalation`,
      `reject_to: null` while stopped → the review page hides Send back

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Manual walk-through of J2, J3, J5, J6, J7 done against the demo
- [ ] Manual: type a rejection reason on a review page while the demo advances other items
      (and while the activity feed updates) → not one character lost; the same for the
      add-feature form
- [ ] Manual: add feature while the demo feature is active → blocked with the reason

Risk: Medium — the merge-to-main approval is now one click away, so the confirm and error paths must be exact, but the server-side checks from Phases 3–4 carry the safety.
Touches shared/core files: Yes — `src/cli/featureAdd.ts` (shared `slugify`).

---

**Phase 9 — ADR-005, docs and acceptance**

Goal: Record the architecture decision, document the dashboard, and prove the whole thing on a
clean machine state.

Implementation changes:

- `docs/adr/005-local-dashboard.md` (new): the Section F entry. `docs/adr/README.md`
  index row.
- `README.md`: a "Dashboard" section before "Development": `factory dashboard`,
  `factory demo`, what Start does, the security model in two lines, and "don't edit notes
  while running" still applies.
- `docs/features/factory-dashboard-plan.md`: ledger rows, session summary, done checklist.
- The published App Factory Field Guide artifact: replace the "Watching progress" terminal
  panes with the dashboard, and add the demo command.

Unit tests to write:

- None new. This phase is documentation plus the acceptance pass.

Integration tests to write:

- [ ] Full suite green: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] Manual browser acceptance with `rm -rf <factory home>/demo && factory demo`: J1 → J8 end
      to end, `done` + tag, in Chrome (optionally recorded with Claude-in-Chrome)
- [ ] Optional, paid (~$3, only on explicit go-ahead): `factory dashboard --start` on a copy of
      the toy app with `runner: claude-code`, one real feature through the page

Done condition: Phase is complete when:

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] ADR-005 merged into `docs/adr/`, README updated, guide republished

Risk: Low — documentation and verification, no new code paths.
Touches shared/core files: Yes — `README.md`, `docs/adr/README.md`.

---

## Section C — Full test summary

**New test files:**

- `test/unit/cli/status-report.test.ts`: `buildStatusReport` parity with `status --json`
- `test/unit/cli/add-feature.test.ts`: `addFeature` from text, slug and priority validation
- `test/unit/cli/dashboard.test.ts`: port-in-use, no auto-start, `--no-open`
- `test/unit/orchestrator/heartbeat.test.ts`: timer-driven heartbeat keeps a live lock fresh (A8)
- `test/unit/orchestrator/host.test.ts`: `startOrchestrator` refusal, lock, runner-never-built
- `test/unit/git/log-numstat.test.ts`: `logRange`, `diffNumstat`
- `test/unit/dashboard/transcriptView.test.ts`: stream-json → steps
- `test/unit/dashboard/labels.test.ts`: label and summary coverage
- `test/unit/dashboard/security.test.ts`: host, token, confinement
- `test/unit/dashboard/router.test.ts`: routing, body limits
- `test/unit/dashboard/sections.test.ts`: section split, history parse
- `test/unit/dashboard/runIndex.test.ts`: `runId` → log path index from the event log (A10)
- `test/unit/dashboard/read-handlers.test.ts`: every read endpoint
- `test/unit/dashboard/host.test.ts`: modes, lifecycle, crash handling
- `test/unit/dashboard/write-handlers.test.ts`: every write endpoint, mutex, token
- `test/unit/dashboard/changeBus.test.ts`: fan-out
- `test/unit/dashboard/watchers.test.ts`: jsonl tail, vault watch, transcript tail
- `test/unit/dashboard/teeEvents.test.ts`: file-then-bus ordering
- `test/unit/runner/demo.test.ts`: `DemoRunner`
- `test/unit/runner/demoScript.test.ts`: script payloads validate, DAG, distinct modules
- `test/unit/dashboard-ui/{markdown,routes,store,format,render,review-model,slug,notify-model}.test.ts`: pure UI modules
- `test/integration/dashboard-server.test.ts`: real server, security, static serving
- `test/integration/dashboard-actions.test.ts`: HTTP actions end to end on MockRunner, incl. merge + tag
- `test/integration/dashboard-stream.test.ts`: SSE in hosted and stopped modes
- `test/integration/dashboard-demo.test.ts`: `factory demo` intake → done over HTTP, $0
- `test/fixtures/transcripts/*.log`: three real transcripts, paths scrubbed

**Modified test files:**

- `test/unit/config/schema.test.ts`: `runner: demo` accepted
- `test/integration/cli-init.test.ts`: `register: false` leaves `projects.yml` untouched

**Regression test targets:**

- `test/integration/pipeline-paper.test.ts`: the orchestrator after the `runStart` split
- `test/integration/feature-close.test.ts`: approve-at-final-acceptance merge + tag
- `test/integration/worktree-workspace.test.ts`: real `factory start` with worktrees
- `test/integration/cli-init.test.ts`: init / status / feature add CLI output
- `test/integration/acceptance.test.ts` (mock half): intake → done through the CLI
- `test/integration/orchestrator-recovery.test.ts`: crash recovery and claims
- `test/unit/orchestrator/{lock,claim,checkpoints,featureClose}.test.ts`: lock and action semantics
- `test/unit/runner/streamParse.test.ts`: transcript format assumptions
- `test/unit/ci/workflow-contract.test.ts`: CI still runs the free suite only
- Everything else in `npm test` (1347 tests at the M1–M3 close)

---

## Section D — Recommended PR structure

Three PRs, each self-contained with its tests:

1. **PR 1 — Seams and pure models (Phases 1–2).** Pure refactor plus pure functions. Reviewable
   on its own, and it shrinks the later diffs. Merging it early de-risks the `runStart` split
   before anything depends on it.
2. **PR 2 — Server, host, live updates, demo (Phases 3–6).** The whole backend and the
   `factory dashboard` / `factory demo` commands, usable via `curl` and fully tested without a
   browser. This is the PR that needs the most careful security review.
3. **PR 3 — UI and docs (Phases 7–9).** Static files, lint config, ADR-005, README. Reviewed
   against the running demo.

If you'd rather ship one PR, the phase commits still give clean rollback points, but PR 2's
security surface deserves its own review.

---

## Section E — What must NOT change

1. **Every CLI command's output text and exit codes** (`init`, `projects`, `status`,
   `start`, `stop`, `feature add`, `approve`, `reject`, `kill`). Guarded by `cli-init`,
   `pipeline-paper` and the Phase 1 parity tests. **One deliberate exception (A9):** `feature
   add` now refuses while another feature is not `done`. It's recorded here so it isn't mistaken
   for a regression, and lifted in M4.
2. **`src/orchestrator/actions.ts` is byte-for-byte unchanged.** The dashboard is a new caller
   of the single write path, never a second one (ADR-002). Checked by `git diff` in Phase 4.
3. **Lock semantics other than the heartbeat cadence (A8):** `wx` acquisition, dead-PID
   reclaim, the 3 × `poll_interval` staleness rule, and crash recovery. Only *when* the
   heartbeat is written changes. Guarded by `lock.test.ts`, `orchestrator-recovery.test.ts` and
   the new heartbeat tests.
4. **Startup order in `factory start`:** validation before any runner is constructed; refusal
   without worktrees for a real runner. Guarded by `host.test.ts` and the existing Phase 7a
   tests.
5. **Final acceptance semantics:** the stale-verdict refusal, standing approval,
   merge-before-`done`, tag naming. Guarded by `feature-close.test.ts` and
   `dashboard-actions.test.ts`.
6. **`logs/orchestrator.jsonl` content** is identical whether or not the tee is present.
   Guarded by the Phase 5 regression.
7. **`runner: mock` and `runner: claude-code` behaviour.** Guarded by the pipeline tests.
8. **`config.yml` stays strict.** Unknown keys still error. The only schema change is the
   `demo` enum value.
9. **No new runtime or dev npm dependencies.** Checked in review (`package.json` diff).
10. **The orchestrator stays the only thing that writes the vault's notes.** The HTTP layer never
   imports `Storage.writeNote`. A lint `no-restricted-imports` rule on
   `src/dashboard/**` for `../vault/storage.js` write paths is optional hardening
   [decide in Phase 4 review].

---

## Section F — ADR update

**New file `docs/adr/005-local-dashboard.md`**, plus one row in the `docs/adr/README.md` index. No
existing ADR is edited. ADR-002 gains a caller, not an exception.

```markdown
# 005 — A local dashboard hosts the orchestrator behind a loopback-only HTTP surface

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** none

## Context

Operating the factory meant one CLI command per step, and progress could only be read from
vault files and JSONL logs. M1–M3 reserved seams for a dashboard (`actions.ts` as the single
write path, `status --json`, `.runs/`, line-buffered transcripts) and scheduled it for M7.
It was pulled forward so the factory is usable before M4–M6.

## Decision

`factory dashboard` runs an HTTP server and, on request, the orchestrator itself in the same
process, through the same `startOrchestrator` function that `factory start` uses. The page
changes state only by calling the existing `actions.ts` functions (`approve`, `reject`,
`kill`, `clearKill`) and a new `addFeature` function extracted from `factory feature add`.
No handler writes a note directly.

The server binds to `127.0.0.1` only, rejects any request whose `Host` header is not a
loopback name on its own port, and requires a per-launch random token in a custom header on
every state-changing request. It sends no CORS headers. File reads are confined to the vault's
`logs/` and `work/features/` through `VaultPaths`.

A third runner kind, `demo`, runs a scripted feature against a throwaway copy of the toy app
at no cost, so the dashboard and the pipeline can be exercised without real agents.

## Consequences

The factory becomes operable without a terminal, and the single-write-path rule survives
intact. ADR-002 gains a caller, not an exception.

It is also the system's first network surface. Any web page open in the user's browser can
send requests to a localhost port, so the Host check and the token are load-bearing, not
defensive extras. Removing either reopens DNS-rebinding or CSRF attacks against the one action
that writes the base branch.

Hosting the loop in a long-lived server couples the orchestrator's lifetime to the
dashboard's. A crash in `run()` must leave the server up and the vault recoverable, which
the existing claim and lock recovery already guarantees.

The UI and the demo's toy app are loaded from the package directory at runtime. This holds
for the only supported install (running from the repo via `npm link`) and would need a copy
step if the package were ever published.
```

---

## Section G — Feature done checklist

- [ ] All phases complete and committed
- [ ] Full test suite green — `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] E2E tests pass — `test/integration/dashboard-demo.test.ts`, plus the Phase 9 manual browser acceptance
- [ ] Plan doc updated with final session summary (`/session-summary factory-dashboard`)
- [ ] PR open and linked to feature docs
- [ ] ADR-005 added to `docs/adr/` (Section F)

---

## Delivery ledger

| Phase | Commit | Tests (passed / skipped / files) | Gates (test · typecheck · lint · build) | Review | Carried forward |
|---|---|---|---|---|---|
| Baseline | `7241204` | 1344 / 12 / 58 (3 failed) | 3 pin failures · ok · ok · ok | — | CLI auto-updated to 2.1.280; 3 version-pin tests fail. Paid re-probe needed before any real-agent run (human decision). |
| 1a heartbeat | `cc248f8` | 1356 / 12 / 60 (3 pin) | pin only · ok · ok · ok | PROCEED WITH FIXES (fixes landed in 1b) | Integration test relies on real timing (~2 s margin at `poll_interval` 1). |
| 1b seams + A9 | _this commit_ | 1408 / 12 / 66 (3 pin) | pin only · ok · ok · ok | Fixes verified by the orchestrator (no expect() lines changed in pipeline-paper; wording fix "finish it first") | `OrchestratorHostDeps` type-imports `src/cli` → invert in Phase 4. A quarantined (unreadable) feature note doesn't count as active for A9. |

## Open Questions

- None open. Section E item 10 (the lint guard on `src/dashboard/**`) is decided in the Phase 4
  review.

## Decisions log

- **2026-09-24, Phase 1:** A9 collided with 3 `pipeline-paper` tests that add two features through the CLI. The human
  chose to keep A9 in `addFeature` (CLI and dashboard) and change only how those tests create their second feature.
  A failed `Orchestrator.start` now releases its own lock (reviewer ruling h); without that, a long-lived dashboard
  would have seen its own live PID and reported `external` forever. Deferred to Phase 4: move `OrchestratorHostDeps`
  so `src/orchestrator` doesn't type-import from `src/cli`.
- **2026-09-24, baseline:** the installed Claude Code auto-updated to 2.1.280, so the 3 CLI version-pin tests fail
  (pin 2.1.276). They are unrelated to this feature and carried as a known baseline. Repairing them takes a paid
  re-probe, which the human decides; it is required before any real-agent run.

- **2026-09-24, devils-advocate:** a second feature can't be added while one is active; this is
  enforced in `addFeature` for both CLI and dashboard (A9). The heartbeat fix is part of this
  feature, Phase 1, with its own commit and ledger row (A8). Runs are addressed by `runId` (A10).
  The loop's sleep is interruptible and actions wake it. A second Ctrl-C force-stops. Form fields
  are never replaced while focused or dirty.

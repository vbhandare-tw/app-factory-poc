# App Factory Dashboard — Technical Spec

- **Feature ID:** `factory-dashboard`
- **Gate:** 2 (Analyse) — approved 2026-09-24
- **Companion:** `docs/features/factory-dashboard-nontechnical.md` (user journeys J1–J8)
- **Replaces:** the M7 row of `factory-m1-m3-technical.md` §0 ("Web dashboard, SSE, `.runs`
  viewer"), pulled forward ahead of M4–M6. `status --watch` TUI is **not** in scope.
- **Doc precedence:** ADRs 001–004 > this spec. Where this spec and `factory-m1-m3-technical.md`
  disagree on the dashboard, this spec wins. That document only reserved seams.

---

## 0. Scope

| In | Out |
|---|---|
| `factory dashboard` command: local HTTP server + orchestrator hosted in-process | Multi-project switcher |
| Read views: overview, feature, ticket, live transcript, gate output, activity feed | Editing any vault note from the page |
| Actions: approve, reject, add feature, start, stop, kill / clear kill | Remote access, auth, TLS |
| Live updates over SSE | `status --watch` TUI |
| Final-acceptance review data (commits, diffstat, gate results) | Full inline diff viewer (diffstat + commit list only) |
| Desktop notification + tab-title badge | Webhooks / email (M6) |
| `factory demo`: scripted runner on a throwaway toy repo, $0 | Any M4–M6 behaviour (parallel devs, feature DAG, QA Lead) |

Hard constraints carried from M1–M3:

- **ADR-002:** the only writers remain the orchestrator and the `src/orchestrator/actions.ts`
  functions. The HTTP layer calls those, never `Storage.writeNote` directly.
- **No new runtime npm dependencies.** `node:http`, `node:fs`, `node:crypto` only. The
  frontend is plain HTML/CSS/ES modules with **no build step**.
- **Everything is unit-testable without a browser.** Handlers are pure-ish functions over an
  injected context, following the `CliDeps` pattern.
- macOS only, like the rest of the factory.

---

## 1. Constants & roles

New file `src/dashboard/constants.ts`:

| Constant | Value | Why |
|---|---|---|
| `DASHBOARD_HOST` | `'127.0.0.1'` | Loopback only. Never `0.0.0.0` or `localhost` (which can resolve to `::`). |
| `DEFAULT_DASHBOARD_PORT` | `4317` | Arbitrary, unlikely to clash. Overridable with `--port`. If busy → fail with a clear message, no auto-increment (a silent port change breaks bookmarks). |
| `ALLOWED_HOSTS` | `['127.0.0.1:<port>', 'localhost:<port>']` | `Host` header allowlist against DNS rebinding (§2). |
| `SSE_HEARTBEAT_MS` | `15_000` | Keeps idle connections open through the browser's timeouts. |
| `WATCH_DEBOUNCE_MS` | `250` | Collapses bursts of vault writes (one transition writes the note, `index.md`, `NEEDS_HUMAN.md`). |
| `TRANSCRIPT_PAGE_LINES` | `400` | Initial slice of a transcript; older lines on request. |
| `TOOL_RESULT_PREVIEW_CHARS` | `2_000` | Tool results are truncated in the readable view; raw view is untruncated. |
| `DEMO_STEP_DELAY_MS` | `3_000` | Demo agents pause so the UI visibly moves. |

**Roles:** no new agent roles. The existing `Role` union (`src/domain/roles.ts`) is reused for
display labels. New display-only map `ROLE_LABELS` in `src/dashboard/labels.ts`
(`tl_plan → 'Tech Lead'`, `dl → 'Delivery Lead'`, …) plus `PAUSE_REASON_LABELS`
(`attempts_exhausted → 'Failed 3 times'`, …) and `EVENT_SUMMARIES`, a map from `FactoryEvent['type']`
(56 types, `src/log/events.ts`; Phase 1 added `lock_heartbeat_failed`) to a one-line plain-English formatter. Unknown types fall back to
the raw type name, so a new event type never breaks the feed.

**Runner kind:** `runner` gains a third value, `"demo"`, in `ConfigSchema`
(`src/config/schema.ts`, currently `claude-code | mock`). See §7.

---

## 2. Permissions

There are no user roles. It's one local operator, which is why no permission keys are added. Access is
controlled at the network and origin level instead. Every rule below is a test case.

1. **Bind** to `127.0.0.1` only.
2. **Host allowlist:** reject any request whose `Host` header isn't in `ALLOWED_HOSTS` → `421`.
   This defeats DNS rebinding (a public site resolving its own name to 127.0.0.1).
3. **Mutation token:** at launch the server generates `sessionToken = randomBytes(32)`. It's
   injected into the served `index.html` as a `<meta>`. Every `POST` must send
   `X-Factory-Token: <token>` → else `403`. A cross-site page can't read the token (same-origin
   policy), and can't set a custom header on a no-CORS request, which blocks CSRF against
   approve/merge.
4. **No CORS headers**, ever. `OPTIONS` → `405`.
5. **Path confinement:** any endpoint that reads a file by name resolves it through
   `VaultPaths` (`logPath`, `gateLogPath`, `featureNote`, `ticketPath`) and then checks
   `realpath` is inside `paths.logsDir()` / `paths.featuresDir()`. The client never sends raw
   paths. It sends `{slug, itemId, attempt, role}` tuples. `VaultPaths.isSafeSegment` is
   already the segment validator.
6. **Mutation serialisation:** all `POST` handlers go through one in-process `Mutex`, so two
   browser tabs can't interleave `approve` on the same item (§4).

---

## 3. UI components

No UI exists today, so everything is new. Location: `dashboard-ui/` in the package root (static, served as-is; see Packaging).

**Packaging [NEEDS VERIFICATION]:** `tsconfig.build.json` compiles only `src/**/*.ts` into
`dist/`, so static files don't reach `dist/`. The proposal is to keep the UI at
`dashboard-ui/` in the package root and resolve it from the server as
`new URL('../../dashboard-ui/', import.meta.url)`, which resolves identically from `src/dashboard/` and
`dist/dashboard/`. That's the same trick `readManifest()` in `src/cli/main.ts` uses for
`package.json`. No build step and no copy script.

Files (vanilla ES modules, no framework):

| File | Responsibility |
|---|---|
| `dashboard-ui/index.html` | Shell: top bar, left feature list, `<main>` outlet; `<meta name="factory-token">` placeholder the server fills. |
| `dashboard-ui/app.js` | Hash router, fetch wrapper (adds token header, maps errors), SSE client, store. |
| `dashboard-ui/store.js` | Single state object `{ status, features, feature?, item?, runs, activity[] }` + `subscribe/set`. |
| `dashboard-ui/views/overview.js` | Waiting-for-you cards, running-now panel, features table with stage strip, activity feed (J1). |
| `dashboard-ui/views/feature.js` | Header + tabs: Overview / Plan / Tickets board / History (J4). |
| `dashboard-ui/views/ticket.js` | Criteria, implementation / review / QA notes, gate results, history (J4). |
| `dashboard-ui/views/run.js` | Live readable transcript with follow-tail, raw toggle, "show earlier" (J4). |
| `dashboard-ui/views/review.js` | Checkpoint / escalation review page, reply box, Approve / Send back, in-page confirm (J5, J6). |
| `dashboard-ui/views/add-feature.js` | Form with slug preview, validation (J2). |
| `dashboard-ui/components/*.js` | `stageStrip`, `pill`, `gateBadge`, `confirmDialog`, `markdown` (a minimal renderer: headings, lists, code fences, inline code, bold, links, and **escapes all HTML**), `toast`. |
| `dashboard-ui/styles.css` | Tokens, light and dark. |

**Markdown rendering is an injection surface.** Vault notes contain agent-written text.
`markdown.js` must escape everything and only emit a fixed allowlist of elements. No
`innerHTML` with unescaped content anywhere. That's a test case.

**Existing code reused on the server side (not UI):**

| Existing | Reused for |
|---|---|
| `runStatus` → `StatusReport` (`src/cli/status.ts`) | `/api/state`. The report-building half is extracted into `buildStatusReport(vaultPath, deps)` so the CLI and HTTP share it; `formatReport` stays in the CLI. |
| `approve`, `reject`, `kill`, `clearKill` (`src/orchestrator/actions.ts`) | The action endpoints, unchanged. |
| `openVault` (`src/cli/resolve.ts`) | Builds the `ActionContext` (including `ShellGit`, needed for final-acceptance merge). |
| `scanVault` (`src/orchestrator/scan.ts`), `MarkdownStorage` | Feature and ticket detail endpoints. |
| `collectNeedsHuman` (`src/orchestrator/views.ts`) | Waiting-for-you payload with `resume_to` / `reject_to`, so the UI can hide **Send back** when `reject_to` is null (J6). |
| `RunRegistry` / `.runs/*.json` (`src/log/runs.ts`) | Running-now panel. |
| `StreamCollector` / `JsonlLineSplitter` (`src/runner/streamParse.ts`) | Line splitting for transcript tailing. |
| `readInstanceLock`, `evaluateLock` (`src/orchestrator/lock.ts`) | Deciding "hosted here" vs "running elsewhere" vs "stopped". |

---

## 4. State management

### 4.1 Server: one `DashboardHost`

New `src/dashboard/host.ts`. It owns everything that lives for the life of the dashboard process:

```
DashboardHost
  vault: VaultScope                 (from openVault)
  orchestrator: OrchestratorHandle | null
  mode: 'hosted' | 'external' | 'stopped'
  bus: ChangeBus                    (fan-out to SSE clients)
  mutex: Mutex                      (serialises every POST)
  sessionToken: string
```

**Hosting the orchestrator.** `runStart` (`src/cli/start.ts`) currently does validation →
lock → runner → `Orchestrator.start` → `run()` → shutdown, inline and tied to process signals.
It gets split:

- `src/orchestrator/host.ts` (new): `startOrchestrator(scope, deps): Promise<OrchestratorHandle>`
  containing everything up to and including `Orchestrator.start`, and returning
  `{ run(): Promise<CycleReport[]>, requestStop(), shutdown(), events: EventLog }`.
- `runStart` becomes: `startOrchestrator` + install SIGINT/SIGTERM → `requestStop` + `run()` +
  `shutdown()`. **Its behaviour and output are unchanged.** The existing `start` tests are the
  regression guard.
- `DashboardHost.start()` calls `startOrchestrator` and runs `run({ sleep })` in the
  background, with an interruptible sleep: `host.wake()` (called after every successful write)
  ends the wait between cycles at once. `DashboardHost.stop()` calls `requestStop()` and
  resolves when `run()` settles (the UI shows "Stopping…" meanwhile). `forceStop()` aborts the
  running agent via the orchestrator's `AbortController` (second Ctrl-C, or **Stop now** in
  the page).
- **Prerequisite fixed in plan Phase 1 (A8):** the orchestrator refreshes its lock heartbeat
  on a timer, not only once per cycle, so a long agent run no longer makes a live lock look
  stale.

**Modes:**

| Mode | Detected by | Start / Stop | Approve / Reject / Add |
|---|---|---|---|
| `hosted` | We hold the instance lock | Enabled | Enabled |
| `external` | Lock held by a **live PID** that isn't us (a terminal `factory start`). PID liveness is authoritative; heartbeat age is displayed but never enables Start (plan A8) | Disabled, with reason | Enabled (same as CLI today) |
| `stopped` | No lock record, or its PID is dead | Start enabled | Enabled |

Mode is re-evaluated on every lock-file change event and on a 5 s timer.

**Why approve is safe while the loop runs** (verified in Gate 1): `actionableItems`
(`src/orchestrator/loop.ts:564`) never claims a `needs_human` item, and `approve` / `reject`
only act on `needs_human` items. The only shared writes are `index.md` / `NEEDS_HUMAN.md` via
`refreshViews`. Both sides regenerate them from a fresh scan, so the last writer wins with
correct content. In `hosted` mode the mutex additionally keeps two tabs from racing each other.
[NEEDS VERIFICATION]: confirm `refreshViews` uses `atomicWrite` so a concurrent reader never
sees a half-written file.

### 4.2 Change detection → `ChangeBus`

Sources, all funnelled into `bus.emit({ kind, ... })`:

1. **Hosted:** a tee `EventSink` wrapped around the orchestrator's `EventLog`. Every
   `FactoryEvent` goes to the file *and* the bus with zero latency.
2. **External / stopped:** tail `logs/orchestrator.jsonl` (`fs.watch` + read from last offset,
   split with `JsonlLineSplitter`). *Corrected during Phase 4:* CLI approvals do **not** emit
   `item_transitioned` (`openVault`'s `ActionContext` has no `events`), so in these modes an
   approval reaches the page only as `state_changed` from the vault watcher. In `hosted` mode the
   dashboard's approvals pass the orchestrator's own `EventSink`, so they do appear in the feed.
3. **Vault files:** `fs.watch(paths.featuresDir(), { recursive: true })` (supported on macOS)
   + `.runs/` + the instance lock + `.kill`, debounced `WATCH_DEBOUNCE_MS` → `{ kind: 'state_changed' }`.

**Client contract:** SSE messages are either `event` (a log line, appended to the activity
feed) or `state_changed` (refetch `/api/state`, plus the current detail view if the payload's
`itemIds` touch it). The client never builds state from events; the events are for the feed
only. Refetching keeps the client trivially consistent.

### 4.3 Client

A single store (`store.js`), with views subscribing to it. There's no local-only state beyond the
current route, form drafts (kept in memory while the form is open) and the "follow tail"
flag. Notification permission and "Not now" are remembered in `localStorage` (try/catch).

---

## 5. API

All under `/api`, JSON, served by `src/dashboard/server.ts` (`node:http`) with a tiny router
`src/dashboard/router.ts` (method + path pattern → handler). Handlers live in
`src/dashboard/handlers/*.ts` and take `(req: ParsedRequest, host: DashboardHost)`, returning
`{status, body}`. The whole thing is testable without sockets.

### Reads

| Method & path | Returns | Built from |
|---|---|---|
| `GET /api/state` | `StatusReport` + `{ mode, demo: boolean, killed: boolean, totalCostUsd, needs_human[]: +resume_to, reject_to, pause_detail, paused_at }` | `buildStatusReport`, `collectNeedsHuman`, lock |
| `GET /api/features/:slug` | Frontmatter + body split into named sections (`SECTION` constants from `src/agents/context.ts` / `SECTION_ORDER` in `storage.ts`) + parsed `## History` + ticket summaries + `tech-plan.md` | `MarkdownStorage`, `scanVault` |
| `GET /api/items/:id` | Ticket (or feature) note, sectioned, same shape | `findItem` (`actions.ts:800`) |
| `GET /api/items/:id/runs` | Past runs and gate logs for the item: `{runId, role, attempt, startedAt, finished, ok, costUsd}` and `{gateLogId, gate, status}` | `RunIndex`, built from `run_started` / `run_finished` / `gate_result` events (plan A10) |
| `GET /api/runs/active` | `.runs/*.json` entries with elapsed time | `RunRegistry` dir |
| `GET /api/runs/:runId/transcript[?before=<line>]` | `{ steps: TranscriptStep[], rawLines?, firstLine, lastLine, finished }` | `RunIndex` → `logPath` → `confine()` → `src/dashboard/transcriptView.ts` |
| `GET /api/gate-logs/:gateLogId` | Plain text, capped | `RunIndex` (the `gate_result` event's `logPath`) → `confine()` |
| `GET /api/features/:slug/delivery` | `{ baseBranch, featureBranch, commits[{sha,subject}], diffstat[{file,added,removed}], gateResults }` (only meaningful at `awaiting_feature_close` / final checkpoint) | `ShellGit`: `log base..feature`, `diff --numstat base...feature` [NEEDS VERIFICATION: whether `Git` interface already exposes these or needs two methods] |
| `GET /api/activity?limit=100` | Last N `LoggedEvent`s, newest first, with `summary` pre-rendered | tail of `orchestrator.jsonl` + `EVENT_SUMMARIES` |
| `GET /api/stream` | SSE: `event`, `state_changed`, `heartbeat`, `transcript_line` (for subscribed runs) | `ChangeBus` |
| `GET /api/stream?run=<runId>` | Same stream, also pushing new lines of that transcript as `TranscriptStep`s | `fs.watch` on that one file |

### Writes (all require `X-Factory-Token`, all serialised by the mutex)

| Method & path | Body | Calls | Success | Errors |
|---|---|---|---|---|
| `POST /api/items/:id/approve` | `{ note?: string }` | `approve(ctx, id, note)` | `200 ActionResult` + `{ held: boolean }` (`to === 'awaiting_feature_close'` → standing approval message) | `ActionError` → `409 {message}` (already handled, not paused, stale verdict, merge conflict). The UI shows `message` verbatim. |
| `POST /api/items/:id/reject` | `{ reason: string }` | `reject(ctx, id, reason)` | `200 ActionResult` | empty reason → `400`, `ActionError` → `409` |
| `POST /api/features` | `{ name, priority, requirement }` | new `addFeature(scope, input)` extracted from `runFeatureAdd` (`src/cli/featureAdd.ts`); the CLI keeps reading a file and calls the same function with the file contents | `201 {id, slug}` | bad slug / duplicate → `400` / `409`; **another feature not `done` → `409`** (one active feature until M4, plan A9; the CLI refuses the same way) |
| `POST /api/factory/start` | — | `host.start()` | `202` | mode `external` → `409`; startup validation failures → `422 {failures[]}` |
| `POST /api/factory/stop` | `{ force?: boolean }` | `host.stop()`, or `host.forceStop()` when `force` | `202` | not hosted → `409` |
| `POST /api/factory/kill` | — | `kill(paths)` | `200` | — |
| `POST /api/factory/resume` | — | `clearKill(paths)` | `200` | — |

**Not added:** any endpoint that writes a note field, edits a section, or changes config.

### Transcript view model (`src/dashboard/transcriptView.ts`)

Pure function `toSteps(lines: string[]): TranscriptStep[]` over the stream-json events the
runner writes (verified on a real developer log: `system`/`init`, `assistant` with `text` /
`thinking` / `tool_use` content blocks, `user` with `tool_result`, `rate_limit_event`, a final
`result`):

```ts
type TranscriptStep =
  | { kind: 'start'; model: string; tools: string[] }
  | { kind: 'say'; text: string }
  | { kind: 'think'; text: string }              // hidden by default in the UI
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; preview: string; truncated: boolean }
  | { kind: 'deliver'; attempt: number }         // StructuredOutput tool call
  | { kind: 'end'; ok: boolean; costUsd?: number; durationMs?: number; turns?: number; reason?: string }
  | { kind: 'unknown'; raw: string };
```

`summary` per tool: `Read` → `Read <file_path>`, `Bash` → `Ran <command>`, `Edit` / `Write` →
`Edited <file_path>`, `Grep` / `Glob` → `Searched <pattern>`. Malformed JSON lines become
`unknown`, never a throw. Gate logs are plain text and shown as-is.

---

## 6. Routing

**Server:** `/` → `index.html` (token injected). `/assets/*` → files under `dashboard-ui/`
(path-confined, content types by extension). `/api/*` → router. Anything else → `404`.

**Client (hash routes, no history API):**

| Route | View |
|---|---|
| `#/` | Overview |
| `#/new` | Add feature |
| `#/f/:slug` (`?tab=overview\|plan\|tickets\|history`) | Feature |
| `#/i/:id` | Ticket |
| `#/review/:id` | Checkpoint / escalation review |
| `#/run/:runId` | Live / past transcript (runs are addressed by `runId`; see plan A10) |

No guards: the only "guard" is that `#/review/:id` for an item that's no longer `needs_human`
shows "Already handled" with a link to the item.

**CLI routing:** two new commands in `buildProgram` (`src/cli/main.ts`):

- `factory dashboard [project] [--vault <p>] [--port <n>] [--no-open] [--start]`:
  resolves the vault like every command and starts the host. **It does not start the orchestrator
  for a real project** (decided at Gate 2: opening the page must never start spending on real agents);
  the user clicks Start. `--start` opts in. `factory demo` always auto-starts, since demo runs cost $0. It opens the browser via `open <url>` (macOS) unless
  `--no-open`, prints the URL, and on SIGINT/SIGTERM does `host.stop()` then closes the server.
- `factory demo [--port <n>] [--no-open] [--fresh]`: see §7.

---

## 7. Configuration

**`ConfigSchema` (`src/config/schema.ts`):**
- `runner`: `'claude-code' | 'mock'` → `'claude-code' | 'mock' | 'demo'`.
- No `dashboard` key. Port is a CLI flag only, keeping `config.yml` about the factory, not the
  viewer. (The schema is `strictObject`, so this also avoids touching every config fixture.)

**`makeRunner` (`src/cli/start.ts`, moving to `src/orchestrator/host.ts`):** `runner: demo` →
`DemoRunner`.

**Demo mode:**
- `src/runner/demo.ts`: a production `Runner` that promotes the essence of
  `scriptedAgents` (`test/helpers/devLoopFixtures.ts`): each step writes real files into the
  run's cwd and returns a canned structured payload. It adds `DEMO_STEP_DELAY_MS` (abortable)
  and writes a short synthetic stream-json transcript per run, so the live view has something to
  show. It registers in `.runs/` like the real runner.
- `src/runner/demoScript.ts`: one canned feature against the toy app. It reuses the shape of
  `MOCK_BREAKDOWN` in `test/integration/acceptance.test.ts` (4 tickets, 2 independent, one
  module each). *Corrected during Phase 6:* in M1–M3 the loop takes each ticket to `done` before
  the next leaves `backlog`, so a file two tickets both wrote would never conflict. The later
  ticket would silently overwrite the earlier one's work on `main`. Distinct modules rule that
  out today, and will also rule out merge conflicts once M4 runs tickets in parallel. The demo
  E2E checks that `main` holds every scripted file byte for byte. Payloads must validate against the real role
  schemas in `src/agents/schemas.ts`. That's a test.
- `factory demo`: copies `fixtures/toy-app` to `~/.app-factory/demo/repo` (git init, commit),
  `factory init`s a vault at `~/.app-factory/demo/vault` with `runner: "demo"`, adds the demo
  feature, then runs `factory dashboard` on it. `--fresh` deletes and recreates both. It's
  registered in the project registry as `demo` [NEEDS VERIFICATION: whether registering
  pollutes `factory projects`; alternative is not registering and always passing `--vault`].
- `GET /api/state` returns `demo: true` when `config.runner === 'demo'`, which drives the
  **DEMO** badge.
- `fixtures/toy-app` must be reachable from the installed package: same `import.meta.url`
  resolution as the UI. (The package is `private` and run from the repo via `npm link`, so this
  holds.)

**`package.json`:** no dependency changes. `lint` must cover `dashboard-ui/**/*.js`
(browser globals). [NEEDS VERIFICATION] against `eslint.config.js`.

---

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Port in use | Exit non-zero: "Port 4317 is in use — pass `--port`." |
| Vault resolution / config error | Exit non-zero before binding, same messages as other commands. |
| `startOrchestrator` validation fails in hosted mode | Server stays up, mode `stopped`, `GET /api/state` carries `startupFailures[]`, UI shows them (J1 edge case). |
| Orchestrator `run()` rejects (crash) | Host catches, logs, sets mode `stopped` with `lastError`, emits `state_changed`. The server doesn't die. Claims are recovered on the next start (existing crash recovery). |
| SSE client disconnects | Removed from bus. Client auto-reconnects (EventSource default) and refetches state. |
| Handler throws a non-`ActionError` | `500 {message}`, logged. Never an HTML stack trace. |
| Transcript file missing | `404` with "no transcript for this run (it may not have started)". |

---

## 9. Testing approach (detail belongs in Gate 3)

- **Unit:** `transcriptView.toSteps` on the real kept transcripts under
  `.factory-test-repos/acceptance-logs/real/…` (copied into `test/fixtures/`), plus malformed
  lines; `EVENT_SUMMARIES` covers every `FactoryEvent['type']` (compile-time exhaustiveness);
  router; host-header / token / path-confinement checks; `markdown.js` escaping (run under
  vitest with a DOM-free string renderer).
- **Integration:** in-process server on port 0 with a `MockRunner` or `DemoRunner` vault:
  approve / reject / add-feature / start / stop round-trips; SSE delivers `state_changed` after a
  CLI-side `approve`; `external` mode when a second process holds the lock.
- **Demo end-to-end:** `factory demo --no-open` drives intake → done with three approvals via
  HTTP only, and asserts the tag exists. This is the dashboard's acceptance test, and it's free.
- **Browser:** one manual smoke pass (or Claude-in-Chrome) at the end. No browser test
  framework is added.

---

## 10. Files touched (summary)

**New:** `src/dashboard/{constants,labels,host,server,router,changeBus,transcriptView,security}.ts`,
`src/dashboard/handlers/*.ts`, `src/orchestrator/host.ts`, `src/runner/{demo,demoScript}.ts`,
`src/cli/{dashboard,demo}.ts`, `dashboard-ui/**`.

**Modified:** `src/cli/start.ts` (split into `startOrchestrator`), `src/cli/status.ts`
(extract `buildStatusReport`), `src/cli/featureAdd.ts` (extract `addFeature`),
`src/cli/main.ts` (two commands), `src/config/schema.ts` (`runner: demo`),
`vault-template/config.yml` (comment lists `demo`), `README.md` (dashboard section),
`eslint.config.js` (browser globals for `dashboard-ui/`), possibly `src/git/git.ts` (log /
numstat helpers).

**Unchanged by contract:** `src/orchestrator/actions.ts`, the loop, dispatch, gates, merge
and feature close. The dashboard is a consumer of those, not a modification.

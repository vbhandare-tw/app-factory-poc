# App Factory — Technical Spec (M1–M3)

- **Feature ID:** `factory-m1-m3`
- **Source requirement:** `App Factory - REQUIREMENTS.md` v1.0
- **Gate:** 2 (Analyse) — approved scope from Gate 1
- **Status:** awaiting approval

---

## 0. Scope boundary

In scope (M1–M3):

| Milestone | Delivers |
|---|---|
| M1 | Vault template, note parser/serializer, state machine, DAG resolver, project resolution + registry, startup validation, `factory init/status/projects` |
| M2 | Orchestrator poll loop (single-threaded), PM → TL → DL on a paper feature, human checkpoints, `needs_human`, `factory start/stop/feature add/approve/reject/kill` |
| M3 | Developer → gates → Code Reviewer → QA → merge to feature branch, in a git worktree, with attempt limits |
| M3+ | **Pulled forward from M5:** final-acceptance checkpoint, `feature/<slug>` → base merge, tag, feature `done` |

Explicitly deferred:

| Deferred | Milestone |
|---|---|
| Parallel developers, locking under contention, full `compareWorkItems` ranking (§8.1) | M4 |
| Feature-level dependency DAG, `blocked` status, `max_active_features` | M4 |
| QA Lead regression, evidence pack, `pm_review` | M5 |
| Kill-switch polish, webhook notify, malformed-file fuzzing | M6 |
| Web dashboard, SSE, `.runs` viewer, `status --watch` TUI | M7 |

M1–M3 ends with: every ticket of one feature merged into `feature/<slug>`, all gates green, the feature paused at the final-acceptance checkpoint, and — on `factory approve` — merged into the base branch, tagged, and marked `done`. Feature close *without* a human (QA Lead regression and automated PM review) stays in M5; the human-approved path is in scope so the POC has a visible finish line.

---

## 1. Stack

- **Runtime:** Node.js 22 LTS (v22.13.0 present), TypeScript 5.x, ESM (`"type": "module"`).
- **CLI:** `commander`.
- **YAML:** `yaml` (eemeli) for both `config.yml` and frontmatter serialization. `gray-matter` is used for *splitting* a note into frontmatter/body only — see §7.2 for why we do not use it to write.
- **Schema/validation:** `zod` v4, using native `z.toJSONSchema()` to feed `claude --json-schema`. One schema definition drives both runtime validation and the CLI's structured-output contract.
- **Process spawning:** `node:child_process.spawn` directly (not `execa`) — we need fine control of stdio, stdin redirection, and kill-on-timeout.
- **Tests:** `vitest`.
- **Logging:** hand-rolled JSONL writer over `fs.createWriteStream` (no pino — we need exact line-buffered control for M7 tailing).

No dependency on the Claude Agent SDK in M1–M3; the `Runner` interface (§8.1) exists so it can be added later without touching the orchestrator.

---

## 2. Repository layout

```
app-factory-poc/
├── src/
│   ├── cli/                 # commander command definitions, one file per command
│   ├── config/              # config.yml loader, ~/.app-factory/projects.yml registry, resolution order
│   ├── vault/               # paths, atomic write, note parse/serialize, index.md regeneration
│   ├── domain/              # types, state machines, transition table, DAG, ID generation
│   ├── orchestrator/        # poll loop, scanner, scheduler, claim/lock, reconciler
│   ├── runner/              # Runner interface, ClaudeCodeRunner, MockRunner
│   ├── agents/              # role registry: profile + context recipe + output schema per role
│   ├── gates/               # gate runner, result capture
│   ├── git/                 # worktree lifecycle, branch, merge
│   └── log/                 # JSONL event log, transcript writer, .runs registry
├── prompts/                 # <role>.md — system prompt per role, shipped with the factory
├── vault-template/          # skeleton copied by `factory init`
├── fixtures/toy-app/        # the tiny Node target repo used by tests and the POC run
└── docs/
    ├── adr/
    └── features/
```

---

## 3. Constants & roles

### 3.1 Roles

`src/domain/roles.ts`:

```ts
export const ROLES = ['pm', 'tl_plan', 'dl', 'developer', 'code_reviewer', 'qa'] as const;
export type Role = typeof ROLES[number];
```

`tl_merge` and `qa_lead` from the requirements doc are **not** roles in M1–M3:

- **Merge is deterministic, not an agent.** Merging a ticket branch into the feature branch is `git merge --no-ff`. The orchestrator does it. On a conflict, the ticket goes to `needs_human`. Handing an LLM write access to the shared feature branch to resolve conflicts is the single highest-blast-radius action in the whole system, and it buys nothing at POC scale. *(Deviation from §7 and §6.2 — flagged for approval.)*
- **`qa_lead`** belongs to feature close (M5).

### 3.2 Feature states

`src/domain/states.ts`:

```ts
export const FEATURE_STATES = [
  'intake', 'refining', 'planning', 'ticketing',
  'in_development', 'awaiting_feature_close',
  'needs_human', 'done',
] as const;
```

`blocked`, `regression`, and `pm_review` are declared in the type but unreachable in M1–M3 (no transition targets them). Declaring them now avoids a breaking enum change in M4/M5. `done` means merged to base and tagged, so there is no separate `deployed_ready` state.

### 3.3 Ticket states

```ts
export const TICKET_STATES = [
  'backlog', 'ready', 'in_progress', 'gates',
  'code_review', 'qa', 'merge', 'done', 'needs_human',
] as const;
```

`gates` and `merge` are orchestrator-executed, not agent-executed. They are still modelled as states so `## History` and (later) the dashboard read coherently, and so a crash mid-gate is recoverable.

### 3.4 The `needs_human` problem

The requirements doc overloads `needs_human` for two different things: an agent escalating because it is stuck, and a planned approval checkpoint. They need different resume behaviour, so the status alone is not enough. Both write these frontmatter fields:

```yaml
status: needs_human
pause_reason: checkpoint | escalation | attempts_exhausted | timeout | merge_conflict | malformed_output
pause_detail: "free text shown to the human"
resume_to: planning        # status to move to on `factory approve`
reject_to: refining        # status to move to on `factory reject`
paused_at: 2026-08-31T10:00:00Z
```

`factory approve <id>` sets `status = resume_to`; `factory reject <id> "<reason>"` sets `status = reject_to` and appends the reason to the body, where the next agent run will read it.

### 3.5 Human checkpoints (three, per Gate 1)

| Checkpoint | Fires when | `resume_to` | `reject_to` |
|---|---|---|---|
| `after_pm_refinement` | PM finishes, feature leaves `refining` | `planning` | `refining` |
| `after_ticket_breakdown` | DL finishes, before any code | `in_development` | `ticketing` |
| `final_acceptance` | all tickets `done`, feature branch gates green | `done` — triggers feature → base merge + tag | `in_development` |

All three default ON, each toggleable in `config.human_checkpoints`.

### 3.6 ID generation

`src/domain/ids.ts` — pure, deterministic:

- Feature: `FEAT-` + slug uppercased, non-alphanumerics → `-`, collapsed, trimmed. `user-auth` → `FEAT-USER-AUTH`.
- Ticket: `<featureId>-T` + zero-padded 3-digit ordinal, allocated by the DL pass in file order. `FEAT-USER-AUTH-T003`.
- Run: `<ticketId|featureId>-<role>-a<attempt>-<counter>`. Deterministic, not random — needed for reproducible tests and for `.runs/<run-id>.json` filenames. The counter is a per-process monotonic integer.

---

## 4. Permissions — agent isolation

This section replaces the requirements doc's §7 permission model, which does not hold. All findings below were verified empirically against Claude Code **v2.1.220** on macOS 24.6.0. Re-verify on CLI upgrade; see §14 for the reproduction commands.

### 4.1 What does not work

| Assumption in the requirements doc | Reality |
|---|---|
| `--allowedTools` scopes an agent to its worktree | False. It gates *which tools* may run, not *which paths* they touch. A `Bash`-enabled agent read and wrote outside its cwd freely. |
| `--cwd <worktree>` | No such flag. Set the child process's `cwd` in `spawn()`. |
| `Read(...)` deny rules fence the filesystem | Partial only. They cover Claude's built-in file tools and shell commands Claude Code recognises (`cat`, `head`, `tail`, `sed`). A `node -e "fs.readFileSync(...)"` outside the worktree **succeeded with zero entries in `permission_denials`**. Any `npm test` script can do the same. |
| `permission_denials` in the JSON result is an audit trail | Unreliable. It was empty in cases where access was actually blocked. Do not use it for enforcement decisions; log it as a hint only. |

### 4.2 What does work

**OS-level sandbox.** `sandbox.enabled: true` passed via `--settings` uses macOS Seatbelt and is enforced by the kernel for the Bash tool **and all its child processes**.

- **Writes** are confined by default to the process cwd, `$TMPDIR`, and `/tmp/claude*`. A build script that wrote to a sibling directory failed with `Error: EPERM: operation not permitted`.
- **Reads** are open by default. To fence them: `filesystem.denyRead: ["~/"]` plus `filesystem.allowRead: ["<worktree>", ...]`. Verified — a `node` subprocess reading a denied path got `EPERM`.
- Path syntax for `sandbox.filesystem.*` is **standard** (`/abs`, `~/`, bare = relative). This differs from `permissions.*` rules, which use `//abs` and `/project-relative`. Getting these two syntaxes confused is the likeliest source of a silently ineffective rule.

**Caution — the temp allowlist is broad.** During verification the sandbox appeared to fail until the probe was moved out of `/private/tmp/claude-*`, which is on the default write allowlist. Never place worktrees under a temp path.

**Context isolation.** By default a headless run inherits `~/.claude/CLAUDE.md`: a probe in an unrelated directory correctly reported the max-lines rule from the user's personal global instructions. Your 4-gate workflow would be injected into every developer agent. `--setting-sources ""` and `--system-prompt` both failed to stop it. **`--safe-mode` does** — the same probe returned `UNKNOWN`.

`--safe-mode` also disables hooks, skills, plugins, MCP servers, and custom agents, all of which we want off for reproducibility, while leaving auth, model selection, built-in tools, and `--settings` working. Verified: `--safe-mode` together with `sandbox.enabled` still produces `EPERM` on an escape attempt.

Do **not** use `--bare` for this. It forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth and never reads OAuth or the keychain, so it breaks subscription auth.

Consequence: the target repo's own `CLAUDE.md` is also suppressed. If we want repo conventions in front of the developer agent, the orchestrator must inject them explicitly as context (§6.2). This is a feature, not a loss — context becomes explicit and testable.

### 4.3 Permission profile per role

`src/agents/profiles.ts`. Every profile is a pure data object; the `Runner` translates it into CLI flags.

```ts
export interface AgentProfile {
  role: Role;
  cwd: 'scratch' | 'repo_scratch_worktree' | 'ticket_worktree';
  tools: string[];              // --tools
  allowedTools: string[];       // --allowedTools
  sandbox: {
    denyReadHome: boolean;
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];        // see §4.5 — the .git fence
  };
  model: string;                // resolved from config.models, see §11
  timeoutMs: number;
  maxBudgetUsd: number;
}
```

| Role | cwd | tools | Writes possible? |
|---|---|---|---|
| `pm` | throwaway scratch dir | *(none)* | No — pure text in, structured text out |
| `tl_plan` | throwaway worktree at base branch | `Read,Grep,Glob` | Discarded worktree |
| `dl` | throwaway worktree at base branch | `Read,Grep,Glob` | Discarded worktree |
| `developer` | `worktrees/<ticket-id>` | `Read,Edit,Write,Grep,Glob,Bash` | Yes — its own worktree only, and it cannot commit (§4.5) |
| `code_reviewer` | throwaway worktree at ticket branch | `Read,Grep,Glob,Bash` | Discarded worktree |
| `qa` | `worktrees/<ticket-id>` | `Read,Grep,Glob,Bash` | Yes — its own worktree only, and it cannot commit (§4.5) |

**Throwaway worktrees** are the mechanism for read-only repo access. Rather than relying on a deny-all `Edit(//**)` glob (unverified, and one syntax slip from being useless), we give the agent a real worktree, let the sandbox confine writes to it, and `git worktree remove --force` afterwards. Anything it wrote is gone. This is robust against every escape route we found.

All profiles get `--safe-mode`, `sandbox.enabled: true`, `denyRead: ["~/"]`, and `allowRead` covering only their cwd plus whatever the toolchain genuinely needs.

**On npm:** an earlier draft predicted that `denyRead: ["~/"]` would break npm, which lives under `~/.nvm` here and reads `~/.npmrc`. Probed: it does not. The sandbox does not block executable loading or npm's own runtime reads. `sandbox_extra_read` / `sandbox_extra_write` remain in the config schema as an escape hatch for target repos whose gates genuinely need outside access, but ship **empty**:

```yaml
sandbox_extra_read: []
sandbox_extra_write: []
```

Startup validation still runs the gate commands inside a sandboxed probe, so a repo that does need extra paths fails at startup rather than as a mystery test failure on ticket 1.

### 4.5 The `.git` fence — agents never commit

The cwd fence alone is not sufficient, and this is the one place where the naive design is actively unsafe.

A linked worktree's `.git` is a *file* pointing at `<repo>/.git/worktrees/<id>`, so the real git directory lives **outside** the worktree. The sandbox permits writes there — it must, or `git commit` inside a worktree could not work at all. Probed from inside a sandboxed ticket worktree with default settings:

| Target | Result |
|---|---|
| Main checkout working files | `EPERM` |
| A sibling ticket's worktree | `EPERM` |
| Home directory | `EPERM` |
| `<repo>/.git/**` | **writable** |

`.git` is shared by every worktree. So under the default fence a Developer agent can rewrite `refs/heads/main` without touching a single file in the main checkout, edit `.git/config`, or drop a `.git/hooks/pre-commit` that later executes **unsandboxed** when the orchestrator runs git in the main repo. That last one is a complete escape from the sandbox into the orchestrator's own permissions, and it defeats requirements §10 ("Developer agents are FORBIDDEN from touching the base branch") and ADR-004 in one step.

**Decision: agents never commit.** The Developer agent edits files and runs tests, leaves the tree dirty, and returns a proposed `commit_message` in its structured output. The orchestrator stages and commits, unsandboxed, after the agent exits. Every profile that touches a repo adds:

```json
"denyWrite": [
  "<repo>/.git/hooks",
  "<repo>/.git/config",
  "<repo>/.git/refs",
  "<repo>/.git/objects"
]
```

Probed with exactly that list: `git status --short` and `git diff` **still work** (the agent keeps full read-only git, which is what it actually needs to review its own changes), while writing a hook, config, ref, or object is `EPERM`, and `git add` fails with `error: unable to create temporary file: Operation not permitted` / exit 128.

Nothing is lost by this. The agent still authors its commit message; the orchestrator merely applies it. And it aligns the repo with ADR-002 — the orchestrator was already the only writer of the vault, and is now the only writer of git history too.

### 4.4 Verified invocation shape

```
claude -p "<task prompt with injected context>"
  --model <config.model>
  --safe-mode
  --output-format stream-json
  --json-schema '<zod-derived JSON Schema>'
  --append-system-prompt "<contents of prompts/<role>.md>"
  --tools "Read,Edit,Write,Grep,Glob,Bash"
  --allowedTools "Read,Edit,Write,Grep,Glob,Bash"
  --settings '{"sandbox":{"enabled":true,"filesystem":{...}}}'
  --max-budget-usd <profile.maxBudgetUsd>
```

spawned with `cwd: <worktree>`, `stdio: ['ignore', 'pipe', 'pipe']`. **stdin must be `'ignore'` or `/dev/null`** — otherwise the CLI stalls 3 seconds waiting for piped input and emits a warning.

---

## 5. Agent output contract

The single most valuable verified finding: `--json-schema` makes the CLI return a **validated** `structured_output` object in its result. Verified working alongside real tool use (3 turns of `Read`/`Bash`, schema honoured). This removes prose parsing from the design entirely.

`src/agents/schemas.ts` — one zod schema per role, each extending a shared base:

```ts
const Base = z.object({
  outcome: z.enum(['ok', 'escalate']),
  escalate_reason: z.string().nullable(),
  notes_markdown: z.string(),        // appended verbatim to the note body
});
```

| Role | Additional fields |
|---|---|
| `pm` | `refined_requirement`, `scope_in[]`, `scope_out[]`, `acceptance_criteria[]`, `questions_for_tl[]` |
| `tl_plan` | `feasibility`, `risks[]`, `phases[]`, `questions_for_pm[]`, `request_refinement: boolean`, `tech_doc_updates[]` |
| `dl` | `tickets[]` — each `{title, description_md, acceptance_criteria[], technical_notes_md, depends_on[]}` |
| `developer` | `summary`, `files_changed[]`, `commit_message`, `tests_added[]` — the agent leaves the tree dirty and *proposes* the message; the orchestrator stages and commits after it exits (§4.5) |
| `code_reviewer` | `verdict: approve \| request_changes`, `findings[]` — each `{file, line, severity, message}` |
| `qa` | `verdict: pass \| fail`, `criteria_results[]` — each `{criterion, result, evidence_command, evidence_output}` |

Rules:

0. **The orchestrator is the only writer of git history.** Agents cannot stage or commit (§4.5). The Developer's work product is a dirty worktree plus a proposed commit message.
1. **The orchestrator is the only writer of the vault.** Agents return structured output; the orchestrator validates it against the same zod schema (belt and braces — the CLI already validated it) and writes the files. This kills the frontmatter race described in requirements §13, makes the sandbox fence trivial (agents need no vault write access at all), and makes every agent run replayable from its recorded output. *(Deviation from §7's "Write vault" column — flagged for approval.)*
2. **The agent's self-reported success is never trusted.** `developer.outcome === 'ok'` does not advance the ticket; the gate run does (§9).
3. `outcome: 'escalate'` → ticket/feature to `needs_human` with `pause_reason: escalation`.
4. Schema validation failure, or `is_error: true`, or a timeout → failed attempt, `attempts += 1`, `pause_reason: malformed_output` if attempts exhausted.

---

## 6. CLI surface

*(This section stands in for "UI components" — M1–M3 has no UI. The dashboard is M7.)*

| Command | Milestone | Behaviour |
|---|---|---|
| `factory init --vault <p> --repo <p> [--name <n>]` | M1 | Copy `vault-template/`, write `target_repo` into `config.yml`, register in `~/.app-factory/projects.yml`, write `refs/factory/owner` marker into the repo |
| `factory projects` | M1 | List registered projects, vault path, running/stopped |
| `factory status [project] [--json]` | M1 | Features by stage, ticket counts, running agents, needs-human queue |
| `factory start [project] [--vault <p>]` | M2 | Startup validation, take instance lock, run poll loop in foreground |
| `factory stop [project]` | M2 | Signal the running instance via its lock file PID; graceful drain |
| `factory feature add <file> [--priority]` | M2 | Create `work/features/<slug>/feature.md` in `intake`, `## Raw Requirement` = verbatim file contents |
| `factory approve <id> ["note"]` | M2 | Resolve a `needs_human` item to its `resume_to` |
| `factory reject <id> "<reason>"` | M2 | Resolve to `reject_to`, append reason for the next agent |
| `factory kill` | M2 | Create `<vault>/.kill` |

`approve`/`reject`/`kill` are implemented as functions in `src/orchestrator/actions.ts` and called by the CLI. The dashboard (M7) calls the identical functions — single write path, as required by §14.

### 6.1 Project resolution

`src/config/resolve.ts`, resolution order exactly as requirements §3.1, implemented as a pure function over an injected filesystem view so all five branches are unit-testable:

1. `--vault <path>` → 2. `[project]` name in registry → 3. cwd is / is inside a vault with `config.yml`, or contains `.factory-vault/` → 4. registry `default` → 5. error listing registered projects.

### 6.2 Context injection

Because agents are fenced out of the vault, `src/agents/context.ts` defines a `ContextRecipe` per role: an ordered list of vault files whose contents are concatenated into the task prompt under labelled fences.

| Role | Injected |
|---|---|
| `pm` | `project.md`, `feature.md` |
| `tl_plan` | `project.md`, `feature.md`, all of `tech/` |
| `dl` | `project.md`, `feature.md`, `tech-plan.md` |
| `developer` | `project.md`, the ticket, `tech-plan.md`, target repo `CLAUDE.md` if present, prior `## Review Notes`/`## QA Notes` on retry |
| `code_reviewer` | the ticket, `tech-plan.md`, `git diff <base>...<ticket-branch>` |
| `qa` | the ticket's acceptance criteria, `project.md` |

The recipe emits a size estimate; over `config.context_warn_chars` (default 200k) the orchestrator logs a warning and truncates the lowest-priority document. Truncation is recorded in the run log — a silently truncated context is a debugging nightmare.

---

## 7. State management — the vault as the store

*(Stands in for "Redux/state" — the vault is the store, the orchestrator is the only reducer.)*

### 7.1 Storage interface

`src/vault/storage.ts` defines the seam that requirements §13 asks for, so SQLite can replace markdown later:

```ts
export interface Storage {
  listFeatures(): Promise<FeatureNote[]>;
  listTickets(featureSlug: string): Promise<TicketNote[]>;
  readNote<T>(path: string): Promise<Note<T>>;
  writeNote<T>(path: string, note: Note<T>): Promise<void>;   // atomic
  appendSection(path: string, heading: string, md: string): Promise<void>;
  appendHistory(path: string, line: HistoryLine): Promise<void>;
}
```

Only `MarkdownStorage` exists in M1–M3.

### 7.2 Note parse / serialize

Round-tripping YAML frontmatter without churn is a real hazard: a serializer that reorders keys, requotes strings, or converts an ISO timestamp into a YAML date object turns every write into a noisy git diff and can silently change a value's type.

`src/vault/note.ts`:

- **Parse:** `gray-matter` to split the `---` fences; `yaml.parse` the frontmatter with `{ schema: 'core' }`.
- **Serialize:** a hand-written field-ordered emitter using `yaml.stringify` per value, writing keys in a fixed canonical order defined in `FRONTMATTER_ORDER`. Unknown keys — a human's Obsidian-added field — are **preserved by value and relative order and re-emitted in canonical form**, appended after the known keys.

  *(Corrected during Phase 3. This originally said "preserve unknown keys verbatim", which is byte-language and contradicted the canonical-form requirement in the same section. Worse, byte preservation would need a side channel outside `Note<T>`, and `applyTransition`'s `{...frontmatter}` spread would silently drop it — destroying exactly what the rule exists to protect. Value-and-order preservation is the version that survives the real write path.)*
- **All timestamps are ISO 8601 strings, quoted**, never YAML dates. In fact **every string value is emitted double-quoted**, not just timestamps: Obsidian's frontmatter reader is YAML 1.1, where a bare `no` becomes `false` and `012` becomes `10`. Quoting everything deletes that entire retype class for the cost of one-time churn on first write — and since the whole frontmatter is rewritten into canonical order on that write anyway, the marginal cost is close to zero.
- Contract test: `parse(serialize(parse(x))) === parse(x)` over a fixture corpus, plus a byte-stability test that a no-op write produces zero diff.

### 7.3 Atomic writes

`src/vault/atomic.ts`: write to `<file>.<pid>.<counter>.tmp` **in the same directory** (rename is only atomic within a filesystem), `fsync` the file handle, `fs.rename`, then `fsync` the directory handle. Orphan `.tmp` files older than an hour are swept at startup.

### 7.4 Locking

Two independent locks:

- **Instance lock** `<vault>/.factory.lock` — JSON `{pid, host, startedAt, heartbeatAt}`, created with the `wx` open flag so creation is atomic. Heartbeat rewritten every poll cycle. A lock is stale when `heartbeatAt` is older than `3 × poll_interval` **or** `process.kill(pid, 0)` throws `ESRCH`. Stale locks are reclaimed with a logged warning. This is a heartbeat, not the 90-minute `lock_ttl` the requirements doc proposes — a crashed orchestrator should not block restart for an hour and a half.
- **Item claim** — `locked_by` / `locked_at` in frontmatter, written atomically then re-read to confirm the claim won. With M1–M3's single-instance guarantee this is belt and braces, but it is the mechanism M4 depends on, so it is built and tested now. `locked_at` older than `config.lock_ttl` is expired at the top of each cycle.

### 7.5 Transitions

`src/domain/transitions.ts` — a declarative table, not scattered `if`s:

```ts
interface TransitionRule {
  from: TicketState; to: TicketState;
  actor: Role | 'orchestrator' | 'human';
  guard?: (ctx: TransitionContext) => GuardResult;
}
```

Enforced guards (requirements §6):

- `backlog → ready` requires every `depends_on` ticket `done`.
- `gates → code_review` requires `gate_results.tests/lint/build` all `pass`. **Hard gate — no role can override, and the reviewer never sees a red ticket.**
- `merge → done` requires a clean `git merge` into the feature branch and green gates on the feature branch afterwards.
- Feature `in_development → awaiting_feature_close` requires every ticket `done`.
- Every applied transition appends a `## History` line (`timestamp | from → to | actor | note`) and bumps `updated_at`, in the same atomic write.

`applyTransition` is pure: `(note, to, actor, { now, note?, ctx? }) => Note`. Persistence is the caller's job. This is what makes the state machine exhaustively unit-testable without touching disk.

**`now` is injected, not read from a clock** (corrected during Phase 2). The transition bumps `updated_at`, and a clock read inside the domain would break both the purity requirement above and the no-I/O boundary, forcing time-mocking on every later phase. The orchestrator owns the write boundary, so it supplies the timestamp.

---

## 8. Internal module contracts

*(Stands in for "API" — M1–M3 exposes no HTTP surface. The dashboard's read-only server is M7.)*

### 8.1 Runner

```ts
export interface Runner {
  run(spec: AgentRunSpec, signal: AbortSignal): Promise<AgentRunResult>;
}

export interface AgentRunSpec {
  runId: string; role: Role; cwd: string;
  prompt: string; systemPromptAppend: string;
  profile: AgentProfile; outputSchema: object;   // JSON Schema
  model: string; transcriptPath: string;
}

export interface AgentRunResult {
  ok: boolean;                    // is_error === false && schema validated
  structured: unknown | null;
  costUsd: number; numTurns: number; durationMs: number;
  sessionId: string; terminalReason: string;
  permissionDenials: unknown[];   // hint only, see §4.1
  failure?: 'timeout' | 'crash' | 'schema' | 'api_error';
}
```

Implementations: `ClaudeCodeRunner` (spawns the CLI) and `MockRunner` (returns canned `structured` payloads from a fixture map keyed by role + ticket). Every test above unit level runs on `MockRunner`; real agent runs are manual end-to-end only.

`ClaudeCodeRunner` uses `--output-format stream-json` so the transcript can be written incrementally, and reads the terminal `result` event for `structured_output`, `total_cost_usd`, `is_error`. [NEEDS VERIFICATION — that `structured_output` appears on the `result` event under `stream-json` as it does under `json`. Verified under `json`. If it does not, fall back to `--output-format json` and accept that the live transcript arrives only at completion, which costs nothing until M7.]

Timeout: `config.agent_timeout` (default 30 min) via `AbortSignal`, then `SIGTERM`, then `SIGKILL` after a 10s grace.

### 8.2 Gate runner

```ts
export interface GateRunner {
  run(cwd: string, gates: GateConfig): Promise<Record<string, GateResult>>;
}
export interface GateResult {
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number; durationMs: number;
  output: string;      // tail, capped at config.gate_output_chars
  logPath: string;     // full output on disk
}
```

Gates run **as orchestrator child processes**, never inside an agent run. Order: `tests` → `lint` → `build`, short-circuiting on first failure. Exit code 0 is the only pass. Coverage threshold is parsed from the configured JSON report; deferred past M3 unless the toy repo needs it.

Gates run in the ticket worktree after the Developer, and on the feature branch after each merge.

### 8.3 Git

```ts
export interface Git {
  createWorktree(path: string, branch: string, fromRef: string): Promise<void>;
  removeWorktree(path: string, force: boolean): Promise<void>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  mergeNoFf(into: string, from: string): Promise<{ok: true} | {ok: false, conflicts: string[]}>;
  diff(baseRef: string, headRef: string): Promise<string>;
}
```

All operations shell out to `git` with explicit `--git-dir`/`-C`; no libgit2 dependency.

---

## 9. Orchestrator loop

`src/orchestrator/loop.ts`, one cycle:

1. If `<vault>/.kill` exists → start nothing new; wait for in-flight runs; log and idle.
2. Refresh instance-lock heartbeat.
3. Scan all feature and ticket notes. **A malformed note is quarantined, not fatal** — record the parse error, set nothing, emit a `note_malformed` event, continue. One bad file must never stop the pipeline.
4. Expire item claims older than `lock_ttl`.
5. Reconcile worktrees against ticket state: any worktree whose ticket is not `in_progress`/`qa` is an orphan and is removed.
6. Compute the actionable set from the transition table's preconditions.
7. Rank with `compareWorkItems`. **M1–M3 implements requirements §8.1 rules 1 and 5** — stage priority (`merge > qa > code_review > in_progress-fix > ready > ticketing > planning > refining/intake`) and the lexicographic tiebreaker, which *is* rule 5. Deferred to M4: rules 2 (fixes before new work), 3 (feature priority and `max_active_features`), 4 (critical path by descendant count), and the starvation guard. The function signature and its test file are written now so M4 is additive.
8. Claim the top item — `max_parallel_devs: 1` in M1–M3, so exactly one.
9. Dispatch: agent-backed states spawn a `Runner`; `gates` and `merge` run in-process.
10. On completion, validate, apply the transition, write the note, append history, regenerate `index.md`, release the claim, emit events.

### 9.1 Failure handling

| Failure | Response |
|---|---|
| Agent timeout or crash | `attempts += 1`, ticket back to `in_progress` |
| Schema validation failure | `attempts += 1`, agent's raw output preserved in the log |
| Red gate | `attempts += 1`, ticket to `in_progress`, gate output injected into the retry context |
| `attempts > max_attempts` | `needs_human`, `pause_reason: attempts_exhausted`, log paths linked |
| Merge conflict | `needs_human`, `pause_reason: merge_conflict` (no agent retry in M1–M3) |
| Orchestrator crash | Restart recovers via stale-lock expiry + worktree reconciliation. A ticket interrupted mid-run resets to its pre-claim state and re-runs. |

Crash recovery correctness rests on every write being atomic and every transition being idempotent — those are the two properties the recovery tests target.

---

## 10. Git strategy

- Integration branch is `config.base_branch`, never assumed to be `main`.
- One feature branch `feature/<slug>`, cut from the effective base at the start of `ticketing`.
- Ticket branches `feat/<slug>/t00N-<short-title>` cut from the **feature branch**.
- Ticket worktrees at `<repo>/../.factory-worktrees/<vault-name>/<ticket-id>` — **outside** the repo (no gitignore needed, no chance of a gate globbing another ticket's tree) and **outside any temp path** (§4.2).
- Merge direction: ticket branch → feature branch (`--no-ff`), by the orchestrator. Feature branch → base is human-triggered by `factory approve` at the final-acceptance checkpoint: gates run on the feature branch first, then `--no-ff` merge into base, then tag `factory/<slug>/<ISO date>`, then feature `done` (= `deployed_ready`, per Gate 1's definition of "merged to base and tagged"). A conflict here escalates rather than retrying.
- On `done`: remove the worktree, delete the ticket branch.

---

## 11. Configuration

`vault-template/config.yml`, validated by a zod schema with defaults; unknown keys are an error naming the key.

```yaml
target_repo: /path/to/repo
vault_version: 1
base_branch: main
runner: claude-code            # claude-code | mock
models:                        # per-role, falling back to `default`
  default: sonnet
  pm: sonnet
  tl_plan: sonnet
  dl: sonnet
  developer: sonnet
  code_reviewer: sonnet
  qa: sonnet
poll_interval: 15
max_parallel_devs: 1           # M1–M3 pins this to 1; M4 raises it
max_parallel_other: 1
agent_timeout: 1800
lock_ttl: 5400
max_attempts: 3
context_warn_chars: 200000
gate_output_chars: 20000
run_budget: null               # warn-only, per Gate 1
max_budget_usd_per_run: 5
sandbox_extra_read: []         # empty by default — see plan resolution A2
sandbox_extra_write: []        # escape hatch only, not needed for npm
human_checkpoints:
  after_pm_refinement: true
  after_ticket_breakdown: true
  final_acceptance: true
gates:
  tests: "npm test"
  lint: "npm run lint"
  build: "npm run build"
```

*(Corrected during Phase 4 execution — `sandbox_extra_read` / `sandbox_extra_write` ship **empty**. This section originally seeded them with `~/.npm`, `~/.npmrc`, and `~/.npm/_cacache` on the assumption that `denyRead: ["~/"]` would break npm. Plan resolution A2 probed it and found npm runs cleanly with no extra config: the sandbox does not block executable loading or npm's own runtime reads. The keys stay in the schema as an escape hatch for a target repo whose gates genuinely need outside access.)*

*(Corrected during Phase 4 execution — the **registry directory is `~/.app-factory/`, not `~/.factory/`.** `~/.factory/` is already owned by Factory.ai's installed CLI, which keeps `auth.json`, `settings.json`, `sessions/`, and `mcp.json` there. No filename collides today, but sharing a directory another tool may clean or rewrite would lose the project registry silently. `FACTORY_HOME` overrides the location.)*

`max_attempts` in ticket frontmatter overrides `config.max_attempts` for that ticket; config supplies the default at ticket creation. *(Resolves the duplication flagged in Gate 1.)*

**Model selection** is per role, defaulting to Sonnet everywhere. `models.<role>` overrides `models.default`; either accepts an alias (`sonnet`, `opus`, `haiku`) or a full model ID. Sonnet is the default because the cost of a feature is dominated by run count — 12+ runs per feature, up to 3 attempts each — not by any single run's difficulty. Roles that turn out to need more capability (most likely `tl_plan` and `dl`, where a bad plan poisons everything downstream) can be raised individually once the Phase 12 run gives real numbers.

**Concurrent human edits are out of scope.** Obsidian is the editing surface for reading and for fixing a paused item, but editing a note while the orchestrator is running risks a lost update — the orchestrator reads at claim time and writes at completion, with no mtime check. This is a documented constraint, not a defect: edit when the item is `needs_human` or the factory is stopped. Revisit if it becomes a real annoyance.

Registry `~/.app-factory/projects.yml` exactly as requirements §3.1 (path corrected — see above).

### 11.1 Startup validation

Fail fast, before any agent run: vault exists and `config.yml` parses; `vault_version` compatible; `target_repo` exists and is a git repo with a clean-enough working tree; `base_branch` exists; each `gates.*` command resolves; a **sandboxed probe run** of `gates.tests` succeeds inside a scratch worktree (this is what proves `sandbox_extra_read` is correct); `refs/factory/owner` is absent or matches this vault; instance lock acquired.

---

## 12. Logging & observability

- **Transcript per run:** `logs/<feature-slug>/<ticket-id>-<attempt>-<role>.log`, written line-buffered as the run proceeds. Never buffered to completion — M7's live tail depends on this, and it costs nothing now.
- **Event log:** `<vault>/logs/orchestrator.jsonl`, one line per decision: cycle start, scan results, claim (with the ranking rule that decided), transition, gate result, lock expiry, escalation, cost.
- **Running-agent registry:** `<vault>/.runs/<run-id>.json` with `{role, ticket, feature, attempt, pid, startedAt, logPath}`, deleted on completion. Written now because it is nearly free and it is M7's only source for "what is running".
- **Cost:** each run's `total_cost_usd` accumulates into feature frontmatter `cost_usd`. Over `run_budget` → warning event, never a block.

---

## 13. Testing strategy

Gate 4 rule is tests first, so the test surface is specified here.

**Unit (pure, no I/O):** transition table — every legal transition and a representative sample of illegal ones; guard predicates; DAG resolver (diamond, multi-parent, cycle detection, self-reference); `compareWorkItems` stage ordering; ID generation; project resolution — all five branches; config validation, including each rejection message; frontmatter round-trip and byte-stability.

**Integration (real filesystem, `MockRunner`):** `factory init` produces a vault that validates; atomic write survives a simulated mid-write crash (kill between tmp-write and rename, assert the original is intact); stale instance lock reclaimed, live one refused; M2 paper pipeline — a feature walks `intake → refining → checkpoint → planning → ticketing → checkpoint` with mocked PM/TL/DL output; malformed note quarantined without stopping the cycle.

**Integration (real git, real gates, `MockRunner`):** against `fixtures/toy-app`. Worktree created and removed; a mock developer output plus a genuinely failing test bounces the ticket and increments attempts; three failures land it in `needs_human`; a passing ticket merges into the feature branch; a deliberately red test on the feature branch blocks the merge; orchestrator killed mid-gate and restarted re-runs the ticket without state loss.

**Manual end-to-end (real agents, ~1 feature):** the acceptance run — a small feature with 3–4 tickets from `intake` to all-tickets-done, with only the three checkpoint approvals.

`fixtures/toy-app` is a ~5-file Node app with real `npm test`, `npm run lint`, and `npm run build` gates, plus a deliberately mutable module the sample feature can extend.

**It has zero npm dependencies** (decided during Phase 1; this section originally specified vitest, eslint, and tsc). The gates are `node --test`, a hand-written `scripts/lint.mjs`, and a `scripts/build.mjs` that loads every module under Node's type stripping. The fixture is invoked by tests in almost every phase, so one requiring `npm install` would make the suite slow, network-dependent, and non-hermetic. The gates remain real subprocesses with real exit codes and a mutation-proven red path. The accepted cost: `build` does not catch plain type errors, only syntax, resolution, and non-erasable TS. Revisit at Phase 9 if that fidelity gap matters in practice.

---

## 14. Verification appendix

**This is a calibration, not a proof.** Findings in §4 came from fourteen probe runs against Claude Code v2.1.220 / macOS 24.6.0 / Node v22.13.0, using `claude-haiku-4-5-20251001` on short single-purpose prompts. Real agent runs are long, multi-turn, and use git and npm heavily — the `.git` hole in §4.5 existed precisely because the first nine probes did not exercise git. Treat this list as the current state of knowledge and re-run it on every CLI upgrade. Probes 10–14 are automated as a test (`verify-isolation`) so a CLI upgrade that widens the sandbox fails the suite instead of quietly widening every agent's reach.

1. `--allowedTools Read` in dir A, ask it to read `../B/secret.txt` → **succeeds**, `permission_denials: []`.
2. Add `permissions.deny: ["Read(//abs/B/**)"]`, retry via `cat` → **blocked**.
3. Same deny rule, read via `node -e "fs.readFileSync(...)"` → **succeeds**. The gap.
4. `sandbox.enabled: true`, run a build script that writes to `../B/` → **`EPERM`**, file not created.
5. Same, but with the probe under `/private/tmp/claude-*` → **succeeds**. Temp allowlist.
6. `sandbox` + `denyRead: ["~/"]` + `allowRead: [cwd]`, read via node → **`EPERM`**.
7. `--json-schema` with `Bash`+`Read` enabled, 3 turns → **validated `structured_output` returned**.
8. Headless run in an unrelated dir, asked for a fact only in `~/.claude/CLAUDE.md` → **leaked**. `--setting-sources ""` and `--system-prompt` do not stop it; `--safe-mode` does.
9. `--safe-mode` + `sandbox` + escaping build script → **`EPERM`**. The production combination holds.
10. `npm test` under `denyRead: ["~/"]` with npm installed under `~/.nvm` → **succeeds**. The predicted npm breakage does not exist.
11. `curl https://registry.npmjs.org/` sandboxed → **exit 56, HTTP 000**. Sandboxed agents have no network, so dependency install must be done by the orchestrator.
12. `git commit` inside a sandboxed linked worktree, default settings → **succeeds**, because `<repo>/.git` is writable.
13. Blast-radius probe from inside a sandboxed worktree: main checkout `EPERM`, sibling worktree `EPERM`, home `EPERM`, **`<repo>/.git/**` writable**. The §4.5 hole.
14. Same, with `denyWrite` on `.git/{hooks,config,refs,objects}`: all four `EPERM`, while `git status --short` and `git diff` still work and `git add` fails with exit 128. The §4.5 fix.

Also observed: no `--cwd` flag exists; `--output-format stream-json` requires `--verbose` (undocumented in `--help`) and its terminal `result` event carries `structured_output`, `total_cost_usd`, and `is_error`; stdin must be redirected or the CLI stalls 3s; `--max-budget-usd` and per-run `total_cost_usd` make the cost guard nearly free.

---

## 15. Routing

Not applicable in M1–M3. The only network surface in the whole system is the M7 dashboard, which binds to localhost and is read-only apart from the three guarded actions.

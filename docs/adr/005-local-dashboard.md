# 005 — A local dashboard hosts the orchestrator behind a loopback-only HTTP surface

- **Status:** Accepted
- **Date:** 2026-09-25
- **Supersedes:** none

## Context

Operating the factory meant one CLI command per step, and progress could only be read from
vault files and JSONL logs. M1–M3 reserved seams for a dashboard (`actions.ts` as the single
write path, `status --json`, `.runs/`, line-buffered transcripts) and scheduled it for M7.
It was pulled forward so the factory is usable before M4–M6.

## Decision

`factory dashboard [project]` serves the page and, only on `--start` or a click of Start in
the page, runs the orchestrator itself in the same process, through the same
`startOrchestrator` function that `factory start` uses. Opening the page never spends money on
its own. The page changes state only by calling the existing `actions.ts` functions
(`approve`, `reject`, `kill`, `clearKill`) and a new `addFeature` function extracted from
`factory feature add`. No handler writes a note directly, and a lint rule
(`no-restricted-syntax` / `no-restricted-imports` on `src/dashboard/**`) fails the build on a
write-shaped call (`writeNote`, `atomicWrite`, and siblings), so the boundary is enforced
mechanically, not just by review.

The server binds to `127.0.0.1` only, rejects any request whose `Host` header is not a
loopback name on its own port, and requires a per-launch random token in a custom header on
every state-changing request. It sends no CORS headers. File reads are confined to the vault's
`logs/` and `work/features/` through `VaultPaths`.

A third runner kind, `demo`, runs a scripted feature against a throwaway copy of the toy app
at no cost, so the dashboard and the pipeline can be exercised without real agents. `factory
demo` spawns no process of its own — it runs the same in-process orchestrator as `factory
dashboard --start` — and every file it writes (the copied toy app, its vault, their worktrees)
lives under `<factory home>/demo/`, rebuilt only on `--fresh`. It never registers a project.

A dispatch that pauses now releases the item's claim in the same write that records the pause
(Phase 8b), closing a pre-existing lost-update race where a later orchestrator write could
silently undo a human's approval. `claim_released` is still logged after the dispatch, but for a
pause the release itself writes nothing: the pause write already dropped the claim.

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

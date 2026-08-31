# 003 — Agent isolation is enforced by the OS sandbox, not by tool permissions

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** none

## Context

The source requirements document (§7) assumes `--allowedTools` scopes an agent to its worktree. Fourteen probe runs against Claude Code v2.1.220 on macOS showed it does not.

A `Bash`-enabled agent read and wrote freely outside its working directory. `Read(...)` deny rules do catch shell commands the CLI recognises, such as `cat`, but were bypassed entirely by `node -e "fs.readFileSync(...)"` — with nothing recorded in `permission_denials`, so the bypass was also invisible. A Developer agent must have Bash in order to run tests, so the documented model provides no filesystem boundary at all for the one role that most needs one.

Two further findings. Headless runs inherit the operator's personal `~/.claude/CLAUDE.md`, so a user's private instructions leak into every agent. And the OS sandbox alone does not solve the git case: a linked worktree's real git directory lives at `<repo>/.git/worktrees/<id>`, outside the worktree, and the sandbox must permit writes there or `git commit` inside a worktree could not work. Because `.git` is shared by every worktree, an agent that can write it can move `refs/heads/main`, edit `.git/config`, or plant a `pre-commit` hook that later executes **unsandboxed** under the orchestrator. That is a complete escape, and it means the default fence satisfies "cannot touch other worktrees" while failing "cannot touch the base branch".

## Decision

Three layers, none sufficient alone:

1. **`--safe-mode` on every run**, excluding user and project instruction files, hooks, skills, plugins, and MCP servers.
2. **`sandbox.enabled: true`** with `filesystem.denyRead: ["~/"]` and an explicit `allowRead`. Worktrees are placed outside any temp path, because `/tmp/claude*` sits on the sandbox's default write allowlist and a worktree there would be silently unfenced.
3. **`denyWrite` on `<repo>/.git/{hooks,config,refs,objects}`, and agents never commit.** The Developer leaves a dirty tree and proposes a commit message; the orchestrator stages and commits after it exits.

Read-only roles get a throwaway worktree that is force-removed afterwards, rather than relying on a deny-all glob whose syntax is easy to get subtly wrong. `test/integration/isolation.test.ts` asserts the whole boundary against the real CLI.

## Consequences

Enforcement moves to the kernel (macOS Seatbelt) and covers arbitrary child processes, including a test script that tries to write outside its tree. Verified `EPERM` for the main checkout, sibling worktrees, the home directory, and every sensitive `.git` path, while `git status` and `git diff` keep working — so the agent loses nothing it actually needs. Git history gains a single writer, matching how ADR-002 treats the vault. `--safe-mode` additionally removes a class of nondeterminism from hooks and plugins.

The costs deserve stating plainly. The guarantee is coupled to one CLI version's sandbox behaviour, so `verify-isolation` must run on every upgrade; the spec's verification appendix is a calibration, not a proof. The `.git` hole survived a full planning cycle precisely because the first nine probes never used git — absence of a finding is not evidence of a fence. Sandboxed agents have no network, so dependency installation must be done by the orchestrator beforehand. The target repo's own `CLAUDE.md` is suppressed and must be injected deliberately. macOS and Linux only; native Windows has no sandbox. And `--safe-mode` is documented as a troubleshooting flag rather than a security control, so we are relying on it off-label and should watch its behaviour across releases.

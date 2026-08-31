# 002 — The orchestrator is the only writer of the vault

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** none

## Context

The source requirements document (§7) gives most agent roles "Write vault" access, and §13 acknowledges the resulting frontmatter races, proposing a partial fix: only the orchestrator writes frontmatter, while agents write body sections. That splits one file between two writers and leaves the race in place for anything the split does not cover.

Separately, the isolation work in ADR-003 fences agents into their worktrees at the OS level. Letting them write vault files would mean deliberately reopening a hole in that fence for every role.

A third pressure: a pipeline whose steps are unrepeatable is untestable. If an agent's effect on the world is "it edited some files", there is no way to replay a run or to substitute a mock.

## Decision

Agents never write to the vault at all. Each returns a payload validated against a JSON Schema (via the CLI's `--json-schema` flag), and the orchestrator writes every file — frontmatter, body sections, and history alike.

This extends to git history: agents cannot commit either. See ADR-003.

## Consequences

The write race disappears rather than being mitigated. The sandbox fence gets simpler, because agents need no vault access whatsoever. Every run becomes replayable from its recorded output, which is what makes the whole pipeline testable against a `MockRunner` instead of against real agents at real cost. Validation happens at exactly one boundary.

Against that: this is a deviation from the requirements document and needed explicit sign-off. Large outputs — a full technical plan, or four ticket bodies — now travel through a JSON field, so output-size limits become a failure mode worth measuring rather than assuming. And the orchestrator absorbs note-formatting logic that agents would otherwise have handled, making it a larger and more central component than the requirements document imagined.

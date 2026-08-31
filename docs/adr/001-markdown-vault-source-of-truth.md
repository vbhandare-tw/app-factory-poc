# 001 — Markdown vault as the source of truth

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** none

## Context

The factory needs durable state for features, tickets, dependencies, and history. Three requirements constrain the choice: state must be readable and editable by a human in Obsidian, it must be git-versioned, and a person must be able to understand what the pipeline is doing by reading files rather than querying a system.

A database would give transactions, indexed queries, and safe concurrent writes. It would also make state opaque, and would need a separate export layer to satisfy the Obsidian requirement — which puts the readable copy permanently at risk of drifting from the real one.

At POC scale the volume is trivial: tens of tickets, a scan every fifteen seconds.

## Decision

All state lives in markdown files with YAML frontmatter inside an Obsidian-compatible vault. Access goes through a `Storage` interface (`src/vault/storage.ts`) so SQLite can become the source of truth later with markdown as a generated view. No database in M1–M3.

## Consequences

State is inspectable with any text editor and diffable in git. A human can rescue a stuck pipeline by editing a file. There are no schema migrations, which matters while the state machine is still changing shape.

The costs are real. There are no transactions, so correctness rests entirely on atomic writes and on the single-writer rule of ADR-002 — those two properties are load-bearing rather than merely nice. There are no indexed queries, so every cycle rescans every note; fine at tens of tickets, not at thousands. Frontmatter round-trip fidelity becomes a correctness property needing its own test suite, because a serializer that quietly reformats or retypes a value corrupts state while appearing to work. And concurrent human editing during a run can silently lose an update, which is why it is forbidden rather than supported.

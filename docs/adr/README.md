# Architecture Decision Records

An ADR records a decision that is expensive to reverse. It captures the situation that forced a choice, the choice made, and what that choice costs — so that a year later the reasoning survives even when the people do not.

## Write one for

- Structural decisions: how state is stored, what the trust boundaries are, which component owns a responsibility.
- Stack and dependency choices that would be painful to unwind.
- Cross-cutting rules that constrain how unrelated features get built.
- Deviations from an external requirements document, so the divergence is deliberate and traceable.

## Do not write one for

- Feature-level choices.
- Anything an afternoon could undo.
- Decisions already obvious from the code.

## Conventions

- Filename: `NNN-kebab-slug.md`, numbered sequentially and never reused.
- Status: `Proposed`, `Accepted`, `Superseded by NNN`, or `Deprecated`.
- Never edit an accepted ADR's decision. Supersede it with a new one and mark the old one, so the history of thinking stays readable.
- Copy `TEMPLATE.md` to start.

## Index

| ADR | Title | Status |
|---|---|---|
| [001](001-markdown-vault-source-of-truth.md) | Markdown vault as the source of truth | Accepted |
| [002](002-orchestrator-sole-writer.md) | The orchestrator is the only writer of the vault | Accepted |
| [003](003-os-level-agent-isolation.md) | Agent isolation is enforced by the OS sandbox | Accepted |
| [004](004-deterministic-gates-and-merges.md) | Quality gates and merges are deterministic | Accepted |
| [005](005-local-dashboard.md) | A local dashboard hosts the orchestrator behind a loopback-only HTTP surface | Accepted |

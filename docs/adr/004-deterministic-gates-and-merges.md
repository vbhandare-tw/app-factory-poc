# 004 — Quality gates and merges are deterministic, never agent-driven

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** none

## Context

The source requirements document (§7) defines a `TL (merge)` agent that merges branches and resolves conflicts, and §9 requires quality gates to be hard requirements that no role can override.

These two pull against each other. An LLM resolving conflicts on a shared branch is the highest-blast-radius action in the system: it writes to code that other tickets depend on, in a situation defined by ambiguity, with no test able to prove the resolution preserved intent. And an agent reporting its own test results is a trust boundary with nothing behind it — a model that believes it succeeded will say so.

## Decision

Gates run as orchestrator child processes, never inside an agent run, and their exit codes are the only signal that advances a ticket. An agent's self-reported `outcome: 'ok'` advances nothing.

Merges are plain `git merge --no-ff` performed by the orchestrator. A conflict escalates to a human rather than being retried by an agent. The `tl_merge` role is removed from M1–M3.

## Consequences

The quality signal becomes deterministic and reproducible, and independent of how confident any model happens to sound. An agent that claims success while tests fail cannot advance a ticket. No LLM ever holds write access to a shared branch. Conflicts surface to a human while the context is still fresh.

The cost is throughput. Conflicts an agent might plausibly have resolved now need a person, which slows things down when tickets overlap — an argument for decomposing tickets better rather than for reinstating a merge agent.

One caveat on evidence: with `max_parallel_devs` pinned to 1 and merges running sequentially, this POC will rarely produce a conflict at all. Phase 12 passing therefore says nothing about whether escalation is the right policy under real parallelism. Revisit this decision when M4 lands, using measured conflict rates rather than the absence of trouble here.

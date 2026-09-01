# Project

Replace everything below with a description of the product this vault builds.

Every agent role receives this file as context (spec §6.2), so it is the one
place to state things that are true for the whole project rather than for one
feature: what the product is, who uses it, the conventions the code follows, and
anything an agent would otherwise guess at.

Keep it short. It is injected into every run, so length here is a cost paid on
every agent invocation.

## What this is

_One paragraph. What the product does and who it is for._

## Stack and conventions

_Language, framework, test runner, and any house rules an agent must follow._

## Out of scope

_Things the factory must never touch — directories, services, credentials._

## Working agreement

- The orchestrator is the only writer of this vault. Agents never edit these
  files; they return structured output and the orchestrator writes it.
- **Do not edit notes in Obsidian while the factory is running.** There is no
  lost-update guard by design. Edit when an item is `needs_human`, or when the
  factory is stopped.

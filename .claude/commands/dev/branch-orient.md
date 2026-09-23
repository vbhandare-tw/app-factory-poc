---
description: Orient on current branch — changes, WIP, and what to open first
argument-hint: [feature-id]
---

## ROLE

You are helping me return to an in-progress branch.
Do not make changes. Report only.

## CONTEXT

- Run `git status`, `git log --oneline -10`, and `git diff [base-branch]...HEAD --stat` (base branch: main unless I specify)
- If I provide a feature-id ($ARGUMENTS), read `/docs/features/$ARGUMENTS-plan.md`
- If no feature-id, infer from branch name and recent commits
- Group changes by layer, using this repo's layout: `src/domain` (pure), `src/vault` (markdown I/O),
  `src/runner` (the agent seam), `src/orchestrator` (the loop), `src/git`, `src/gates`, `src/cli`,
  `prompts/`, and `test/` mirroring them. There is no root `CLAUDE.md` here.

## INSTRUCTION — Produce this exact output

### 1. Branch summary

Current branch, commits ahead/behind base, and one-line purpose of the work.

### 2. What changed

Files and areas touched (from diff stat). Group by this repo's layout (see CLAUDE.md).

### 3. In progress vs done

From plan doc or commits: what is done, what is mid-flight, what is not started.

### 4. Open risks

Failing tests, unresolved plan items, or merge conflicts if any.

### 5. Start here

The single best file or command to run first when resuming (be specific).

## CONSTRAINT

Report only. Wait for my instruction before editing anything.

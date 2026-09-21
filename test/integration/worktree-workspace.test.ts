/**
 * The `WorkspaceProvider` — where an agent's process actually runs (Phase 8).
 *
 * ============================================================================
 * WHY THIS IS THE FILE THAT LIFTS THE REFUSAL
 * ============================================================================
 * The OS sandbox fences an agent to its **working directory** (ADR-003, spec
 * §4.2). So the provider does not merely choose a convenient cwd — it draws the
 * kernel's write region. `factory start` refused to build a real runner while
 * no provider existed, because the fallback was `config.target_repo`, i.e. the
 * operator's own checkout with nothing but a tool list in between.
 *
 * Two things are therefore asserted here that nothing else covers:
 *
 * 1. **The real `factory start` path works**, driven through `realWorktrees` —
 *    the same factory `processDeps()` installs. `pipeline-paper.test.ts` proves
 *    the refusal still fires for a `CliDeps` with no way to make worktrees;
 *    this proves the way forward is real rather than merely declared.
 * 2. **Throwaway means gone.** A read-only role's writes are asserted to be
 *    absent from disk afterwards — that is resolution A4's whole mechanism, and
 *    the alternative it replaced (a deny-all `Edit(//**)` glob) was rejected as
 *    one syntax slip from matching nothing.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ProjectRegistry } from '../../src/config/registry.js';
import { realWorktrees } from '../../src/cli/deps.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { buildProgram } from '../../src/cli/main.js';
import { ShellGit } from '../../src/git/git.js';
import { scratchRoot, vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { createWorkspaceProvider, roleNeedsDependencies } from '../../src/git/workspace.js';
import { MemoryEventLog } from '../../src/log/events.js';
import type { Role } from '../../src/domain/roles.js';
import type { AgentRunResult, AgentRunSpec, Runner } from '../../src/runner/types.js';
import { factoryVault } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { makeFeature, makeTicket } from '../helpers/notes.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  git,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

const SLUG = 'sample';
const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };

let vault: FactoryFixture;
let gitHandle: ShellGit;
let events: MemoryEventLog;
let clockMs: number;
const roots: string[] = [];

function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

beforeEach(async () => {
  clockMs = Date.parse('2026-09-01T00:00:00.000Z');
  events = new MemoryEventLog(now);
  vault = factoryVault({ config: { setup_command: 'true' } });
  gitHandle = new ShellGit({ repoRoot: vault.repo.path });
  roots.push(worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));

  await vault.storage.writeNote(
    vault.paths.featureNote(SLUG),
    makeFeature({ id: 'FEAT-SAMPLE', slug: SLUG, status: 'in_development' }),
  );
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  cleanupAllToyRepos();
  cleanupAllScratchDirs();
});

function provider() {
  return createWorkspaceProvider({
    config: vault.config,
    paths: vault.paths,
    storage: vault.storage,
    git: gitHandle,
    events,
  });
}

function request(role: Role, itemId = 'FEAT-SAMPLE', ticketId?: string) {
  return {
    role,
    itemId,
    featureSlug: SLUG,
    ...(ticketId === undefined ? {} : { ticketId }),
  };
}

describe('every workspace is outside the repo and outside any temp path', () => {
  it.each(['pm', 'tl_plan', 'dl'] as const)('%s', async (role) => {
    const workspace = await provider()(request(role));

    expect(workspace.cwd.startsWith(`${path.resolve(vault.repo.path)}${path.sep}`)).toBe(false);
    for (const temp of ['/tmp', '/private/tmp', os.tmpdir()]) {
      expect(workspace.cwd.startsWith(`${path.resolve(temp)}${path.sep}`)).toBe(false);
    }
    await workspace.dispose?.();
  });

  it('and never the target repo itself — the fallback the refusal existed to prevent', async () => {
    for (const role of ['pm', 'tl_plan', 'dl', 'developer', 'qa'] as const) {
      const workspace = await provider()(
        request(role, role === 'developer' || role === 'qa' ? 'FEAT-SAMPLE-T001' : 'FEAT-SAMPLE',
          role === 'developer' || role === 'qa' ? 'FEAT-SAMPLE-T001' : undefined),
      );
      expect(path.resolve(workspace.cwd)).not.toBe(path.resolve(vault.repo.path));
      await workspace.dispose?.();
    }
  });
});

describe('the PM gets a scratch directory, not a checkout', () => {
  it('is empty, has no .git, and disappears when the run ends', async () => {
    const workspace = await provider()(request('pm'));

    expect(existsSync(workspace.cwd)).toBe(true);
    expect(existsSync(path.join(workspace.cwd, '.git'))).toBe(false);
    expect(existsSync(path.join(workspace.cwd, 'package.json'))).toBe(false);

    await workspace.dispose?.();
    expect(existsSync(workspace.cwd)).toBe(false);
  });
});

describe('throwaway worktrees for the read-only repo roles (spec §4.3)', () => {
  it.each(['tl_plan', 'dl'] as const)(
    '%s gets a real checkout it can read, detached so the base branch stays available',
    async (role) => {
      const workspace = await provider()(request(role));

      expect(existsSync(path.join(workspace.cwd, 'src', 'calc.ts'))).toBe(true);
      expect(git(workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');
      expect(git(workspace.cwd, ['rev-parse', 'HEAD']).trim()).toBe(
        git(vault.repo.path, ['rev-parse', vault.repo.branch]).trim(),
      );

      await workspace.dispose?.();
    },
  );

  it('takes everything the agent wrote with it — resolution A4', async () => {
    const workspace = await provider()(request('dl'));

    writeFileSync(path.join(workspace.cwd, 'src', 'calc.ts'), '// a read-only role wrote this\n');
    writeFileSync(path.join(workspace.cwd, 'SNEAKY.txt'), 'should not survive\n');

    await workspace.dispose?.();

    expect(existsSync(workspace.cwd)).toBe(false);
    expect(readFileSync(path.join(vault.repo.path, 'src', 'calc.ts'), 'utf8')).not.toContain(
      'a read-only role wrote this',
    );
    expect(existsSync(path.join(vault.repo.path, 'SNEAKY.txt'))).toBe(false);
    expect(
      (await gitHandle.listWorktrees()).some((entry) => entry.path === workspace.cwd),
    ).toBe(false);
  });

  it('gives the code reviewer the ticket’s branch, not the base', async () => {
    await gitHandle.ensureBranch('feature/sample', vault.repo.branch);
    await gitHandle.ensureBranch('feat/sample/t001-reviewed', 'feature/sample');
    await vault.storage.writeNote(
      vault.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T001'),
      makeTicket({
        id: 'FEAT-SAMPLE-T001',
        feature: SLUG,
        status: 'code_review',
        branch: 'feat/sample/t001-reviewed',
      }),
    );

    // Something only the ticket branch has, so "it checked out the right ref"
    // is asserted by content rather than by a name we also chose.
    const worktree = path.join(worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)), 'seed');
    await gitHandle.createWorktree(worktree, 'feat/sample/t001-reviewed', 'feature/sample');
    writeFileSync(path.join(worktree, 'ONLY-ON-TICKET-BRANCH.txt'), 'yes\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '--quiet', '-m', 'feat: ticket branch content']);
    await gitHandle.removeWorktree(worktree, true);

    const workspace = await provider()(
      request('code_reviewer', 'FEAT-SAMPLE-T001', 'FEAT-SAMPLE-T001'),
    );

    expect(existsSync(path.join(workspace.cwd, 'ONLY-ON-TICKET-BRANCH.txt'))).toBe(true);
    await workspace.dispose?.();
  });

  it('puts them all under .scratch, so reconciliation can sweep a crashed run', async () => {
    const scratch = path.resolve(scratchRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));
    const workspace = await provider()(request('tl_plan'));

    expect(path.resolve(workspace.cwd).startsWith(`${scratch}${path.sep}`)).toBe(true);
    await workspace.dispose?.();
  });
});

describe('the ticket worktree, which must survive the run', () => {
  it('is the ticket’s own worktree and has no dispose', async () => {
    await vault.storage.writeNote(
      vault.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T001'),
      makeTicket({ id: 'FEAT-SAMPLE-T001', feature: SLUG, status: 'in_progress', title: 'Do it' }),
    );

    const workspace = await provider()(request('developer', 'FEAT-SAMPLE-T001', 'FEAT-SAMPLE-T001'));

    expect(workspace.dispose).toBeUndefined();
    expect(git(workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'feat/sample/t001-do-it',
    );

    // The Developer's output lives only here until the orchestrator stages it
    // (ADR-003), so a second request must adopt rather than rebuild.
    writeFileSync(path.join(workspace.cwd, 'WORK.txt'), 'uncommitted\n');
    const again = await provider()(request('qa', 'FEAT-SAMPLE-T001', 'FEAT-SAMPLE-T001'));
    expect(again.cwd).toBe(workspace.cwd);
    expect(existsSync(path.join(again.cwd, 'WORK.txt'))).toBe(true);
  });

  it('installs dependencies only for roles that can run something', () => {
    // `setup_command` costs real time per run. The roles that cannot execute
    // anything (Read/Grep/Glob) do not need it; the ones with Bash do, because
    // their first act is `npm test`.
    expect(roleNeedsDependencies('developer')).toBe(true);
    expect(roleNeedsDependencies('qa')).toBe(true);
    expect(roleNeedsDependencies('code_reviewer')).toBe(true);
    expect(roleNeedsDependencies('pm')).toBe(false);
    expect(roleNeedsDependencies('tl_plan')).toBe(false);
    expect(roleNeedsDependencies('dl')).toBe(false);
  });
});

describe('factory start, driven through the real workspace factory', () => {
  it('runs an agent in a provisioned worktree and cleans it up afterwards', async () => {
    const home = scratchFactoryHome();
    const cwd = scratchDir('workspace-cli-');
    const seen: { role: Role; cwd: string }[] = [];

    await vault.storage.writeNote(
      vault.paths.featureNote(SLUG),
      makeFeature({ id: 'FEAT-SAMPLE', slug: SLUG, status: 'planning' }),
    );

    const recording: Runner = {
      run(spec: AgentRunSpec): Promise<AgentRunResult> {
        seen.push({ role: spec.role, cwd: spec.cwd });
        // Escalate rather than plan for real: this test is about the working
        // directory, and a full plan would drag the whole TL contract in.
        //
        // *(Corrected in Phase 7b, and the correction is the finding. The
        // payload here used to be `{outcome: 'escalate', reason: ...}` — which
        // is **not** a valid `tl_plan` payload: the field is `escalate_reason`,
        // and six required fields were absent. Dispatch validates before it
        // reads `outcome`, so this run was never an escalation at all; it was a
        // schema failure, and the assertion below held only because Phase 7a
        // charged a schema failure straight away. Phase 7b's rule re-runs a
        // first schema failure, so the accident became visible as a second
        // `tl_plan` run. **No assertion changed** — the fixture now is what its
        // own comment always claimed, and the test finally exercises the
        // escalation path it names.)*
        return Promise.resolve({
          ok: true,
          structured: {
            outcome: 'escalate',
            escalate_reason: 'checking the workspace only',
            notes_markdown: '',
            feasibility: '',
            risks: [],
            phases: [],
            questions_for_pm: [],
            request_refinement: false,
            tech_doc_updates: [],
          },
          costUsd: 0,
          numTurns: 1,
          durationMs: 1,
          sessionId: 'test',
          terminalReason: 'ok',
          permissionDenials: [],
          structuredOutputCalls: 1,
        });
      },
    };

    const deps: CliDeps = {
      cwd,
      env: { PATH: process.env['PATH'] ?? '' },
      registry: new ProjectRegistry(home),
      out: () => undefined,
      err: () => undefined,
      now,
      runner: recording,
      // The real thing — the same factory `processDeps()` installs.
      workspaceFactory: realWorktrees,
    };

    await buildProgram(deps, MANIFEST).parseAsync([
      'node',
      'factory',
      'start',
      '--vault',
      vault.root,
      '--once',
    ]);

    expect(seen.map((entry) => entry.role)).toEqual(['tl_plan']);

    const used = seen[0]?.cwd ?? '';
    const scratch = path.resolve(scratchRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));

    // Not the operator's checkout — the thing the refusal existed to prevent.
    expect(path.resolve(used)).not.toBe(path.resolve(vault.repo.path));
    expect(path.resolve(used).startsWith(`${scratch}${path.sep}`)).toBe(true);
    // And it is gone: a throwaway worktree that survived would be a leak, and
    // an agent's writes surviving with it would defeat resolution A4.
    expect(existsSync(used)).toBe(false);
  });
});

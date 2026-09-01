/**
 * Loop step 5 — worktree reconciliation (plan Phase 8, spec §9).
 *
 * ============================================================================
 * THE ASYMMETRY THESE TESTS ENCODE
 * ============================================================================
 * A leaked worktree wastes disk and eventually confuses somebody. A **wrongly
 * removed** worktree destroys work that exists nowhere else: agents never
 * commit (ADR-003), so a Developer's output lives only in its working tree
 * until the orchestrator stages it. The two failures are not equally bad, and
 * these tests are weighted accordingly — five of them are about reconciliation
 * declining to delete something.
 *
 * The one that would be easiest to get wrong and never notice is
 * `worktree_unaccounted`: a ticket note that fails to parse drops out of the
 * scan, so a reconciler that treats "no ticket claims this" as "orphan" wipes
 * the working tree of the one ticket a human is already dealing with. The
 * quarantine case below is that scenario end to end.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ExecFn } from '../../src/git/exec.js';
import { ShellGit } from '../../src/git/git.js';
import { reconcileWorktrees } from '../../src/git/reconcile.js';
import type { ReconcileReport } from '../../src/git/reconcile.js';
import { ticketWorktreePath, vaultWorktreeName, worktreeRoot } from '../../src/git/paths.js';
import { provisionWorktree } from '../../src/git/worktree.js';
import { MemoryEventLog } from '../../src/log/events.js';
import type { TicketState } from '../../src/domain/states.js';
import type { TicketFrontmatter } from '../../src/domain/types.js';
import { factoryVault } from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import { makeFeature, makeTicket } from '../helpers/notes.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos, git, toyRepo } from '../helpers/toyRepo.js';

const SLUG = 'sample';
const FEATURE_BRANCH = 'feature/sample';

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
  // `true` rather than `npm ci`: these tests are about which worktrees exist,
  // not about installing anything. The install itself is proven in
  // `worktree.test.ts`, and one case below uses the real default.
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

async function writeTicket(
  id: string,
  status: TicketState,
  overrides: Partial<TicketFrontmatter> = {},
): Promise<string> {
  const file = vault.paths.ticketPath(SLUG, id);
  await vault.storage.writeNote(
    file,
    makeTicket({ id, feature: SLUG, status, title: `Ticket ${id}`, ...overrides }),
  );
  return file;
}

function reconcile(): Promise<ReconcileReport> {
  return reconcileWorktrees({
    git: gitHandle,
    storage: vault.storage,
    paths: vault.paths,
    config: vault.config,
    events,
    now,
  });
}

/** Put a real worktree on disk for a ticket, whatever its state says. */
async function plantWorktree(ticketId: string): Promise<string> {
  await gitHandle.ensureBranch(FEATURE_BRANCH, vault.repo.branch);
  const result = await provisionWorktree({
    git: gitHandle,
    repoRoot: vault.repo.path,
    vaultName: vaultWorktreeName(vault.paths.root),
    ticketId,
    featureSlug: SLUG,
    title: `Ticket ${ticketId}`,
    fromRef: FEATURE_BRANCH,
    setupCommand: 'true',
    setupTimeoutMs: 60_000,
  });
  return result.path;
}

describe('removing what no live ticket owns', () => {
  it('removes a backlog ticket’s worktree and leaves an in_progress one alone', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'backlog');
    await writeTicket('FEAT-SAMPLE-T002', 'in_progress');
    const orphan = await plantWorktree('FEAT-SAMPLE-T001');
    const live = await plantWorktree('FEAT-SAMPLE-T002');

    const report = await reconcile();

    expect(existsSync(orphan)).toBe(false);
    expect(report.removed).toContain(orphan);

    expect(existsSync(live)).toBe(true);
    expect(report.removed).not.toContain(live);
    expect(report.kept).toContain(live);
  });

  it('removes the worktree of a ticket that is done (spec §10)', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'done');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');

    await reconcile();
    expect(existsSync(worktree)).toBe(false);
  });

  it('keeps the worktree of a ticket in every mid-flight state', async () => {
    // The plan's wording is "not in_progress/qa → orphan". Taken literally that
    // deletes the tree of a ticket sitting at `gates` between two cycles — and
    // Phase 9 runs the gates *inside* that tree, so the next cycle would have
    // nothing to test.
    const states: TicketState[] = ['in_progress', 'gates', 'code_review', 'qa', 'merge'];
    const planted: string[] = [];

    for (const [index, state] of states.entries()) {
      const id = `FEAT-SAMPLE-T10${index}`;
      await writeTicket(id, state);
      planted.push(await plantWorktree(id));
    }

    await reconcile();
    for (const worktree of planted) expect(existsSync(worktree)).toBe(true);
  });

  it('keeps the worktree of a needs_human ticket — that is when a human looks at it', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'needs_human');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');

    await reconcile();
    expect(existsSync(worktree)).toBe(true);
  });
});

describe('refusing to remove what it cannot account for', () => {
  it('leaves a worktree whose ticket note is quarantined, and says so', async () => {
    // The note exists but will not parse, so the scan quarantines it and the
    // ticket is absent from the reconciler's view. Deleting on that basis would
    // destroy the working tree of the one ticket already in trouble.
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');
    writeFileSync(vault.paths.ticketPath(SLUG, 'FEAT-SAMPLE-T001'), '---\n: : :\n---\nbroken\n');

    const report = await reconcile();

    expect(existsSync(worktree)).toBe(true);
    expect(report.unaccounted).toContain(worktree);
    expect(report.removed).not.toContain(worktree);
    expect(events.ofType('worktree_unaccounted')[0]?.path).toBe(worktree);
  });

  it('leaves a directory under the root that matches no ticket at all', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    const stray = await plantWorktree('FEAT-SAMPLE-T999');

    const report = await reconcile();

    expect(existsSync(stray)).toBe(true);
    expect(report.unaccounted).toContain(stray);
  });

  it('leaves an orphaned worktree that still holds uncommitted work', async () => {
    // The ticket says backlog, so by state alone this is an orphan. The tree
    // says otherwise, and the tree is the only copy.
    await writeTicket('FEAT-SAMPLE-T001', 'backlog');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');
    writeFileSync(path.join(worktree, 'src', 'calc.ts'), '// work an agent did\n', 'utf8');

    const report = await reconcile();

    expect(existsSync(worktree)).toBe(true);
    expect(report.retainedDirty).toContain(worktree);
    expect(events.ofType('worktree_retained_dirty')[0]?.itemId).toBe('FEAT-SAMPLE-T001');
  });

  it('leaves an orphaned worktree holding a new untracked file', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'backlog');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');
    writeFileSync(path.join(worktree, 'src', 'brand-new.ts'), 'export const x = 1;\n', 'utf8');

    const report = await reconcile();

    expect(existsSync(worktree)).toBe(true);
    expect(report.retainedDirty).toContain(worktree);
  });

  it('never touches the repo’s own working tree', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    await reconcile();
    expect(existsSync(path.join(vault.repo.path, 'package.json'))).toBe(true);
    expect(git(vault.repo.path, ['status', '--porcelain']).trim()).toBe('');
  });
});

describe('recreating what a live ticket is missing', () => {
  it('recreates a worktree deleted from disk while its ticket is in_progress', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);

    const report = await reconcile();

    expect(existsSync(worktree)).toBe(true);
    expect(report.created).toContain(worktree);
    expect(events.ofType('worktree_created').some((event) => event.path === worktree)).toBe(true);
  });

  it('creates one for a ticket that has never had a worktree', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');

    const report = await reconcile();

    const expected = ticketWorktreePath(
      vault.repo.path,
      vaultWorktreeName(vault.paths.root),
      'FEAT-SAMPLE-T001',
    );
    expect(existsSync(expected)).toBe(true);
    expect(report.created).toContain(expected);
    // Cut from the feature branch, which reconciliation created because nothing
    // before this phase ever does (spec §10).
    expect(git(vault.repo.path, ['rev-parse', '--verify', FEATURE_BRANCH]).trim()).not.toBe('');
    expect(events.ofType('feature_branch_created')[0]?.branch).toBe(FEATURE_BRANCH);
  });

  it('honours a branch already recorded on the ticket', async () => {
    await gitHandle.ensureBranch(FEATURE_BRANCH, vault.repo.branch);
    await gitHandle.ensureBranch('feat/sample/t001-chosen-by-hand', FEATURE_BRANCH);
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress', {
      branch: 'feat/sample/t001-chosen-by-hand',
    });

    await reconcile();

    const worktree = ticketWorktreePath(
      vault.repo.path,
      vaultWorktreeName(vault.paths.root),
      'FEAT-SAMPLE-T001',
    );
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'feat/sample/t001-chosen-by-hand',
    );
  });

  it('is idempotent — a second pass changes nothing', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    const first = await reconcile();
    const second = await reconcile();

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.removed).toHaveLength(0);
    expect(second.kept).toEqual(first.created);
  });
});

describe('a failing setup command', () => {
  it('marks the ticket needs_human rather than handing over a broken tree', async () => {
    vault = factoryVault({ config: { setup_command: 'echo "install exploded" >&2; exit 3' } });
    gitHandle = new ShellGit({ repoRoot: vault.repo.path });
    roots.push(worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));
    await vault.storage.writeNote(
      vault.paths.featureNote(SLUG),
      makeFeature({ id: 'FEAT-SAMPLE', slug: SLUG, status: 'in_development' }),
    );
    const file = await writeTicket('FEAT-SAMPLE-T001', 'in_progress');

    const report = await reconcile();

    expect(report.failed.map((entry) => entry.ticketId)).toContain('FEAT-SAMPLE-T001');

    const after = await vault.storage.readNote<TicketFrontmatter>(file);
    expect(after.frontmatter.status).toBe('needs_human');
    expect(after.frontmatter.pause_reason).toBe('escalation');
    expect(after.frontmatter.pause_detail).toContain('install exploded');
    // Approving retries provisioning from where it was; nothing an agent did
    // caused this, so there is no upstream role to reject back to.
    expect(after.frontmatter.resume_to).toBe('in_progress');
    expect(after.frontmatter.reject_to).toBe(null);

    // And no half-built tree was left for an agent to trip over.
    const expected = ticketWorktreePath(
      vault.repo.path,
      vaultWorktreeName(vault.paths.root),
      'FEAT-SAMPLE-T001',
    );
    expect(existsSync(expected)).toBe(false);
  });

  it('runs the setup command exactly once, however many cycles follow', async () => {
    // The loop this closes: the failed worktree is removed, so the paused
    // ticket has none. If `needs_human` also *created* one, every cycle would
    // re-run `npm ci` — up to `setup_timeout` (300s) of a sequential cycle,
    // forever, hammering the registry while the ticket sat exactly where it was.
    //
    // Counting invocations is the assertion, not timing: a backoff would make
    // this slower, and only "never again" makes it zero.
    let setupRuns = 0;
    const countingExec: ExecFn = (command, _args, options) => {
      setupRuns += 1;
      return Promise.resolve({
        command,
        cwd: options.cwd,
        status: 3,
        signal: null,
        stdout: '',
        stderr: 'install exploded\n',
        timedOut: false,
        durationMs: 1,
        spawnError: null,
      });
    };

    const file = await writeTicket('FEAT-SAMPLE-T001', 'in_progress');

    const withExec = (): Promise<ReconcileReport> =>
      reconcileWorktrees({
        git: gitHandle,
        storage: vault.storage,
        paths: vault.paths,
        config: vault.config,
        events,
        now,
        exec: countingExec,
      });

    const first = await withExec();
    expect(first.failed).toHaveLength(1);
    expect(setupRuns).toBe(1);
    expect((await vault.storage.readNote<TicketFrontmatter>(file)).frontmatter.status).toBe(
      'needs_human',
    );

    // Five more cycles. Not one more install.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const report = await withExec();
      expect(report.failed).toHaveLength(0);
      expect(report.created).toHaveLength(0);
    }
    expect(setupRuns).toBe(1);
  });

  it('a human approving the ticket is what retries it', async () => {
    // The other half: "never again" must not mean "never". Reconciliation stops
    // retrying, and `factory approve` — which sends the ticket back to
    // `in_progress` — is what asks for another go, once, deliberately.
    let setupRuns = 0;
    const countingExec: ExecFn = (command, _args, options) => {
      setupRuns += 1;
      return Promise.resolve({
        command,
        cwd: options.cwd,
        status: setupRuns === 1 ? 3 : 0,
        signal: null,
        stdout: '',
        stderr: setupRuns === 1 ? 'install exploded\n' : '',
        timedOut: false,
        durationMs: 1,
        spawnError: null,
      });
    };

    const withExec = (): Promise<ReconcileReport> =>
      reconcileWorktrees({
        git: gitHandle,
        storage: vault.storage,
        paths: vault.paths,
        config: vault.config,
        events,
        now,
        exec: countingExec,
      });

    const file = await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    await withExec();
    await withExec();
    expect(setupRuns).toBe(1);

    // What `factory approve` does: back to `resume_to`.
    const paused = await vault.storage.readNote<TicketFrontmatter>(file);
    await vault.storage.writeNote(file, {
      ...paused,
      frontmatter: { ...paused.frontmatter, status: 'in_progress' as const },
    });

    const resumed = await withExec();
    expect(setupRuns).toBe(2);
    expect(resumed.created).toHaveLength(1);
  });

  it('keeps a needs_human ticket’s existing worktree — that is what a human inspects', async () => {
    // Owning and creating are different questions. Not creating one must not
    // turn into removing one that is already there and full of agent work.
    await writeTicket('FEAT-SAMPLE-T001', 'in_progress');
    const worktree = await plantWorktree('FEAT-SAMPLE-T001');
    writeFileSync(path.join(worktree, 'src', 'calc.ts'), '// what the agent left\n', 'utf8');
    await writeTicket('FEAT-SAMPLE-T001', 'needs_human');

    const report = await reconcile();

    expect(existsSync(worktree)).toBe(true);
    expect(report.kept).toContain(worktree);
    expect(report.removed).not.toContain(worktree);
    expect(readFileSync(path.join(worktree, 'src', 'calc.ts'), 'utf8')).toBe(
      '// what the agent left\n',
    );
  });

  it('does not re-pause a ticket that is already needs_human', async () => {
    vault = factoryVault({ config: { setup_command: 'exit 3' } });
    gitHandle = new ShellGit({ repoRoot: vault.repo.path });
    roots.push(worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root)));
    await vault.storage.writeNote(
      vault.paths.featureNote(SLUG),
      makeFeature({ id: 'FEAT-SAMPLE', slug: SLUG, status: 'in_development' }),
    );
    const file = await writeTicket('FEAT-SAMPLE-T001', 'needs_human', {
      pause_reason: 'escalation',
      pause_detail: 'the original reason',
      resume_to: 'in_progress',
      paused_at: '2026-09-01T00:00:00.000Z',
    });

    await reconcile();

    const after = await vault.storage.readNote<TicketFrontmatter>(file);
    expect(after.frontmatter.pause_detail).toBe('the original reason');
  });
});

describe('another repository’s worktree is never removed', () => {
  it('leaves a foreign worktree that has somehow landed under our root', async () => {
    // Salting `vaultWorktreeName` means two vaults cannot share a root, so this
    // is forced: a worktree of *another* repo is created at a path inside this
    // vault's root. Before the ownership check, reconciliation would have found
    // an unfamiliar ticket id, or a familiar one in a non-owning state, and
    // `rm -rf`'d a live checkout belonging to someone else.
    const other = toyRepo();
    const otherGit = new ShellGit({ repoRoot: other.path });
    await otherGit.ensureBranch('feature/other', other.branch);

    const ourVaultName = vaultWorktreeName(vault.paths.root);
    // Both toy repos share a parent, so naming our vault here puts the foreign
    // worktree squarely inside the root our reconcile pass walks.
    const foreign = await provisionWorktree({
      git: otherGit,
      repoRoot: other.path,
      vaultName: ourVaultName,
      ticketId: 'FEAT-SAMPLE-T001',
      featureSlug: 'other',
      title: 'Belongs to another repo',
      fromRef: 'feature/other',
      setupCommand: 'true',
      setupTimeoutMs: 60_000,
    });

    // Deliberately left **clean**. A dirty foreign worktree is caught one step
    // earlier by the uncommitted-work guard, which would make this pass without
    // the ownership check ever running. Clean is the case that reaches it.
    expect(git(foreign.path, ['status', '--porcelain']).trim()).toBe('');

    // Their ticket id matches one of ours, in a state that says "orphan" — the
    // worst-case shape, and the one that used to delete it.
    await writeTicket('FEAT-SAMPLE-T001', 'backlog');

    const report = await reconcile();

    expect(existsSync(foreign.path)).toBe(true);
    expect(existsSync(path.join(foreign.path, 'src', 'calc.ts'))).toBe(true);
    expect(report.removed).not.toContain(foreign.path);
    expect(report.unaccounted).toContain(foreign.path);
    expect(
      events.ofType('worktree_unaccounted').some((event) => /not of/.test(event.detail)),
    ).toBe(true);

    // And the other repo still holds a valid registration for it.
    expect((await otherGit.listWorktrees()).some((entry) => entry.path === foreign.path)).toBe(true);
  });
});

describe('sweeping throwaway worktrees', () => {
  it('removes anything left under .scratch by a run that died', async () => {
    await writeTicket('FEAT-SAMPLE-T001', 'backlog');
    const root = worktreeRoot(vault.repo.path, vaultWorktreeName(vault.paths.root));
    const leftover = path.join(root, '.scratch', 'FEAT-SAMPLE-dl');
    await gitHandle.createDetachedWorktree(leftover, vault.repo.branch);
    expect(existsSync(leftover)).toBe(true);

    const report = await reconcile();

    expect(existsSync(leftover)).toBe(false);
    expect(report.scratchRemoved).toContain(leftover);
  });
});

/**
 * The M2 paper pipeline on `MockRunner` (plan Phase 7a).
 *
 * A real vault on disk, real commander parsing for the human commands, real
 * atomic writes, real transitions — and no real agent anywhere. Every scenario
 * the plan lists for this phase is here except crash recovery, which needs a
 * process that actually dies and lives in `orchestrator-recovery.test.ts`.
 *
 * Three things this file is careful about, because each is a way the whole set
 * could go green while proving nothing:
 *
 * 1. **"The pipeline keeps running" is asserted by watching a *second* feature
 *    advance in the same cycle**, not by asserting the cycle did not throw. A
 *    cycle that quietly aborted after the first item would satisfy "no throw".
 *
 * 2. **The unknown-key test plants its key by writing markdown to disk**, and
 *    asserts the key is there before anything runs. A key added to a typed
 *    fixture object would never have existed on a real note.
 *
 * 3. **Zero manual file edits.** The pipeline scenario touches the vault only
 *    through `factory feature add` and two `factory approve` calls, which is
 *    what the plan asks for and what makes the result mean something.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../src/agents/context.js';
import { ProjectRegistry } from '../../src/config/registry.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { fencedBlock, sectionText } from '../../src/domain/markdown.js';
import { historyLines } from '../../src/domain/transitions.js';
import type { TicketNote } from '../../src/domain/types.js';
import { MemoryEventLog } from '../../src/log/events.js';
import { failureConsumesAttempt } from '../../src/orchestrator/dispatch.js';
import { runStop } from '../../src/cli/stop.js';
import { Orchestrator } from '../../src/orchestrator/loop.js';
import type { CycleReport } from '../../src/orchestrator/loop.js';
import { MockRunner } from '../../src/runner/mock.js';
import type { AgentRunSpec, Runner } from '../../src/runner/types.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { buildProgram } from '../../src/cli/main.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { appendToSection } from '../../src/vault/storage.js';
import { makeFeature } from '../helpers/notes.js';
import {
  dlPayload,
  escalation,
  factoryVault,
  pipelineRunner,
  plantUnknownKey,
  pmPayload,
  readFrontmatter,
  readNoteFile,
  tlPayload,
} from '../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../helpers/orchestratorFixtures.js';
import {
  cleanupAllScratchDirs,
  cleanupAllToyRepos,
  removeScratchDir,
  scratchDir,
  scratchFactoryHome,
} from '../helpers/toyRepo.js';

const MANIFEST = { name: 'factory', version: '0.0.0-test', description: 'test build' };

let vault: FactoryFixture;
let home: string;
let workspace: string;
let output: string[];
let errors: string[];
let events: MemoryEventLog;
let clockMs: number;

/** Deterministic, and strictly increasing so history lines are distinguishable. */
function now(): string {
  clockMs += 1000;
  return new Date(clockMs).toISOString();
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: overrides.cwd ?? workspace,
    // `PATH` and nothing else. `factory start` runs `validateStartup`, which
    // checks each gate command resolves — with an empty environment every gate
    // fails to resolve, and a test meaning to assert one failure would assert
    // four. Everything else the operator's environment carries stays out.
    env: overrides.env ?? { PATH: process.env['PATH'] ?? '' },
    registry: overrides.registry ?? new ProjectRegistry(home),
    out: overrides.out ?? ((line) => output.push(line)),
    err: overrides.err ?? ((line) => errors.push(line)),
    now: overrides.now ?? now,
    ...(overrides.runner === undefined ? {} : { runner: overrides.runner }),
    ...(overrides.workspace === undefined ? {} : { workspace: overrides.workspace }),
  };
}

/** Run a factory command exactly as the binary would. */
async function factory(args: readonly string[], overrides: Partial<CliDeps> = {}): Promise<void> {
  await buildProgram(deps(overrides), MANIFEST).parseAsync(['node', 'factory', ...args]);
}

async function orchestrator(
  fixture: FactoryFixture,
  runner: Runner,
  extra: { pid?: number } = {},
): Promise<Orchestrator> {
  return await Orchestrator.start({
    paths: fixture.paths,
    config: fixture.config,
    storage: fixture.storage,
    runner,
    events,
    now,
    isAlive: () => true,
    ...(extra.pid === undefined ? {} : { pid: extra.pid }),
  });
}

/** Drive `n` cycles with no real waiting between them. */
async function cycles(instance: Orchestrator, n: number): Promise<CycleReport[]> {
  return await instance.run({ maxCycles: n, sleep: async () => undefined });
}

/** Write a requirement file and add it as a feature. */
async function addFeature(name: string, body: string): Promise<string> {
  const file = path.join(workspace, `${name}.md`);
  writeFileSync(file, body, 'utf8');
  await factory(['feature', 'add', file, '--vault', vault.root]);
  return file;
}

/**
 * The note `factory feature add` writes for a `# <title>` requirement, written
 * directly: the command refuses a second active feature (plan A9).
 */
async function plantFeature(slug: string, title: string): Promise<void> {
  const at = now();
  await vault.storage.writeNote(
    vault.paths.featureNote(slug),
    makeFeature(
      { id: `FEAT-${slug.toUpperCase()}`, slug, title, created_at: at, updated_at: at },
      appendToSection('', SECTION.rawRequirement, fencedBlock(`# ${title}\n`, 'markdown')),
    ),
  );
}

beforeEach(() => {
  vault = factoryVault();
  home = scratchFactoryHome();
  workspace = scratchDir('pipeline-workspace-');
  output = [];
  errors = [];
  events = new MemoryEventLog(() => '2026-09-01T00:00:00.000Z');
  clockMs = Date.parse('2026-09-01T10:00:00.000Z');
});

afterEach(() => {
  vault.cleanup();
  removeScratchDir(home);
  removeScratchDir(workspace);
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

// ---------------------------------------------------------------------------

describe('the M2 pipeline on MockRunner', () => {
  it('walks intake → in_development with exactly two approvals and no manual edits', async () => {
    await addFeature('sample', '# Add subtract\n\nThe calculator should subtract.\n');

    const featureFile = vault.paths.featureNote('sample');
    expect(readNoteFile(featureFile).frontmatter.status).toBe('intake');
    // `## Raw Requirement` is verbatim (spec §6) — nothing rewrote the ask.
    expect(sectionText(readNoteFile(featureFile).body, SECTION.rawRequirement)).toContain(
      'The calculator should subtract.',
    );

    const runner = pipelineRunner();
    const instance = await orchestrator(vault, runner);

    // Cycle 1: intake → refining, then the PM runs and the checkpoint fires.
    await cycles(instance, 1);
    let note = readNoteFile(featureFile);
    expect(note.frontmatter.status).toBe('needs_human');
    expect(note.frontmatter.pause_reason).toBe('checkpoint');
    expect(note.frontmatter.resume_to).toBe('planning');
    expect(note.frontmatter.reject_to).toBe('refining');
    expect(sectionText(note.body, SECTION.refinedRequirement)).toContain('subtract(a, b)');
    expect(sectionText(note.body, SECTION.acceptanceCriteria)).toContain('subtract(3, 1) returns 2');

    await instance.shutdown();

    // Approval 1.
    await factory(['approve', 'FEAT-SAMPLE', 'good enough', '--vault', vault.root]);
    expect(readNoteFile(featureFile).frontmatter.status).toBe('planning');

    const second = await orchestrator(vault, runner);
    // Cycle 2 runs the TL; cycle 3 runs the DL.
    await cycles(second, 2);
    await second.shutdown();

    note = readNoteFile(featureFile);
    expect(note.frontmatter.status).toBe('needs_human');
    expect(note.frontmatter.resume_to).toBe('in_development');

    // The TL's `notes_markdown` became `tech-plan.md` — the contract
    // `prompts/tl_plan.md:20-22` states to the agent.
    const techPlan = readFileSync(vault.paths.techPlan('sample'), 'utf8');
    expect(techPlan).toContain('One pure function in `src/calc.ts`');

    // Four tickets, ids assigned by the orchestrator, dependencies resolved
    // from the payload's titles.
    const tickets = await vault.storage.listTickets('sample');
    expect(tickets.map((ticket) => ticket.frontmatter.id)).toEqual([
      'FEAT-SAMPLE-T001',
      'FEAT-SAMPLE-T002',
      'FEAT-SAMPLE-T003',
      'FEAT-SAMPLE-T004',
    ]);
    expect(dependsOn(tickets, 'FEAT-SAMPLE-T001')).toEqual([]);
    expect(dependsOn(tickets, 'FEAT-SAMPLE-T002')).toEqual(['FEAT-SAMPLE-T001']);
    expect(dependsOn(tickets, 'FEAT-SAMPLE-T003')).toEqual(['FEAT-SAMPLE-T001']);
    expect(dependsOn(tickets, 'FEAT-SAMPLE-T004')).toEqual([
      'FEAT-SAMPLE-T002',
      'FEAT-SAMPLE-T003',
    ]);

    // Two of them are parallelisable: same dependency set, neither depends on
    // the other. That is the DAG shape plan Phase 7a asks the DL to produce.
    expect(dependsOn(tickets, 'FEAT-SAMPLE-T002')).toEqual(dependsOn(tickets, 'FEAT-SAMPLE-T003'));

    // Approval 2.
    await factory(['approve', 'FEAT-SAMPLE', 'ship it', '--vault', vault.root]);
    expect(readNoteFile(featureFile).frontmatter.status).toBe('in_development');

    // The whole journey, in order, once each.
    expect(historyLines(readNoteFile(featureFile).body).map(transitionOf)).toEqual([
      'intake → refining',
      'refining → needs_human',
      'needs_human → planning',
      'planning → ticketing',
      'ticketing → needs_human',
      'needs_human → in_development',
    ]);

    // Exactly three agent runs — one per role, no retries, no surprises.
    expect((runner as MockRunner).calls.map((call) => call.role)).toEqual(['pm', 'tl_plan', 'dl']);
  });

  it('leaves tickets in backlog until the breakdown checkpoint is approved', async () => {
    await addFeature('sample', '# Add subtract\n');
    const runner = pipelineRunner();

    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', '', '--vault', vault.root]);

    const second = await orchestrator(vault, runner);
    await cycles(second, 3);
    await second.shutdown();

    // The feature is parked at `after_ticket_breakdown`, so no ticket has
    // moved. A ticket advancing behind the pause would make the checkpoint
    // decorative.
    let tickets = await vault.storage.listTickets('sample');
    expect(tickets.map((ticket) => ticket.frontmatter.status)).toEqual([
      'backlog',
      'backlog',
      'backlog',
      'backlog',
    ]);

    await factory(['approve', 'FEAT-SAMPLE', 'go', '--vault', vault.root]);
    const third = await orchestrator(vault, runner);
    await cycles(third, 1);
    await third.shutdown();

    // Now the DAG opens exactly the one ticket with no dependencies.
    tickets = await vault.storage.listTickets('sample');
    expect(tickets.map((ticket) => ticket.frontmatter.status)).toEqual([
      'ready',
      'backlog',
      'backlog',
      'backlog',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('the Tech Lead asking for refinement', () => {
  it('sends the feature back to refining and puts its questions in the PM\'s next context', async () => {
    await addFeature('sample', '# Add subtract\n');
    const featureFile = vault.paths.featureNote('sample');

    const runner = pipelineRunner({
      tl_plan: {
        structured: tlPayload({
          request_refinement: true,
          questions_for_pm: [
            'Does subtract need to handle non-numeric input?',
            'Is integer overflow in scope?',
          ],
        }),
      },
    });

    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', '', '--vault', vault.root]);

    const second = await orchestrator(vault, runner);
    await cycles(second, 1);
    await second.shutdown();

    const note = readNoteFile(featureFile);
    const transitions = historyLines(note.body).map(transitionOf);
    expect(transitions).toContain('planning → refining');
    expect(historyLines(note.body).find((line) => line.includes('planning → refining'))).toContain(
      'tl_plan',
    );

    // The bounce is not the end of it: `refining` is actionable again, so the
    // PM re-runs inside the same cycle and the feature comes back to its
    // checkpoint. That is the behaviour worth pinning — a bounce that took a
    // whole poll interval to be picked up would be a much slower factory.
    expect(transitions).toEqual([
      'intake → refining',
      'refining → needs_human',
      'needs_human → planning',
      'planning → refining',
      'refining → needs_human',
    ]);

    // And the questions reached the PM. Asserted on the prompt the runner was
    // actually handed — not on a context rebuilt by the test, which could
    // agree with the recipe while the dispatcher passed something else.
    const pmRuns = (runner as MockRunner).calls.filter((call) => call.role === 'pm');
    expect(pmRuns).toHaveLength(2);
    expect(pmRuns[1]?.prompt).toContain('Does subtract need to handle non-numeric input?');
    expect(pmRuns[1]?.prompt).toContain('Is integer overflow in scope?');
    // The first run could not have contained them — they did not exist yet.
    expect(pmRuns[0]?.prompt).not.toContain('integer overflow');
  });
});

// ---------------------------------------------------------------------------

describe('the pipeline keeps running past trouble', () => {
  it('an escalation parks its own feature and a second feature advances in the same cycle', async () => {
    await addFeature('alpha', '# Alpha\n');
    await plantFeature('bravo', 'Bravo');

    const runner = new MockRunner({
      fixtures: {
        'pm:FEAT-ALPHA': { structured: escalation('the requirement contradicts itself') },
        'pm:FEAT-BRAVO': { structured: pmPayload() },
      },
    });

    const instance = await orchestrator(vault, runner);
    // Both features start in `intake`; cycle 1 moves each to `refining` and
    // then runs the PM on each. Both happen in the *same* cycle, which is the
    // point of this test.
    const [report] = await cycles(instance, 1);
    await instance.shutdown();

    const alpha = readNoteFile(vault.paths.featureNote('alpha'));
    expect(alpha.frontmatter.status).toBe('needs_human');
    expect(alpha.frontmatter.pause_reason).toBe('escalation');
    expect(alpha.frontmatter.pause_detail).toContain('contradicts itself');
    // An escalation has a resume target and no reject target: the human fixes
    // whatever the agent was stuck on and approves.
    expect(alpha.frontmatter.resume_to).toBe('refining');
    expect(alpha.frontmatter.reject_to).toBeNull();

    const bravo = readNoteFile(vault.paths.featureNote('bravo'));
    expect(bravo.frontmatter.status).toBe('needs_human');
    expect(bravo.frontmatter.pause_reason).toBe('checkpoint');
    expect(bravo.frontmatter.resume_to).toBe('planning');

    // Explicitly: the second feature advanced inside the cycle that saw the
    // escalation, not in a later one.
    expect(report?.dispatched.map((entry) => entry.itemId)).toContain('FEAT-BRAVO');
    expect(report?.errors).toEqual([]);
    expect(runner.calls.map((call) => call.itemId).sort()).toEqual(['FEAT-ALPHA', 'FEAT-BRAVO']);
  });

  it('a malformed ticket file is quarantined and the cycle completes normally', async () => {
    await addFeature('alpha', '# Alpha\n');
    await plantFeature('bravo', 'Bravo');

    // A ticket note a human broke in Obsidian. It lives under a feature that is
    // otherwise fine, so a scan that gave up here would take both features
    // with it.
    mkdirSync(vault.paths.ticketsDir('alpha'), { recursive: true });
    const broken = vault.paths.ticketPath('alpha', 'FEAT-ALPHA-T001');
    writeFileSync(broken, '---\nid: FEAT-ALPHA-T001\nstatus: [unclosed\n---\n\nbody\n', 'utf8');

    const runner = pipelineRunner();
    const instance = await orchestrator(vault, runner);
    const [report] = await cycles(instance, 1);
    await instance.shutdown();

    expect(report?.quarantined).toEqual([broken]);
    // Reported once for the cycle, not once per re-scan inside it: one bad file
    // must not fill the event log.
    expect(events.ofType('note_malformed').map((event) => event.path)).toEqual([broken]);

    // Not fatal, and not merely "did not throw": both features got their PM run
    // in the cycle that hit the bad file.
    expect(report?.errors).toEqual([]);
    expect(runner.calls.map((call) => call.itemId).sort()).toEqual(['FEAT-ALPHA', 'FEAT-BRAVO']);
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter.status).toBe('needs_human');
    expect(readNoteFile(vault.paths.featureNote('bravo')).frontmatter.status).toBe('needs_human');

    // And the quarantined file is left exactly as the human wrote it — the
    // orchestrator does not "repair" something it could not read.
    expect(readFileSync(broken, 'utf8')).toContain('status: [unclosed');
  });

  it('a note whose status is not a state the machine knows is quarantined too', async () => {
    await addFeature('alpha', '# Alpha\n');
    mkdirSync(vault.paths.ticketsDir('alpha'), { recursive: true });
    const wrong = vault.paths.ticketPath('alpha', 'FEAT-ALPHA-T009');
    writeFileSync(
      wrong,
      '---\ntype: "ticket"\nid: "FEAT-ALPHA-T009"\nstatus: "almost-done"\nfeature: "alpha"\ndepends_on: []\n---\n',
      'utf8',
    );

    const instance = await orchestrator(vault, pipelineRunner());
    const [report] = await cycles(instance, 1);
    await instance.shutdown();

    expect(report?.quarantined).toEqual([wrong]);
    expect(events.ofType('note_malformed')[0]?.reason).toContain('almost-done');
  });
});

// ---------------------------------------------------------------------------

describe('factory kill', () => {
  it('stops new claims while the run in flight finishes', async () => {
    await addFeature('alpha', '# Alpha\n');
    await plantFeature('bravo', 'Bravo');

    // Pressed while the first agent is already running: the transcript is
    // opened at the start of a run, so this lands mid-dispatch.
    let pressed = false;
    const runner = new MockRunner({
      fixtures: { pm: { structured: pmPayload() } },
      openTranscript: async () => {
        if (!pressed) {
          pressed = true;
          await factory(['kill', '--vault', vault.root]);
        }
        return { writeLine: async () => undefined, close: async () => undefined };
      },
    });

    const instance = await orchestrator(vault, runner);
    const [report] = await cycles(instance, 1);
    await instance.shutdown();

    expect(existsSync(vault.paths.killFile())).toBe(true);
    expect(events.ofType('kill_switch').length).toBeGreaterThan(0);

    // Exactly one agent ran: the one already in flight when the switch was
    // pressed. Its result was written — a kill must not discard finished work.
    expect(runner.calls).toHaveLength(1);
    const first = runner.calls[0]?.itemId ?? '';
    expect(report?.dispatched.some((entry) => entry.itemId === first && entry.ran === 'pm')).toBe(true);

    const advanced = readNoteFile(
      vault.paths.featureNote(first === 'FEAT-ALPHA' ? 'alpha' : 'bravo'),
    );
    expect(advanced.frontmatter.status).toBe('needs_human');

    // And nothing new was claimed. Neither note is left holding a claim.
    for (const slug of ['alpha', 'bravo']) {
      expect(readNoteFile(vault.paths.featureNote(slug)).frontmatter.locked_by).toBeNull();
    }

    // A later cycle with the switch still set starts nothing at all.
    const again = await orchestrator(vault, runner);
    const [second] = await cycles(again, 1);
    await again.shutdown();
    expect(second?.killed).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('factory start', () => {
  it('--once runs one cycle, writes the event log, and releases the lock on the way out', async () => {
    await addFeature('alpha', '# Alpha\n');
    const runner = pipelineRunner();

    await factory(['start', '--vault', vault.root, '--once'], { runner });

    // The cycle really ran.
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter.status).toBe('needs_human');

    // The lock is released, so the next `factory start` does not have to
    // reclaim anything — a routine exit must not look like a crash.
    expect(existsSync(vault.paths.instanceLock())).toBe(false);

    // And spec §12's event log exists, one JSON object per line.
    const log = readFileSync(vault.paths.eventLog(), 'utf8').trim().split('\n');
    const types = log.map((line) => (JSON.parse(line) as { type: string; ts: string }).type);
    expect(types).toContain('lock_acquired');
    expect(types).toContain('cycle_started');
    expect(types).toContain('item_transitioned');
    expect(types).toContain('cycle_finished');
    for (const line of log) {
      expect(typeof (JSON.parse(line) as { ts?: unknown }).ts).toBe('string');
    }
  });
});

describe('factory start refuses to run real agents without worktrees', () => {
  /**
   * The default path, exactly as a plain `factory init` leaves it.
   *
   * Before this refusal existed, `factory start` on such a vault built a real
   * `ClaudeCodeRunner` and handed `tl_plan` a working directory of
   * `config.target_repo`. The OS sandbox fences an agent to its working
   * directory (ADR-003), so the fence would have been drawn around the
   * operator's own checkout, with only the tool list in between — which
   * ADR-003 records is not a filesystem boundary.
   */
  function claudeCodeVault(): FactoryFixture {
    return factoryVault({ config: { runner: 'claude-code' } });
  }

  it('the shipped template really does default to claude-code', () => {
    // If this ever stops being true the refusal below is guarding a path
    // nobody takes, and this test would be the only thing to say so.
    const template = readFileSync(
      path.join(process.cwd(), 'vault-template', 'config.yml'),
      'utf8',
    );
    expect(template).toMatch(/^runner:\s*"claude-code"$/m);
    expect(ConfigSchema.parse({ target_repo: '/nowhere' }).runner).toBe('claude-code');
  });

  it('refuses, and never constructs a Runner', async () => {
    const real = claudeCodeVault();
    try {
      let constructed = 0;
      await expect(
        factory(['start', '--vault', real.root, '--once'], {
          runner: () => {
            constructed += 1;
            throw new Error('a Runner was constructed despite the worktree refusal');
          },
        }),
      ).rejects.toThrow(/refusing to start/);
      expect(constructed).toBe(0);

      // Nothing was touched on the way out: no lock, no event log.
      expect(existsSync(real.paths.instanceLock())).toBe(false);
      expect(existsSync(real.paths.eventLog())).toBe(false);
    } finally {
      real.cleanup();
    }
  });

  it('the message names the danger, the phase, and the one-line way forward', async () => {
    const real = claudeCodeVault();
    try {
      const message = await factory(['start', '--vault', real.root, '--once']).then(
        () => '',
        (error: Error) => error.message,
      );

      expect(message).toContain('Phase 8');
      expect(message).toContain('src/git/worktree.ts');
      // Names the actual directory the agent would have been pointed at, so
      // the operator can see what was at risk rather than reading an abstraction.
      expect(message).toContain(real.repo.path);
      expect(message).toContain('ADR-003');
      expect(message).toContain('runner: "mock"');
      expect(message).toContain(real.paths.configFile());
    } finally {
      real.cleanup();
    }
  });

  it('a mock vault still starts — the refusal is about real agents, not about starting', async () => {
    await addFeature('alpha', '# Alpha\n');
    await factory(['start', '--vault', vault.root, '--once'], { runner: pipelineRunner() });
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter.status).toBe('needs_human');
  });

  it('supplying a WorkspaceProvider lifts the refusal — the seam Phase 8 fills', async () => {
    const real = claudeCodeVault();
    try {
      await addFeature('alpha', '# Alpha\n');
      const source = path.join(workspace, 'alpha.md');
      writeFileSync(source, '# Alpha\n', 'utf8');
      await factory(['feature', 'add', source, '--vault', real.root]);

      const asked: string[] = [];
      await factory(['start', '--vault', real.root, '--once'], {
        runner: pipelineRunner(),
        workspace: async (request) => {
          asked.push(`${request.role}:${request.itemId}`);
          return { cwd: workspace };
        },
      });

      // It started, it ran, and the provider — not `config.target_repo` — chose
      // the working directory.
      expect(asked).toEqual(['pm:FEAT-ALPHA']);
      expect(readNoteFile(real.paths.featureNote('alpha')).frontmatter.status).toBe('needs_human');
    } finally {
      real.cleanup();
    }
  });
});

describe('factory start refuses a broken vault before touching an agent', () => {
  it('a deleted target_repo fails with a clear error and spawns no agent process', async () => {
    await addFeature('alpha', '# Alpha\n');

    // The repo the vault is bound to is gone.
    vault.repo.cleanup();

    let constructed = 0;
    const exploding: Runner = {
      run(spec: AgentRunSpec): never {
        throw new Error(`an agent was invoked for ${spec.role} despite a failed startup validation`);
      },
    };

    await expect(
      factory(['start', '--vault', vault.root, '--once'], {
        runner: () => {
          constructed += 1;
          return exploding;
        },
      }),
    ).rejects.toThrow(/target_repo/);

    // And target_repo is the *only* complaint, so the assertion above is about
    // the deleted repo rather than about some unrelated environment problem.
    await expect(
      factory(['start', '--vault', vault.root, '--once'], { runner: () => exploding }),
    ).rejects.toThrow(/startup validation failed \(1 problem\)/);

    // Not merely "no run happened" — the Runner was never even built. Building
    // it eagerly and then failing validation would still exit non-zero, and
    // nobody would notice a CLI process had already been spawned.
    expect(constructed).toBe(0);
    // And no instance lock was left behind by the aborted start.
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('index.md and NEEDS_HUMAN.md', () => {
  it('reflect the vault after a full cycle, and are byte-stable when nothing changed', async () => {
    await addFeature('sample', '# Add subtract\n');
    const runner = pipelineRunner();

    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();

    const paths = new VaultPaths(vault.root);
    let indexMd = readFileSync(paths.indexFile(), 'utf8');
    let needsHuman = readFileSync(paths.needsHumanFile(), 'utf8');

    expect(indexMd).toContain('| 0 |');
    expect(indexMd).toContain('needs_human');
    expect(needsHuman).toContain('FEAT-SAMPLE');
    expect(needsHuman).toContain('checkpoint');
    expect(needsHuman).toContain('factory approve FEAT-SAMPLE');
    expect(needsHuman).not.toContain('_Nothing is waiting on you._');

    // A cycle that changes nothing rewrites identical bytes — the same rule
    // `index.md` has had since Phase 3, now applied to both documents.
    const idle = await orchestrator(vault, runner);
    await cycles(idle, 1);
    await idle.shutdown();
    expect(readFileSync(paths.indexFile(), 'utf8')).toBe(indexMd);
    expect(readFileSync(paths.needsHumanFile(), 'utf8')).toBe(needsHuman);

    // Approving empties the needs-human set, and the file says so.
    await factory(['approve', 'FEAT-SAMPLE', 'go', '--vault', vault.root]);
    needsHuman = readFileSync(paths.needsHumanFile(), 'utf8');
    expect(needsHuman).toContain('_Nothing is waiting on you._');
    expect(needsHuman).not.toContain('FEAT-SAMPLE');

    // And once tickets exist the index counts them by state.
    const second = await orchestrator(vault, runner);
    await cycles(second, 2);
    await second.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', 'go', '--vault', vault.root]);

    indexMd = readFileSync(paths.indexFile(), 'utf8');
    expect(indexMd).toContain('| 4 |');
    expect(indexMd).toContain('backlog 4');
    expect(indexMd).toContain('- Tickets: 4');
    expect(readFileSync(paths.needsHumanFile(), 'utf8')).toContain('_Nothing is waiting on you._');
  });

  it('lists a parked ticket as well as a parked feature', async () => {
    mkdirSync(vault.paths.ticketsDir('demo'), { recursive: true });
    await vault.storage.writeNote(
      vault.paths.featureNote('demo'),
      makeFeature({ id: 'FEAT-DEMO', slug: 'demo', status: 'in_development' }),
    );
    const { makeTicket } = await import('../helpers/notes.js');
    await vault.storage.writeNote(vault.paths.ticketPath('demo', 'FEAT-DEMO-T001'), {
      ...makeTicket({
        id: 'FEAT-DEMO-T001',
        feature: 'demo',
        status: 'needs_human',
        pause_reason: 'attempts_exhausted',
        resume_to: 'in_progress',
        reject_to: null,
      }),
    });

    const instance = await orchestrator(vault, pipelineRunner());
    await cycles(instance, 1);
    await instance.shutdown();

    const needsHuman = readFileSync(vault.paths.needsHumanFile(), 'utf8');
    expect(needsHuman).toContain('FEAT-DEMO-T001');
    expect(needsHuman).toContain('attempts_exhausted');
    // A pause with no reject target says so instead of offering a command that
    // would be refused.
    expect(needsHuman).toContain('no reject target');
  });
});

// ---------------------------------------------------------------------------

describe('unknown frontmatter keys survive a full cycle', () => {
  it('a human-authored key survives dispatch, a checkpoint pause, and an approval', async () => {
    await addFeature('sample', '# Add subtract\n');
    const featureFile = vault.paths.featureNote('sample');

    // Planted by writing markdown to disk and reading it back, the way a human
    // editing the note in Obsidian would. `plantUnknownKey` throws if the key
    // is not there afterwards, so a broken fixture fails loudly rather than
    // making every assertion below vacuous.
    plantUnknownKey(featureFile, 'owner', 'vishal');
    plantUnknownKey(featureFile, 'jira', 'PROJ-412');
    expect(readFrontmatter(featureFile)['owner']).toBe('vishal');
    expect(readFrontmatter(featureFile)['jira']).toBe('PROJ-412');

    const runner = pipelineRunner();

    // 1. `intake → refining` — a plain orchestrator transition.
    // 2. The PM runs and the note is rewritten with new body sections.
    // 3. The checkpoint pause writes five more frontmatter fields.
    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();
    expect(readFrontmatter(featureFile)['owner'], 'lost during dispatch or the pause').toBe('vishal');

    // 4. `factory approve` — a different write path from dispatch entirely.
    await factory(['approve', 'FEAT-SAMPLE', 'go', '--vault', vault.root]);
    expect(readFrontmatter(featureFile)['owner'], 'lost during approve').toBe('vishal');

    // 5. The TL runs, then 6. the DL runs and pauses again.
    const second = await orchestrator(vault, runner);
    await cycles(second, 2);
    await second.shutdown();
    expect(readFrontmatter(featureFile)['owner'], 'lost during the TL or DL run').toBe('vishal');

    // 7. `factory reject` — the other human write path.
    await factory(['reject', 'FEAT-SAMPLE', 'split ticket 4', '--vault', vault.root]);

    const front = readFrontmatter(featureFile);
    expect(front['owner'], 'lost during reject').toBe('vishal');
    expect(front['jira']).toBe('PROJ-412');
    // The cycle really did happen — otherwise the assertions above would hold
    // for a note nothing ever wrote.
    expect(front['status']).toBe('ticketing');
    expect(historyLines(readNoteFile(featureFile).body).length).toBeGreaterThanOrEqual(6);
  });

  it('a key planted on a ticket survives the claim and the backlog → ready transition', async () => {
    await addFeature('sample', '# Add subtract\n');
    const runner = pipelineRunner();

    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', '', '--vault', vault.root]);

    const second = await orchestrator(vault, runner);
    await cycles(second, 2);
    await second.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', '', '--vault', vault.root]);

    const ticketFile = vault.paths.ticketPath('sample', 'FEAT-SAMPLE-T001');
    plantUnknownKey(ticketFile, 'estimate', '2d');
    expect(readFrontmatter(ticketFile)['estimate']).toBe('2d');

    const third = await orchestrator(vault, runner);
    await cycles(third, 1);
    await third.shutdown();

    expect(readFrontmatter(ticketFile)['status']).toBe('ready');
    expect(readFrontmatter(ticketFile)['estimate']).toBe('2d');
  });
});

// ---------------------------------------------------------------------------

describe('failure handling', () => {
  it('an orchestrator-initiated abort does not burn an attempt', async () => {
    // The Phase 7a policy decision (spec §8.1's Phase 5 note). `'timeout'` is
    // the agent's fault and is charged; `'aborted'` is ours and is not, or
    // three `factory stop`s during one item would exhaust it.
    expect(failureConsumesAttempt('aborted')).toBe(false);
    expect(failureConsumesAttempt('timeout')).toBe(true);
    expect(failureConsumesAttempt('crash')).toBe(true);
    expect(failureConsumesAttempt('schema')).toBe(true);
    expect(failureConsumesAttempt('api_error')).toBe(true);

    await addFeature('alpha', '# Alpha\n');
    const runner = new MockRunner({ fixtures: { pm: { failure: 'aborted' } } });

    const instance = await orchestrator(vault, runner);
    await cycles(instance, 1);
    await instance.shutdown();

    const front = readFrontmatter(vault.paths.featureNote('alpha'));
    expect(front['attempts']).toBe(0);
    expect(front['status']).toBe('refining');
    expect(events.ofType('attempt_forgiven')).toHaveLength(1);
    expect(events.ofType('attempt_consumed')).toEqual([]);
  });

  it('a timeout burns an attempt, and three of them park the item', async () => {
    await addFeature('alpha', '# Alpha\n');
    const runner = new MockRunner({ fixtures: { pm: { failure: 'timeout' } } });

    const instance = await orchestrator(vault, runner);
    await cycles(instance, 4);
    await instance.shutdown();

    const front = readFrontmatter(vault.paths.featureNote('alpha'));
    expect(front['attempts']).toBe(3);
    expect(front['status']).toBe('needs_human');
    expect(front['pause_reason']).toBe('timeout');
    expect(front['resume_to']).toBe('refining');
    expect(front['reject_to']).toBeNull();
    expect(String(front['pause_detail'])).toContain('logs/alpha/FEAT-ALPHA-3-pm.log');
    expect(runner.calls).toHaveLength(3);
  });

  it('a payload the schema refuses is a failed attempt, not an advance', async () => {
    await addFeature('alpha', '# Alpha\n');
    // `outcome: escalate` with a null reason — the cross-field rule that
    // `.refine()` enforces and the CLI's own validation cannot (Phase 6).
    const runner = new MockRunner({
      fixtures: {
        pm: { structured: { ...pmPayload(), outcome: 'escalate', escalate_reason: null } },
      },
    });

    const instance = await orchestrator(vault, runner);
    await cycles(instance, 1);
    await instance.shutdown();

    const front = readFrontmatter(vault.paths.featureNote('alpha'));
    expect(front['attempts']).toBe(1);
    expect(front['status']).toBe('refining');
    expect(events.ofType('attempt_consumed')[0]?.failure).toBe('schema');
  });

  it('records what a run cost on the item it ran for', async () => {
    await addFeature('alpha', '# Alpha\n');
    const instance = await orchestrator(vault, pipelineRunner());
    await cycles(instance, 1);
    await instance.shutdown();

    expect(readFrontmatter(vault.paths.featureNote('alpha'))['cost_usd']).toBeCloseTo(0.25, 6);
  });
});

// ---------------------------------------------------------------------------

describe('a second instance', () => {
  it('is refused the lock while the first is alive', async () => {
    const first = await orchestrator(vault, pipelineRunner(), { pid: 1001 });
    try {
      await expect(orchestrator(vault, pipelineRunner(), { pid: 2002 })).rejects.toThrow(
        /another factory instance holds/,
      );
    } finally {
      await first.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------

function dependsOn(tickets: readonly TicketNote[], id: string): string[] {
  const ticket = tickets.find((entry) => entry.frontmatter.id === id);
  if (ticket === undefined) throw new Error(`no ticket ${id}`);
  return [...ticket.frontmatter.depends_on];
}

function transitionOf(line: string): string {
  return line.split(' | ')[1] ?? '';
}

/** Keeps `dlPayload` referenced, so a change to the fixture shape fails here. */
void dlPayload;

// ---------------------------------------------------------------------------

describe('factory stop', () => {
  it('signals the pid in the lock file so the instance drains rather than dies', async () => {
    const instance = await orchestrator(vault, pipelineRunner(), { pid: 31337 });
    const signalled: Array<[number, string]> = [];

    try {
      const result = await runStop(
        {
          vault: vault.root,
          signalProcess: (pid, signal) => signalled.push([pid, signal]),
        },
        deps(),
      );

      expect(result.pid).toBe(31337);
      // SIGTERM, not SIGKILL: `factory start` handles it by finishing the run
      // in flight and releasing the lock. A hard kill would leave a claimed
      // item and a stale lock — recoverable, but there is no reason to make a
      // routine stop look like a crash.
      expect(signalled).toEqual([[31337, 'SIGTERM']]);
    } finally {
      await instance.shutdown();
    }
  });

  it('says so when nothing is running, rather than signalling something', async () => {
    const signalled: number[] = [];
    await expect(
      runStop(
        { vault: vault.root, signalProcess: (pid) => signalled.push(pid) },
        deps(),
      ),
    ).rejects.toThrow(/nothing is running/);
    expect(signalled).toEqual([]);
  });

  it('a lock file that is not readable JSON has no pid to signal, and says which file', async () => {
    writeFileSync(vault.paths.instanceLock(), 'half a write', 'utf8');
    await expect(runStop({ vault: vault.root }, deps())).rejects.toThrow(/not readable JSON/);
  });

  it('requesting a stop ends the poll loop after the cycle in flight', async () => {
    await addFeature('alpha', '# Alpha\n');
    const runner = pipelineRunner();
    const instance = await orchestrator(vault, runner);

    // The same thing `factory start`\'s SIGTERM handler does.
    let cycles = 0;
    const reports = await instance.run({
      maxCycles: 10,
      sleep: async () => {
        cycles += 1;
        if (cycles === 1) instance.requestStop();
      },
    });
    await instance.shutdown();

    expect(instance.stopRequested).toBe(true);
    expect(reports).toHaveLength(1);
    // The cycle that was running completed and its work was written.
    expect(readNoteFile(vault.paths.featureNote('alpha')).frontmatter.status).toBe('needs_human');
    // And the lock is gone, so the next `factory start` is not left reclaiming.
    expect(existsSync(vault.paths.instanceLock())).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('re-running the Delivery Lead after a rejected breakdown', () => {
  /** Drive a feature to the `after_ticket_breakdown` checkpoint with four tickets. */
  async function toBreakdownCheckpoint(runner: MockRunner): Promise<string> {
    await addFeature('sample', '# Add subtract\n');
    const first = await orchestrator(vault, runner);
    await cycles(first, 1);
    await first.shutdown();
    await factory(['approve', 'FEAT-SAMPLE', '', '--vault', vault.root]);

    const second = await orchestrator(vault, runner);
    await cycles(second, 2);
    await second.shutdown();

    expect(readNoteFile(vault.paths.featureNote('sample')).frontmatter.status).toBe('needs_human');
    expect(await vault.storage.listTickets('sample')).toHaveLength(4);
    return vault.paths.featureNote('sample');
  }

  it('a smaller second breakdown leaves no orphan tickets behind', async () => {
    const runner = pipelineRunner();
    await toBreakdownCheckpoint(runner);

    // Reject, and give the DL a genuinely different, smaller answer — which is
    // the entire point of rejecting a breakdown.
    await factory(['reject', 'FEAT-SAMPLE', 'too granular, merge 2 and 3', '--vault', vault.root]);
    runner.set('dl', {
      structured: dlPayload({
        notes_markdown: 'Two tickets this time.',
        tickets: [
          {
            title: 'Add the subtract operation',
            description_md: 'Implement it.',
            acceptance_criteria: ['it subtracts'],
            technical_notes_md: 'src/calc.ts',
            depends_on: [],
          },
          {
            title: 'Test and document subtract',
            description_md: 'Cover it.',
            acceptance_criteria: ['tests pass'],
            technical_notes_md: 'src/calc.test.ts',
            depends_on: ['Add the subtract operation'],
          },
        ],
      }),
    });

    const third = await orchestrator(vault, runner);
    await cycles(third, 1);
    await third.shutdown();

    // Two, not six, and not four with two rewritten. T003 and T004 are gone
    // from disk — left behind they would have become schedulable work with
    // dependencies on a plan nobody was building.
    const tickets = await vault.storage.listTickets('sample');
    expect(tickets.map((ticket) => ticket.frontmatter.id)).toEqual([
      'FEAT-SAMPLE-T001',
      'FEAT-SAMPLE-T002',
    ]);
    expect(tickets[1]?.frontmatter.title).toBe('Test and document subtract');
    expect(existsSync(vault.paths.ticketPath('sample', 'FEAT-SAMPLE-T003'))).toBe(false);
    expect(existsSync(vault.paths.ticketPath('sample', 'FEAT-SAMPLE-T004'))).toBe(false);

    // Every dependency still resolves to a ticket that exists.
    const ids = new Set(tickets.map((ticket) => ticket.frontmatter.id));
    for (const ticket of tickets) {
      for (const dependency of ticket.frontmatter.depends_on) {
        expect(ids).toContain(dependency);
      }
    }

    // And the replacement is on the record, in the log and in the note, so a
    // human knows to look in git for what was there before.
    expect(events.ofType('tickets_replaced')[0]?.removed).toEqual([
      'FEAT-SAMPLE-T001',
      'FEAT-SAMPLE-T002',
      'FEAT-SAMPLE-T003',
      'FEAT-SAMPLE-T004',
    ]);
    expect(sectionText(readNoteFile(vault.paths.featureNote('sample')).body, SECTION.notes)).toContain(
      'replaced a previous breakdown',
    );
  });

  it('a human\'s own frontmatter key on a replaced ticket is carried across', async () => {
    const runner = pipelineRunner();
    await toBreakdownCheckpoint(runner);

    // Edited in Obsidian while the feature sat at the checkpoint — which A8
    // says is exactly when editing is safe.
    const ticketFile = vault.paths.ticketPath('sample', 'FEAT-SAMPLE-T002');
    plantUnknownKey(ticketFile, 'owner', 'vishal');
    plantUnknownKey(ticketFile, 'jira', 'PROJ-412');
    expect(readFrontmatter(ticketFile)['owner']).toBe('vishal');
    const firstWrittenAt = readFrontmatter(ticketFile)['created_at'];

    await factory(['reject', 'FEAT-SAMPLE', 'rework ticket 2', '--vault', vault.root]);
    const third = await orchestrator(vault, runner);
    await cycles(third, 1);
    await third.shutdown();

    // The breakdown was rewritten — and the keys the type system has no slot
    // for came with it.
    const front = readFrontmatter(ticketFile);
    expect(front['owner']).toBe('vishal');
    expect(front['jira']).toBe('PROJ-412');
    // The note genuinely was rewritten from scratch by the second breakdown,
    // so this is not passing because nothing happened.
    expect(front['created_at']).not.toBe(firstWrittenAt);
    expect(front['created_at']).toBe(front['updated_at']);
    expect(await vault.storage.listTickets('sample')).toHaveLength(4);
  });

  it('refuses rather than deleting a ticket that has already left backlog', async () => {
    const runner = pipelineRunner();
    const featureFile = await toBreakdownCheckpoint(runner);

    // Someone put a ticket into `in_progress` by hand and sent the feature back
    // to `ticketing`. There is no transition that does this, so it is a vault a
    // human has edited into an inconsistent state — and deleting a started
    // ticket would throw away its branch, its gate results and its attempts.
    const started = vault.paths.ticketPath('sample', 'FEAT-SAMPLE-T002');
    const note = await vault.storage.readNote<Record<string, unknown>>(started);
    await vault.storage.writeNote(started, {
      frontmatter: { ...note.frontmatter, status: 'in_progress' },
      body: note.body,
    });
    await factory(['reject', 'FEAT-SAMPLE', 'redo it', '--vault', vault.root]);

    const third = await orchestrator(vault, runner);
    await cycles(third, 1);
    await third.shutdown();

    const feature = readNoteFile(featureFile);
    expect(feature.frontmatter.status).toBe('needs_human');
    expect(feature.frontmatter.pause_reason).toBe('escalation');
    expect(String(feature.frontmatter.pause_detail)).toContain('FEAT-SAMPLE-T002');
    expect(String(feature.frontmatter.pause_detail)).toContain('left backlog');
    // Approving re-runs the DL once the human has resolved it.
    expect(feature.frontmatter.resume_to).toBe('ticketing');

    // Nothing was deleted and nothing was rewritten.
    expect(await vault.storage.listTickets('sample')).toHaveLength(4);
    expect(readFrontmatter(started)['status']).toBe('in_progress');
  });

  it('the first breakdown of all reports no replacement', async () => {
    const runner = pipelineRunner();
    await toBreakdownCheckpoint(runner);
    expect(events.ofType('tickets_replaced')).toEqual([]);
    expect(sectionText(readNoteFile(vault.paths.featureNote('sample')).body, SECTION.notes)).not.toContain(
      'replaced a previous breakdown',
    );
  });
});

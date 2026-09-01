/**
 * Human checkpoints, and the approve/reject write path (spec §3.4–3.5).
 *
 * The plan's four cases live here. Two of them are really about
 * `src/orchestrator/actions.ts` — approve and reject are what a checkpoint is
 * *for*, and testing the pause fields without testing what resolves them would
 * leave the pair able to disagree about which field means what.
 *
 * The fourth case, "a checkpoint disabled in config is skipped entirely, with
 * the transition going straight through", is driven through a real dispatch:
 * skipping is a decision the dispatcher makes, and asserting it on the pure
 * helper would assert nothing about the code that reads the config.
 */
import { mkdirSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import { sectionText } from '../../../src/domain/markdown.js';
import { canTransition, historyLines } from '../../../src/domain/transitions.js';
import { ActionError, approve, reject } from '../../../src/orchestrator/actions.js';
import type { ActionContext } from '../../../src/orchestrator/actions.js';
import {
  CHECKPOINTS,
  checkpointEnabled,
  clearPause,
  pauseItem,
} from '../../../src/orchestrator/checkpoints.js';
import { Orchestrator } from '../../../src/orchestrator/loop.js';
import { makeFeature } from '../../helpers/notes.js';
import {
  factoryVault,
  pipelineRunner,
  readNoteFile,
} from '../../helpers/orchestratorFixtures.js';
import type { FactoryFixture } from '../../helpers/orchestratorFixtures.js';
import { cleanupAllScratchDirs, cleanupAllToyRepos } from '../../helpers/toyRepo.js';

const NOW = '2026-09-01T10:00:00.000Z';

let vault: FactoryFixture;

function context(fixture: FactoryFixture): ActionContext {
  return {
    paths: fixture.paths,
    storage: fixture.storage,
    config: fixture.config,
    now: () => NOW,
  };
}

/** A feature note already sitting at a checkpoint, written to disk. */
async function parkedFeature(
  fixture: FactoryFixture,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const slug = 'demo';
  const file = fixture.paths.featureNote(slug);
  mkdirSync(fixture.paths.featureDir(slug), { recursive: true });

  const spec = CHECKPOINTS.after_pm_refinement;
  await fixture.storage.writeNote(file, {
    frontmatter: {
      ...makeFeature({ id: 'FEAT-DEMO', slug, status: 'needs_human' }).frontmatter,
      pause_reason: 'checkpoint',
      pause_detail: spec.description,
      resume_to: spec.resumeTo,
      reject_to: spec.rejectTo,
      paused_at: NOW,
      ...overrides,
    },
    body: '## History\n\n- 2026-09-01T09:00:00Z | refining → needs_human | orchestrator\n',
  });
  return file;
}

beforeEach(() => {
  vault = factoryVault();
});

afterEach(() => {
  vault.cleanup();
});

afterAll(() => {
  cleanupAllScratchDirs();
  cleanupAllToyRepos();
});

describe('the checkpoint table', () => {
  it('matches spec §3.5 exactly', () => {
    expect(CHECKPOINTS.after_pm_refinement).toMatchObject({
      from: 'refining',
      resumeTo: 'planning',
      rejectTo: 'refining',
    });
    expect(CHECKPOINTS.after_ticket_breakdown).toMatchObject({
      from: 'ticketing',
      resumeTo: 'in_development',
      rejectTo: 'ticketing',
    });
    expect(CHECKPOINTS.final_acceptance).toMatchObject({
      from: 'awaiting_feature_close',
      resumeTo: 'done',
      rejectTo: 'in_development',
    });
  });

  it('every checkpoint target is a transition the state machine actually permits', () => {
    // A checkpoint whose `resume_to` is not in the transition table would park
    // an item that `factory approve` then refuses to move — a dead end that
    // only shows up with a human waiting on it.
    for (const spec of Object.values(CHECKPOINTS)) {
      const parked = makeFeature({ status: 'needs_human' });
      expect(
        pauseItem(makeFeature({ status: spec.from }), {
          reason: 'checkpoint',
          detail: spec.description,
          resumeTo: spec.resumeTo,
          rejectTo: spec.rejectTo,
          now: NOW,
          actor: 'orchestrator',
        }).frontmatter.status,
        `${spec.name} cannot pause from ${spec.from}`,
      ).toBe('needs_human');

      // And both targets are reachable from `needs_human` by a human.
      expect(canTransition(parked, spec.resumeTo, 'human').ok, `approve ${spec.name}`).toBe(true);
      expect(canTransition(parked, spec.rejectTo, 'human').ok, `reject ${spec.name}`).toBe(true);
    }
  });

  it('reads the config switch, defaulting a missing one to on', () => {
    expect(checkpointEnabled(vault.config, 'after_pm_refinement')).toBe(true);
    expect(
      checkpointEnabled(
        { human_checkpoints: { ...vault.config.human_checkpoints, final_acceptance: false } },
        'final_acceptance',
      ),
    ).toBe(false);
  });
});

describe('pauseItem', () => {
  it('writes all five spec §3.4 fields plus one history line', () => {
    const paused = pauseItem(makeFeature({ status: 'refining' }, '## History\n'), {
      reason: 'checkpoint',
      detail: 'the PM is done',
      resumeTo: 'planning',
      rejectTo: 'refining',
      now: NOW,
      actor: 'orchestrator',
      historyNote: 'checkpoint after_pm_refinement',
    });

    expect(paused.frontmatter).toMatchObject({
      status: 'needs_human',
      pause_reason: 'checkpoint',
      pause_detail: 'the PM is done',
      resume_to: 'planning',
      reject_to: 'refining',
      paused_at: NOW,
      updated_at: NOW,
    });
    expect(historyLines(paused.body)).toEqual([
      `${NOW} | refining → needs_human | orchestrator | checkpoint after_pm_refinement`,
    ]);
  });

  it('never mutates its input, and preserves an unknown frontmatter key', () => {
    const before = makeFeature({ status: 'refining' });
    const withKey = {
      ...before,
      frontmatter: { ...before.frontmatter, jira: 'PROJ-412' },
    };

    const paused = pauseItem(withKey, {
      reason: 'escalation',
      detail: 'stuck',
      resumeTo: 'refining',
      rejectTo: null,
      now: NOW,
      actor: 'pm',
    });

    expect((paused.frontmatter as Record<string, unknown>)['jira']).toBe('PROJ-412');
    expect(withKey.frontmatter.status).toBe('refining');
  });

  it('clearPause nulls every pause field and keeps everything else', () => {
    const front = { id: 'X', jira: 'PROJ-1', pause_reason: 'checkpoint', paused_at: NOW };
    expect(clearPause(front)).toEqual({
      id: 'X',
      jira: 'PROJ-1',
      pause_reason: null,
      pause_detail: null,
      resume_to: null,
      reject_to: null,
      paused_at: null,
    });
  });
});

describe('approve', () => {
  it('moves the item to resume_to and appends the note to history', async () => {
    const file = await parkedFeature(vault);

    const result = await approve(context(vault), 'FEAT-DEMO', 'looks right, carry on');

    expect(result).toMatchObject({ from: 'needs_human', to: 'planning', kind: 'feature' });

    const note = readNoteFile(file);
    expect(note.frontmatter.status).toBe('planning');
    expect(historyLines(note.body).at(-1)).toBe(
      `${NOW} | needs_human → planning | human | approve: looks right, carry on`,
    );
    // The pause machinery is cleared, or `NEEDS_HUMAN.md` would keep listing it.
    expect(note.frontmatter.pause_reason).toBeNull();
    expect(note.frontmatter.resume_to).toBeNull();
    expect(note.frontmatter.paused_at).toBeNull();
  });

  it('puts the note where the next agent will read it, not only in history', async () => {
    const file = await parkedFeature(vault);
    await approve(context(vault), 'FEAT-DEMO', 'yes, but keep the API shape');

    const body = readNoteFile(file).body;
    expect(sectionText(body, SECTION.notes)).toContain('keep the API shape');
  });

  it('approving an item that is not needs_human is refused', async () => {
    await parkedFeature(vault, { status: 'planning' });

    await expect(approve(context(vault), 'FEAT-DEMO')).rejects.toThrow(ActionError);
    await expect(approve(context(vault), 'FEAT-DEMO')).rejects.toThrow(/is planning, not needs_human/);
  });

  it('an unknown id is refused, and the message names what is actually waiting', async () => {
    await parkedFeature(vault);
    await expect(approve(context(vault), 'FEAT-NOPE')).rejects.toThrow(/FEAT-DEMO/);
  });

  it('a pause with no resume_to cannot be approved', async () => {
    await parkedFeature(vault, { resume_to: null, pause_reason: 'escalation' });
    await expect(approve(context(vault), 'FEAT-DEMO')).rejects.toThrow(/no resume_to/);
  });
});

describe('reject', () => {
  it('moves to reject_to and appends the reason where the next agent will pick it up', async () => {
    const file = await parkedFeature(vault);

    const result = await reject(context(vault), 'FEAT-DEMO', 'the criteria are not testable');

    expect(result).toMatchObject({ from: 'needs_human', to: 'refining' });

    const note = readNoteFile(file);
    expect(note.frontmatter.status).toBe('refining');

    // `## Notes` is deliberately not in `OMITTED_FROM_NOTE_BODY`, so this text
    // is inside the feature note that the PM's next run is handed. History
    // alone would not be — context recipes strip it.
    expect(sectionText(note.body, SECTION.notes)).toContain('the criteria are not testable');
    expect(historyLines(note.body).at(-1)).toContain('reject: the criteria are not testable');
  });

  it('a blank reason is refused — it is what the next agent acts on', async () => {
    await parkedFeature(vault);
    await expect(reject(context(vault), 'FEAT-DEMO', '   ')).rejects.toThrow(/needs a reason/);
  });

  it('a pause with no reject_to cannot be rejected, and says why', async () => {
    await parkedFeature(vault, { reject_to: null, pause_reason: 'escalation' });
    await expect(reject(context(vault), 'FEAT-DEMO', 'no')).rejects.toThrow(/no reject_to/);
  });
});

describe('a checkpoint disabled in config', () => {
  it('is skipped entirely — the transition goes straight through', async () => {
    const disabled = factoryVault({
      config: {
        human_checkpoints: {
          after_pm_refinement: false,
          after_ticket_breakdown: true,
          final_acceptance: true,
        },
      },
    });

    try {
      const slug = 'demo';
      mkdirSync(disabled.paths.featureDir(slug), { recursive: true });
      const file = disabled.paths.featureNote(slug);
      await disabled.storage.writeNote(
        file,
        makeFeature({ id: 'FEAT-DEMO', slug, status: 'refining' }, '## History\n'),
      );

      const orchestrator = await Orchestrator.start({
        paths: disabled.paths,
        config: disabled.config,
        storage: disabled.storage,
        runner: pipelineRunner(),
        now: () => NOW,
        isAlive: () => true,
      });
      await orchestrator.runCycle();
      await orchestrator.shutdown();

      const note = readNoteFile(file);
      const transitions = historyLines(note.body).map((line) => line.split(' | ')[1]);

      // Straight from `refining` to `planning`. Not `refining → needs_human`
      // and back: "disabled" means the item never stops, not that it is
      // auto-approved after stopping. With no pause in the way the cycle then
      // carries on through the Tech Lead and the Delivery Lead, and stops at
      // the *enabled* `after_ticket_breakdown` checkpoint — which is the
      // control showing the config switch is read per checkpoint, not globally.
      expect(transitions).toEqual([
        'refining → planning',
        'planning → ticketing',
        'ticketing → needs_human',
      ]);
      expect(note.frontmatter.status).toBe('needs_human');
      expect(note.frontmatter.resume_to).toBe('in_development');
    } finally {
      disabled.cleanup();
    }
  });
});

/**
 * Context recipes (spec §6.2).
 *
 * ============================================================================
 * WHY ONE OF THESE TESTS BUILDS ITS FIXTURE THE SLOW WAY
 * ============================================================================
 * A recipe extracts note sections by heading, and the four heading names it
 * needs — `## Refined Requirement`, `## Tech Plan`, `## Review Notes`,
 * `## QA Notes` — were **inferred during Phase 3, never specified**. They live
 * in `SECTION_ORDER`.
 *
 * The obvious test writes a fixture note containing `## Review Notes`, runs the
 * recipe, and asserts the content comes back. If the recipe and the fixture
 * share the same wrong spelling, they agree with each other and the test is
 * green while the production writer disagrees with both. That test restates the
 * implementation instead of pinning the requirement.
 *
 * So the fixtures here are written through `MarkdownStorage.appendSection` —
 * the exact call Phase 7's orchestrator will make — and the heading the test
 * asks for is looked up in `SECTION_ORDER` **by its required wording**, spelled
 * out below as a literal. Rename the constant and this file goes red twice:
 * once because the lookup finds nothing, and once because `src/agents/context.ts`
 * refuses to load.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MissingContextError,
  RECIPES,
  SECTION,
  buildContext,
  sectionHeading,
} from '../../../src/agents/context.js';
import type { ContextRequest } from '../../../src/agents/context.js';
import { ROLES } from '../../../src/domain/roles.js';
import type { Storage } from '../../../src/vault/storage.js';
import { SECTION_ORDER } from '../../../src/vault/storage.js';
import { agentVault } from '../../helpers/agentFixtures.js';
import { cleanupAllScratchDirs, scratchDir } from '../../helpers/toyRepo.js';

afterAll(() => {
  cleanupAllScratchDirs();
});

/**
 * The heading wordings this feature depends on, as required values rather than
 * as whatever the constant currently happens to say. `sectionOrderEntry` fails
 * loudly if `SECTION_ORDER` no longer offers one.
 */
function sectionOrderEntry(wording: string): string {
  const match = SECTION_ORDER.find((heading) => heading === wording);
  expect(
    match,
    `SECTION_ORDER no longer contains ${JSON.stringify(wording)}. Context recipes read note ` +
      'sections by that heading, so a rename here silently extracts nothing (plan Phase 6).',
  ).toBeDefined();
  return match as string;
}

const REVIEW_NOTES = sectionOrderEntry('## Review Notes');
const QA_NOTES = sectionOrderEntry('## QA Notes');
const ACCEPTANCE_CRITERIA = sectionOrderEntry('## Acceptance Criteria');

/** A repo directory containing only a `CLAUDE.md`. */
async function repoWithClaudeMd(body: string): Promise<string> {
  const repo = scratchDir('agent-repo-');
  await writeFile(path.join(repo, 'CLAUDE.md'), body, 'utf8');
  return repo;
}

describe('section headings come from SECTION_ORDER', () => {
  it('every heading the recipes use is a SECTION_ORDER entry', () => {
    for (const heading of Object.values(SECTION)) {
      expect(SECTION_ORDER as readonly string[]).toContain(heading);
    }
  });

  it('a heading name SECTION_ORDER does not define is refused, not silently accepted', () => {
    // The failure this guards is an empty extraction: `findHeading` returns -1
    // for a misspelling and the agent gets a well-formed prompt with one
    // section blank. Refusing at lookup time turns that into a crash instead.
    expect(() => sectionHeading('Reviewer Notes')).toThrow(/SECTION_ORDER/);
    expect(() => sectionHeading('review notes')).toThrow(/SECTION_ORDER/);
  });
});

describe('buildContext — developer', () => {
  it('includes the ticket, the tech plan, project.md, and the repo CLAUDE.md when present', async () => {
    const vault = await agentVault({
      projectMd: '# Project\n\nPROJECT_MARKER\n',
      techPlanMd: '# Tech plan\n\nTECHPLAN_MARKER\n',
      tickets: [{ id: 'FEATDEMO-T001', sections: [[ACCEPTANCE_CRITERIA, 'TICKET_MARKER']] }],
    });
    const repo = await repoWithClaudeMd('# Conventions\n\nCLAUDEMD_MARKER\n');

    const { prompt, report } = await buildContext(RECIPES.developer, {
      storage: vault.storage,
      paths: vault.paths,
      featureSlug: vault.slug,
      ticketId: 'FEATDEMO-T001',
      repoRoot: repo,
      attempt: 1,
    });

    for (const marker of ['PROJECT_MARKER', 'TECHPLAN_MARKER', 'TICKET_MARKER', 'CLAUDEMD_MARKER']) {
      expect(prompt, `developer context is missing ${marker}`).toContain(marker);
    }
    expect(report.docs.map((doc) => doc.id)).toContain('repo_claude_md');
    expect(report.totalChars).toBe(prompt.length);
  });

  it('adds the prior Review Notes and QA Notes only on a retry', async () => {
    // The round-trip that can actually fail: the sections are written by the
    // real `MarkdownStorage.appendSection`, and read back by the real recipe.
    const vault = await agentVault({
      tickets: [
        {
          id: 'FEATDEMO-T001',
          sections: [
            [REVIEW_NOTES, 'REVIEW_MARKER — the error path is untested.'],
            [QA_NOTES, 'QA_MARKER — criterion 2 failed.'],
          ],
        },
      ],
    });

    const request: ContextRequest = {
      storage: vault.storage,
      paths: vault.paths,
      featureSlug: vault.slug,
      ticketId: 'FEATDEMO-T001',
      attempt: 1,
    };

    const first = await buildContext(RECIPES.developer, request);
    expect(first.prompt).not.toContain('REVIEW_MARKER');
    expect(first.prompt).not.toContain('QA_MARKER');

    const retry = await buildContext(RECIPES.developer, { ...request, attempt: 2 });
    expect(retry.prompt, 'a retry must see why the last attempt bounced').toContain('REVIEW_MARKER');
    expect(retry.prompt).toContain('QA_MARKER');
    expect(retry.report.docs.filter((doc) => doc.included).map((doc) => doc.id)).toEqual(
      expect.arrayContaining(['review_notes', 'qa_notes']),
    );
  });

  it('skips a missing optional document silently and refuses a missing required one', async () => {
    const vault = await agentVault({
      tickets: [{ id: 'FEATDEMO-T001' }],
    });

    // No repoRoot at all, and no prior notes: all optional, all skipped.
    const { prompt, report } = await buildContext(RECIPES.developer, {
      storage: vault.storage,
      paths: vault.paths,
      featureSlug: vault.slug,
      ticketId: 'FEATDEMO-T001',
      attempt: 2,
    });
    expect(prompt.length).toBeGreaterThan(0);
    const skipped = report.docs.filter((doc) => !doc.included);
    expect(skipped.map((doc) => doc.id)).toEqual(
      expect.arrayContaining(['repo_claude_md', 'review_notes', 'qa_notes']),
    );
    for (const doc of skipped) expect(doc.reason).toBe('missing');

    // The tech plan is required for the developer: without it the agent would
    // invent an architecture, so this fails rather than producing a thin prompt.
    await rm(vault.paths.techPlan(vault.slug));
    await expect(
      buildContext(RECIPES.developer, {
        storage: vault.storage,
        paths: vault.paths,
        featureSlug: vault.slug,
        ticketId: 'FEATDEMO-T001',
        attempt: 1,
      }),
    ).rejects.toBeInstanceOf(MissingContextError);
  });
});

describe('buildContext — size', () => {
  it('drops the lowest-priority document over the limit and reports the truncation', async () => {
    const filler = 'X'.repeat(4_000);
    const vault = await agentVault({
      tickets: [{ id: 'FEATDEMO-T001' }],
    });
    const repo = await repoWithClaudeMd(`# Conventions\n\nCLAUDEMD_MARKER\n${filler}\n`);

    const request: ContextRequest = {
      storage: vault.storage,
      paths: vault.paths,
      featureSlug: vault.slug,
      ticketId: 'FEATDEMO-T001',
      repoRoot: repo,
      attempt: 1,
    };

    const full = await buildContext(RECIPES.developer, request);
    expect(full.report.truncated).toBe(false);
    expect(full.prompt).toContain('CLAUDEMD_MARKER');

    const squeezed = await buildContext(RECIPES.developer, { ...request, maxChars: 1_500 });
    expect(squeezed.report.truncated, 'the oversize context was not recorded as truncated').toBe(true);
    expect(squeezed.report.dropped.map((doc) => doc.id)).toContain('repo_claude_md');
    expect(squeezed.prompt, 'the dropped document is still in the prompt').not.toContain(
      'CLAUDEMD_MARKER',
    );
    // The dropped document's size survives in the report, so the event log can
    // say how much context an agent did not get.
    expect(squeezed.report.dropped[0]?.chars).toBeGreaterThan(4_000);
    expect(squeezed.report.limitChars).toBe(1_500);

    // The ticket is required and is never dropped to fit; when nothing droppable
    // is left the report says so instead of silently shipping a stub prompt.
    const impossible = await buildContext(RECIPES.developer, { ...request, maxChars: 10 });
    expect(impossible.report.overLimit).toBe(true);
    expect(impossible.prompt).toContain('FEATDEMO-T001');
  });
});

describe('buildContext — cross-ticket leakage', () => {
  it('no recipe ever injects another ticket of the same feature', async () => {
    const vault = await agentVault({
      tickets: [
        { id: 'FEATDEMO-T001', title: 'Mine', sections: [[ACCEPTANCE_CRITERIA, 'MINE_MARKER']] },
        {
          id: 'FEATDEMO-T002',
          title: 'Someone else',
          sections: [
            [ACCEPTANCE_CRITERIA, 'OTHER_TICKET_MARKER'],
            [REVIEW_NOTES, 'OTHER_REVIEW_MARKER'],
          ],
        },
      ],
    });

    /**
     * A storage that refuses to enumerate tickets.
     *
     * Grepping the recipes for `listTickets` would prove the same thing only
     * until someone adds a helper that calls it. This proves it structurally:
     * any recipe that reaches for "the feature's tickets" rather than "this
     * ticket" throws here.
     */
    const fenced: Storage = new Proxy(vault.storage, {
      get(target, property, receiver): unknown {
        if (property === 'listTickets' || property === 'listFeatures') {
          return (): never => {
            throw new Error(`a context recipe called ${String(property)} — that is how one ticket ends up seeing another`);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const request: ContextRequest = {
      storage: fenced,
      paths: vault.paths,
      featureSlug: vault.slug,
      ticketId: 'FEATDEMO-T001',
      attempt: 2,
      diff: 'diff --git a/src/calc.ts b/src/calc.ts',
    };

    for (const role of ROLES) {
      const { prompt } = await buildContext(RECIPES[role], request);
      expect(prompt, `${role} leaked another ticket's acceptance criteria`).not.toContain(
        'OTHER_TICKET_MARKER',
      );
      expect(prompt, `${role} leaked another ticket's review notes`).not.toContain('OTHER_REVIEW_MARKER');
      expect(prompt).not.toContain('FEATDEMO-T002');
    }

    const mine = await buildContext(RECIPES.qa, request);
    expect(mine.prompt, 'the ticket under work must still be present').toContain('MINE_MARKER');
  });
});

describe('recipes — per role', () => {
  it('there is exactly one recipe per role and each names its own role', () => {
    expect(Object.keys(RECIPES).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) expect(RECIPES[role].role).toBe(role);
  });

  it('every role builds a non-empty context from a complete vault', async () => {
    const vault = await agentVault({
      techDocs: { 'architecture.md': '# Architecture\n\nTECHDOC_MARKER\n' },
      tickets: [{ id: 'FEATDEMO-T001', sections: [[ACCEPTANCE_CRITERIA, 'TICKET_MARKER']] }],
    });

    for (const role of ROLES) {
      const { prompt, report } = await buildContext(RECIPES[role], {
        storage: vault.storage,
        paths: vault.paths,
        featureSlug: vault.slug,
        ticketId: 'FEATDEMO-T001',
        attempt: 1,
        diff: 'diff --git a/src/calc.ts b/src/calc.ts',
      });
      expect(prompt.length, `${role} produced an empty context`).toBeGreaterThan(0);
      expect(report.docs.some((doc) => doc.included), `${role} included nothing`).toBe(true);
    }
  });

  it('the tl_plan recipe injects every document in the vault tech directory', async () => {
    const vault = await agentVault({
      techDocs: {
        'architecture.md': 'ARCHITECTURE_MARKER',
        'conventions.md': 'CONVENTIONS_MARKER',
        'notes.txt': 'NOT_MARKDOWN_MARKER',
      },
    });

    const { prompt } = await buildContext(RECIPES.tl_plan, {
      storage: vault.storage,
      paths: vault.paths,
      featureSlug: vault.slug,
      attempt: 1,
    });

    expect(prompt).toContain('ARCHITECTURE_MARKER');
    expect(prompt).toContain('CONVENTIONS_MARKER');
    expect(prompt, 'only markdown belongs in the tech injection').not.toContain('NOT_MARKDOWN_MARKER');
  });

  it('a ticket-scoped recipe refuses to run without a ticket id', async () => {
    const vault = await agentVault({ tickets: [{ id: 'FEATDEMO-T001' }] });
    await expect(
      buildContext(RECIPES.developer, {
        storage: vault.storage,
        paths: vault.paths,
        featureSlug: vault.slug,
        attempt: 1,
      }),
    ).rejects.toThrow(/ticket/i);
  });
});

/**
 * Fixtures for the Phase 6 agent-layer tests.
 *
 * Two things live here, and the second one is the reason this file exists at
 * all.
 *
 * 1. `validOutput(role)` — one known-good structured payload per role, so the
 *    schema tests start from something that passes and then break exactly one
 *    thing at a time.
 * 2. `agentVault()` — a real vault on disk, written **through
 *    `MarkdownStorage`**, never by hand-writing markdown into a string.
 *
 * That second point is the whole design. A context recipe extracts note
 * sections by heading. If a test builds its fixture by typing `## Review Notes`
 * into a template literal and the recipe reads the same typo, the two agree
 * with each other and the test is green while the production writer — which
 * uses `SECTION_ORDER` — disagrees with both. Building the fixture with
 * `appendSection` puts the real writer on one side of the test and the real
 * reader on the other, which is the only arrangement in which they can be
 * caught disagreeing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Role } from '../../src/domain/roles.js';
import { MarkdownStorage } from '../../src/vault/storage.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { makeFeature, makeTicket } from './notes.js';
import { scratchDir } from './toyRepo.js';

/** One valid structured payload per role (spec §5). */
export function validOutput(role: Role): Record<string, unknown> {
  const base = { outcome: 'ok', escalate_reason: null, notes_markdown: 'some notes' };

  switch (role) {
    case 'pm':
      return {
        ...base,
        refined_requirement: 'Add a subtract operation.',
        scope_in: ['subtract'],
        scope_out: ['divide'],
        acceptance_criteria: ['subtract(3, 1) returns 2'],
        questions_for_tl: [],
      };
    case 'tl_plan':
      return {
        ...base,
        feasibility: 'Straightforward — one pure function plus a test.',
        risks: ['none material'],
        phases: ['Add the operation', 'Add its tests'],
        questions_for_pm: [],
        request_refinement: false,
        tech_doc_updates: [],
      };
    case 'dl':
      return {
        ...base,
        tickets: [
          {
            title: 'Add subtract to calc',
            description_md: 'Implement `subtract` in `src/calc.ts`.',
            acceptance_criteria: ['subtract(3, 1) === 2'],
            technical_notes_md: 'Register it in `OPERATIONS`.',
            depends_on: [],
          },
        ],
      };
    case 'developer':
      return {
        ...base,
        summary: 'Added subtract and its test.',
        files_changed: ['src/calc.ts', 'src/calc.test.ts'],
        commit_message: 'feat: add subtract operation',
        tests_added: ['subtract returns the difference'],
      };
    case 'code_reviewer':
      return {
        ...base,
        verdict: 'approve',
        findings: [
          { file: 'src/calc.ts', line: 12, severity: 'nit', message: 'Consider a doc comment.' },
        ],
      };
    case 'qa':
      return {
        ...base,
        verdict: 'pass',
        criteria_results: [
          {
            criterion: 'subtract(3, 1) === 2',
            result: 'pass',
            evidence_command: 'npm test',
            evidence_output: 'ok 1 - subtract returns the difference',
          },
        ],
      };
    default: {
      const unreachable: never = role;
      throw new Error(`no fixture payload for role ${String(unreachable)}`);
    }
  }
}

export interface AgentVaultTicket {
  readonly id: string;
  readonly title?: string;
  /** Section heading → markdown, written through `MarkdownStorage.appendSection`. */
  readonly sections?: ReadonlyArray<readonly [heading: string, markdown: string]>;
}

export interface AgentVaultOptions {
  readonly slug?: string;
  readonly projectMd?: string;
  readonly featureBody?: string;
  readonly featureSections?: ReadonlyArray<readonly [heading: string, markdown: string]>;
  readonly techPlanMd?: string | null;
  readonly techDocs?: Readonly<Record<string, string>>;
  readonly tickets?: readonly AgentVaultTicket[];
}

export interface AgentVault {
  readonly root: string;
  readonly slug: string;
  readonly paths: VaultPaths;
  readonly storage: MarkdownStorage;
}

/**
 * A vault on disk with a project file, a feature, and any tickets asked for.
 *
 * Every section is written with `appendSection`, i.e. the same call Phase 7's
 * orchestrator will make. See the header note.
 */
export async function agentVault(options: AgentVaultOptions = {}): Promise<AgentVault> {
  const slug = options.slug ?? 'demo';
  const root = scratchDir('agent-vault-');
  const paths = new VaultPaths(root);
  const storage = new MarkdownStorage(paths);

  await mkdir(paths.featureDir(slug), { recursive: true });
  await mkdir(paths.techDir(), { recursive: true });

  await writeFile(paths.projectFile(), options.projectMd ?? '# Project\n\nA toy calculator.\n', 'utf8');

  for (const [name, body] of Object.entries(options.techDocs ?? {})) {
    await writeFile(path.join(paths.techDir(), name), body, 'utf8');
  }

  await storage.writeNote(
    paths.featureNote(slug),
    makeFeature({ id: `FEAT-${slug.toUpperCase()}`, slug }, options.featureBody ?? ''),
  );
  for (const [heading, markdown] of options.featureSections ?? []) {
    await storage.appendSection(paths.featureNote(slug), heading, markdown);
  }

  if (options.techPlanMd !== null) {
    await writeFile(
      paths.techPlan(slug),
      options.techPlanMd ?? '# Tech plan\n\nOne pure function.\n',
      'utf8',
    );
  }

  for (const ticket of options.tickets ?? []) {
    const file = paths.ticketPath(slug, ticket.id);
    await mkdir(path.dirname(file), { recursive: true });
    await storage.writeNote(
      file,
      makeTicket({ id: ticket.id, feature: slug, title: ticket.title ?? ticket.id }),
    );
    for (const [heading, markdown] of ticket.sections ?? []) {
      await storage.appendSection(file, heading, markdown);
    }
  }

  return { root, slug, paths, storage };
}

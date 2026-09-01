/**
 * Fixtures for the Phase 7a orchestrator tests.
 *
 * A real vault on disk, built from the shipped `vault-template/` and bound to a
 * real toy git repo, plus the canned agent payloads the M2 pipeline replays.
 *
 * Two things here are deliberate rather than convenient:
 *
 * 1. **The vault comes from `vault-template/`**, not from a hand-written
 *    fixture. `project.md` is a required context document for four of the six
 *    roles, so a hand-made vault that happened to omit it would make
 *    `buildContext` throw in a way no real vault ever could — and a fixture
 *    that quietly differs from what `factory init` produces is a test that
 *    proves something about the fixture.
 *
 * 2. **`plantUnknownKey` writes raw markdown and parses it back.** The whole
 *    point of the unknown-key test is that `Note<T>` has no slot for such a
 *    key. Building the note through `makeFeature()` and adding the key to the
 *    typed object would exercise a shape the parser never produces; going
 *    through the file makes the key arrive exactly as a human's Obsidian edit
 *    would.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../../src/config/load.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Role } from '../../src/domain/roles.js';
import type { AnyNote, Note } from '../../src/domain/types.js';
import { MockRunner } from '../../src/runner/mock.js';
import type { MockRunFixture } from '../../src/runner/mock.js';
import { parseNote, serializeNote } from '../../src/vault/note.js';
import { VaultPaths } from '../../src/vault/paths.js';
import { MarkdownStorage } from '../../src/vault/storage.js';
import { scratchDir, toyRepo } from './toyRepo.js';
import type { ToyRepo } from './toyRepo.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = path.join(PROJECT_ROOT, 'vault-template');

export interface FactoryFixture {
  readonly root: string;
  readonly paths: VaultPaths;
  readonly storage: MarkdownStorage;
  readonly config: FactoryConfig;
  readonly repo: ToyRepo;
  cleanup(): void;
}

export interface FixtureOptions {
  /** Merged over the template config before it is validated. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** A vault created from the shipped template, bound to a fresh toy repo. */
export function factoryVault(options: FixtureOptions = {}): FactoryFixture {
  const repo = toyRepo();
  const root = scratchDir('orch-vault-');
  cpSync(TEMPLATE, root, { recursive: true });

  const paths = new VaultPaths(root);
  const overrides = {
    target_repo: repo.path,
    base_branch: repo.branch,
    runner: 'mock',
    poll_interval: 1,
    ...(options.config ?? {}),
  };

  // Written as YAML by hand rather than through `yaml.stringify` so the file
  // stays readable in a failure message. `parseConfig` then proves it is valid,
  // so a typo here fails at fixture build time rather than mid-test.
  const lines = Object.entries(overrides).map(([key, value]) => `${key}: ${toYaml(value)}`);
  const text = `${lines.join('\n')}\n`;
  writeFileSync(paths.configFile(), text, 'utf8');
  const config = parseConfig(text, paths.configFile());

  mkdirSync(paths.featuresDir(), { recursive: true });
  mkdirSync(paths.logsDir(), { recursive: true });

  return {
    root,
    paths,
    storage: new MarkdownStorage(paths),
    config,
    repo,
    cleanup(): void {
      repo.cleanup();
    },
  };
}

function toYaml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(toYaml).join(', ')}]`;
  if (typeof value === 'object') {
    const inner = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `  ${key}: ${toYaml(entry)}`)
      .join('\n');
    return `\n${inner}`;
  }
  throw new Error(`orchestratorFixtures: cannot emit ${String(value)} as YAML`);
}

/**
 * Add a frontmatter key the type system has never heard of, by going through
 * the file.
 *
 * Returns the value that was planted, so a caller can assert it is present
 * **before** running anything. A fixture that silently failed to plant the key
 * would make the survival assertion vacuous, which is the exact way this test
 * is usually got wrong.
 */
export function plantUnknownKey(file: string, key: string, value: string): string {
  const raw = readFileSync(file, 'utf8');
  const note = parseNote<Record<string, unknown>>(raw, file);
  const withKey: Note<Record<string, unknown>> = {
    frontmatter: { ...note.frontmatter, [key]: value },
    body: note.body,
  };
  writeFileSync(file, serializeNote(withKey), 'utf8');

  const readBack = parseNote<Record<string, unknown>>(readFileSync(file, 'utf8'), file);
  if (readBack.frontmatter[key] !== value) {
    throw new Error(
      `plantUnknownKey failed to put ${key} on ${file}. Every later assertion about it ` +
        'surviving would have passed for the wrong reason.',
    );
  }
  return value;
}

/** Read a note's frontmatter as a loose record, for unknown-key assertions. */
export function readFrontmatter(file: string): Record<string, unknown> {
  return parseNote<Record<string, unknown>>(readFileSync(file, 'utf8'), file).frontmatter;
}

/** Read a note back through the real parser. */
export function readNoteFile(file: string): AnyNote {
  return parseNote<AnyNote['frontmatter']>(readFileSync(file, 'utf8'), file) as AnyNote;
}

// ---------------------------------------------------------------------------
// Canned agent payloads.
// ---------------------------------------------------------------------------

export interface DlTicketSpec {
  readonly title: string;
  readonly depends_on?: readonly string[];
}

const BASE = { outcome: 'ok', escalate_reason: null } as const;

export function pmPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown: 'The PM read the requirement and rewrote it as testable statements.',
    refined_requirement: 'Add a `subtract(a, b)` operation to the calculator.',
    scope_in: ['subtract in src/calc.ts', 'a unit test for it'],
    scope_out: ['divide', 'a CLI'],
    acceptance_criteria: ['subtract(3, 1) returns 2', 'subtract(1, 3) returns -2'],
    questions_for_tl: [],
    ...overrides,
  };
}

export function tlPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown:
      '## Approach\n\nOne pure function in `src/calc.ts`, registered in `OPERATIONS`.\n\n' +
      '## Phases\n\n1. Add the function.\n2. Add its test.\n',
    feasibility: 'Straightforward. `src/calc.ts` already has an operation table.',
    risks: ['none material'],
    phases: ['Add subtract', 'Add its test'],
    questions_for_pm: [],
    request_refinement: false,
    tech_doc_updates: [],
    ...overrides,
  };
}

/** The 4-ticket, 2-parallelisable breakdown plan Phase 7a's pipeline test wants. */
export function dlPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...BASE,
    notes_markdown: 'Four tickets. Two of them have no dependency on each other.',
    tickets: [
      ticket('Add the subtract operation', []),
      ticket('Add subtract unit tests', ['Add the subtract operation']),
      ticket('Document subtract in the README', ['Add the subtract operation']),
      ticket('Wire subtract into the operations table', [
        'Add subtract unit tests',
        'Document subtract in the README',
      ]),
    ],
    ...overrides,
  };
}

function ticket(title: string, dependsOn: readonly string[]): Record<string, unknown> {
  return {
    title,
    description_md: `Do the work described by: ${title}.`,
    acceptance_criteria: [`${title} is done and verifiable`],
    technical_notes_md: 'Touch only `src/calc.ts` and its test.',
    depends_on: [...dependsOn],
  };
}

export function escalation(reason: string): Record<string, unknown> {
  return {
    outcome: 'escalate',
    escalate_reason: reason,
    notes_markdown: 'Stopping rather than guessing.',
    refined_requirement: '',
    scope_in: [],
    scope_out: [],
    acceptance_criteria: [],
    questions_for_tl: [],
  };
}

/** A MockRunner wired for the whole M2 paper pipeline. */
export function pipelineRunner(
  overrides: Readonly<Record<string, MockRunFixture>> = {},
): MockRunner {
  return new MockRunner({
    fixtures: {
      pm: { structured: pmPayload(), costUsd: 0.25 },
      tl_plan: { structured: tlPayload(), costUsd: 0.6 },
      dl: { structured: dlPayload(), costUsd: 0.4 },
      ...overrides,
    },
  });
}

/** `<role>:<itemId>` — the MockRunner key most tests want. */
export function keyFor(role: Role, itemId: string): string {
  return `${role}:${itemId}`;
}

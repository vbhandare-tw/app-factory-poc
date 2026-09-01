/**
 * Section names come from `SECTION_ORDER`, never string literals.
 *
 * A mirror of the grep in `test/integration/agents.test.ts`, extended to the
 * orchestrator — which is the layer that *writes* the sections the context
 * recipes then read back.
 *
 * The failure it guards is silent in both directions. A recipe with a
 * mistyped heading extracts an empty string and the agent runs on a blank
 * section; a **writer** with a mistyped heading creates a second, near-identical
 * section that nothing ever reads, leaving the real one empty. Neither throws,
 * neither shows up in a diff review, and both look like a working system.
 *
 * `SECTION` in `src/agents/context.ts` resolves each name against
 * `SECTION_ORDER` at module load and throws if the constant no longer offers
 * it, so a rename becomes a crash on first import rather than a quiet
 * degradation on the tenth ticket. This test is what keeps every orchestrator
 * write going through that lookup.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SECTION } from '../../../src/agents/context.js';
import { SECTION_ORDER } from '../../../src/vault/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SRC = path.resolve(HERE, '..', '..', '..', 'src', 'orchestrator');
const CLI_SRC = path.resolve(HERE, '..', '..', '..', 'src', 'cli');

/**
 * Note **section** headings are always `## ` — every `SECTION_ORDER` entry is.
 * A single `#` is a different thing entirely: the title line of a generated
 * document (`tech-plan.md`), or a shell-style comment inside `.kill`. Matching
 * those would force real prose to be laundered through a constant for nothing,
 * so the pattern starts at two hashes. The `namesAreNotLiterals` check below
 * closes the gap that leaves — a heading spelled `# Review Notes` would still
 * be caught there, because the *name* would be in the source.
 */
const HEADING_LITERAL = /(['"`])\s*#{2,6}\s[^'"`]*\1/g;

/** Source with comments removed, so prose about `## History` is not a hit. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function tsFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(directory, name));
}

const ORCHESTRATOR_FILES = tsFiles(ORCHESTRATOR_SRC);
const CLI_FILES = tsFiles(CLI_SRC);

describe('src/orchestrator', () => {
  it('there is source to check', () => {
    // Guards the grep itself: a glob that stopped matching would report a clean
    // codebase, which is exactly what a passing run looks like.
    expect(ORCHESTRATOR_FILES.length).toBeGreaterThanOrEqual(7);
  });

  it.each(ORCHESTRATOR_FILES.map((file) => [path.basename(file), file] as const))(
    '%s contains no markdown heading literal',
    (name, file) => {
      const matches = codeOf(file).match(HEADING_LITERAL) ?? [];
      expect(
        matches,
        `${name} builds a heading as a literal instead of asking SECTION_ORDER`,
      ).toEqual([]);
    },
  );

  it.each(ORCHESTRATOR_FILES.map((file) => [path.basename(file), file] as const))(
    '%s does not spell a section name out in a string at all',
    (name, file) => {
      // Closes the `#{2,6}` exemption above, and one more route: a heading
      // rebuilt as `\`## ${'Review Notes'}\``. If the words are in the source,
      // somebody is naming a section rather than asking the constant.
      const code = codeOf(file);
      for (const heading of SECTION_ORDER) {
        const bare = heading.replace(/^#+\s*/, '');
        expect(code, `${name} names the ${bare} section instead of using SECTION`).not.toContain(
          `'${bare}'`,
        );
        expect(code).not.toContain(`"${bare}"`);
      }
    },
  );
});

describe('the CLI commands that write note sections', () => {
  it.each(CLI_FILES.map((file) => [path.basename(file), file] as const))(
    '%s contains no markdown heading literal',
    (name, file) => {
      const matches = codeOf(file).match(HEADING_LITERAL) ?? [];
      expect(
        matches,
        `${name} builds a heading as a literal instead of asking SECTION_ORDER`,
      ).toEqual([]);
    },
  );
});

describe('the sections Phase 7a writes', () => {
  it('every one of them is a SECTION_ORDER entry', () => {
    for (const heading of Object.values(SECTION)) {
      expect(SECTION_ORDER as readonly string[]).toContain(heading);
    }
  });

  it('`## Notes` exists and is not stripped from an injected note body', async () => {
    // Phase 7a added this section, and its whole purpose is that the *next*
    // agent reads it: the Tech Lead's questions back to the PM, and a human's
    // approve/reject reason both land here. A section added to `SECTION_ORDER`
    // but also added to the omitted set would silently swallow all three.
    expect(SECTION_ORDER as readonly string[]).toContain('## Notes');

    const { removeSections } = await import('../../../src/domain/markdown.js');
    const body = `${SECTION.notes}\n\nthe reviewer's question\n\n${SECTION.history}\n\n- a line\n`;
    // `removeSections` with the set `context.ts` omits: History, Review Notes,
    // QA Notes. `## Notes` must survive it.
    const kept = removeSections(body, [SECTION.reviewNotes, SECTION.qaNotes, SECTION.history]);
    expect(kept).toContain("the reviewer's question");
    expect(kept).not.toContain('- a line');
  });

  it('History is still last, so nothing Phase 7a added lands below the audit trail', () => {
    expect(SECTION_ORDER[SECTION_ORDER.length - 1]).toBe('## History');
    expect(SECTION_ORDER.indexOf('## Notes')).toBe(SECTION_ORDER.length - 2);
  });
});

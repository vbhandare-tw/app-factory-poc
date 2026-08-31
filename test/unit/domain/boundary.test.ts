import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The pure-domain boundary, tested rather than trusted.
 *
 * `no-restricted-imports` fails *open*: if the `files` glob stops matching
 * `src/domain/**`, or a new import style slips past the patterns, the rule
 * reports nothing and a codebase with I/O in the domain layer looks exactly
 * like a clean one. `npm run lint` passing is therefore not evidence that the
 * boundary exists.
 *
 * These tests lint synthetic sources through the real config and assert the
 * rule fires. They fail if a future edit to eslint.config.js quietly disarms
 * it. Each case here corresponds to a bypass that was verified by hand first.
 */
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: PROJECT_ROOT });
});

const DOMAIN_FILE = path.join(PROJECT_ROOT, 'src', 'domain', '__boundary_probe__.ts');
const OUTSIDE_FILE = path.join(PROJECT_ROOT, 'src', 'vault', '__boundary_probe__.ts');

async function lint(filePath: string, code: string): Promise<ESLint.LintResult> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  const first = results[0];
  if (first === undefined) {
    throw new Error(`eslint returned no result for ${filePath} — is the path being ignored?`);
  }
  return first;
}

const boundaryRuleIds = (result: ESLint.LintResult): string[] =>
  result.messages
    .map((message) => message.ruleId)
    .filter(
      (ruleId): ruleId is string =>
        ruleId === '@typescript-eslint/no-restricted-imports' ||
        ruleId === 'no-restricted-imports' ||
        ruleId === 'no-restricted-syntax',
    );

describe('src/domain may not reach the filesystem or spawn processes', () => {
  const forbidden: [label: string, code: string][] = [
    ['static import of node:fs', "import fs from 'node:fs';\nexport const x = fs;\n"],
    [
      'static import of node:fs/promises',
      "import { readFile } from 'node:fs/promises';\nexport const x = readFile;\n",
    ],
    ['static import of bare fs', "import fs from 'fs';\nexport const x = fs;\n"],
    [
      'static import of node:child_process',
      "import { spawn } from 'node:child_process';\nexport const x = spawn;\n",
    ],
    [
      'static import of bare child_process',
      "import cp from 'child_process';\nexport const x = cp;\n",
    ],
    [
      'type-only import of node:fs',
      "import type { Stats } from 'node:fs';\nexport type X = Stats;\n",
    ],
    [
      'dynamic import of node:fs',
      "export async function x(): Promise<unknown> { return import('node:fs'); }\n",
    ],
    [
      'dynamic import of node:child_process',
      "export async function x(): Promise<unknown> { return import('node:child_process'); }\n",
    ],
    [
      'computed dynamic import',
      "const m = 'node:fs';\nexport async function x(): Promise<unknown> { return import(m); }\n",
    ],
    [
      'createRequire escape hatch',
      "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\n",
    ],
  ];

  it.each(forbidden)('%s is rejected', async (_label, code) => {
    const result = await lint(DOMAIN_FILE, code);
    expect(
      boundaryRuleIds(result),
      `expected the domain boundary rule to fire; got: ${JSON.stringify(result.messages)}`,
    ).not.toEqual([]);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});

describe('src/domain may not import another src/ layer', () => {
  const forbidden: [label: string, code: string][] = [
    [
      'relative import of a sibling layer',
      "import { paths } from '../vault/paths.js';\nexport const x = paths;\n",
    ],
    [
      'type-only import of a sibling layer',
      "import type { Storage } from '../vault/storage.js';\nexport type X = Storage;\n",
    ],
    [
      'import that climbs two levels',
      "import { x as y } from '../../src/runner/mock.js';\nexport const x = y;\n",
    ],
    [
      'dynamic import of a sibling layer',
      "export async function x(): Promise<unknown> { return import('../git/git.js'); }\n",
    ],
  ];

  it.each(forbidden)('%s is rejected', async (_label, code) => {
    const result = await lint(DOMAIN_FILE, code);
    expect(
      boundaryRuleIds(result),
      `expected the domain boundary rule to fire; got: ${JSON.stringify(result.messages)}`,
    ).not.toEqual([]);
  });
});

describe('the boundary is scoped to src/domain, not applied everywhere', () => {
  it('allows a domain file to import its own siblings', async () => {
    const result = await lint(
      DOMAIN_FILE,
      "import { ROLES } from './roles.js';\nexport const x = ROLES;\n",
    );
    expect(boundaryRuleIds(result)).toEqual([]);
  });

  it('allows another layer to use node:fs and node:child_process', async () => {
    // If this ever starts failing, the `files` glob has become a blanket ban
    // and every later phase is about to be blocked from doing real work.
    const result = await lint(
      OUTSIDE_FILE,
      [
        "import fs from 'node:fs';",
        "import { spawn } from 'node:child_process';",
        "import { ROLES } from '../domain/roles.js';",
        'export const x = [fs, spawn, ROLES];',
        '',
      ].join('\n'),
    );
    expect(boundaryRuleIds(result)).toEqual([]);
  });
});

describe('the real domain sources pass the boundary', () => {
  it('src/domain/**/*.ts is clean under the full config', async () => {
    const results = await eslint.lintFiles(['src/domain/**/*.ts']);
    expect(results.length, 'the glob matched no files — the boundary is guarding nothing').toBeGreaterThan(0);
    const problems = results.flatMap((result) =>
      result.messages.map((message) => `${result.filePath}:${message.line} ${message.ruleId ?? '?'} ${message.message}`),
    );
    expect(problems).toEqual([]);
  });
});

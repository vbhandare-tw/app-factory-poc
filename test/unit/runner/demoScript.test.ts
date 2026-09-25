/**
 * The demo feature's script (dashboard plan Phase 6). Every payload has to pass
 * its role's schema, and the developer's files have to pass the toy app's real
 * gates on every ticket branch: a demo that parks on a red gate teaches the
 * wrong lesson on its first run.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { validateAgentOutput } from '../../../src/agents/schemas.js';
import type { DeveloperOutput, DlOutput, QaOutput } from '../../../src/agents/schemas.js';
import { detectCycles, resolveActionable } from '../../../src/domain/dag.js';
import { featureId, ticketId } from '../../../src/domain/ids.js';
import { ROLES } from '../../../src/domain/roles.js';
import type { Role } from '../../../src/domain/roles.js';
import {
  DEMO_FEATURE_ID,
  DEMO_REQUIREMENT,
  DEMO_SCRIPT,
  DEMO_SLUG,
} from '../../../src/runner/demoScript.js';
import type { DemoStep } from '../../../src/runner/demoScript.js';
import { TOY_APP_FIXTURE, cleanupAllScratchDirs, run, scratchDir } from '../../helpers/toyRepo.js';

afterAll(() => cleanupAllScratchDirs());

const GATES = [
  ['npm', ['test']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build']],
] as const;

const GATE_COMMANDS = [
  'npm test',
  'npm run lint',
  'npm run build',
  'npm test && npm run lint && npm run build',
];

interface ScriptedTicket {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly criteria: readonly string[];
  readonly developer: DemoStep;
  readonly qa: DemoStep;
}

function step(key: string): DemoStep {
  const found = DEMO_SCRIPT[key];
  if (found === undefined) throw new Error(`the demo script has no step ${key}`);
  return found;
}

function breakdown(): DlOutput {
  return step('dl').structured as DlOutput;
}

/** The DL's tickets, with the ids the orchestrator will give them and the steps that build them. */
function tickets(): ScriptedTicket[] {
  const payload = breakdown();
  const idByTitle = new Map(payload.tickets.map((t, index) => [t.title, ticketId(DEMO_FEATURE_ID, index + 1)]));
  return payload.tickets.map((t, index) => {
    const id = ticketId(DEMO_FEATURE_ID, index + 1);
    return {
      id,
      title: t.title,
      dependsOn: t.depends_on.map((title) => idByTitle.get(title) ?? `unknown title ${title}`),
      criteria: t.acceptance_criteria,
      developer: step(`developer:${id}`),
      qa: step(`qa:${id}`),
    };
  });
}

/** A ticket and everything it depends on, transitively: the least its branch will contain. */
function closure(all: readonly ScriptedTicket[], ticket: ScriptedTicket): ScriptedTicket[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const seen = new Map<string, ScriptedTicket>();
  const visit = (current: ScriptedTicket): void => {
    if (seen.has(current.id)) return;
    seen.set(current.id, current);
    for (const dependency of current.dependsOn) {
      const found = byId.get(dependency);
      if (found !== undefined) visit(found);
    }
  };
  visit(ticket);
  return [...seen.values()];
}

/** A copy of the toy app with these tickets' files written into it, as their branch would hold them. */
function toyAppWith(label: string, built: readonly ScriptedTicket[]): string {
  const dir = path.join(scratchDir(`demo-gates-${label}-`), 'app');
  cpSync(TOY_APP_FIXTURE, dir, {
    recursive: true,
    filter: (source) => !['node_modules', 'dist'].includes(path.basename(source)),
  });
  for (const ticket of built) {
    for (const [relative, contents] of Object.entries(ticket.developer.write ?? {})) {
      mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      writeFileSync(path.join(dir, relative), contents, 'utf8');
    }
  }
  return dir;
}

describe('the payloads', () => {
  it('every structured payload validates against its role schema in src/agents/schemas.ts', () => {
    expect(Object.keys(DEMO_SCRIPT).length).toBeGreaterThan(0);
    for (const [key, entry] of Object.entries(DEMO_SCRIPT)) {
      const role = key.split(':')[0] as Role;
      expect(ROLES, `${key} does not start with a role`).toContain(role);
      const verdict = validateAgentOutput(role, entry.structured);
      expect(verdict, `${key}: ${verdict.ok ? '' : verdict.issues.join('; ')}`).toEqual({ ok: true });
    }
  });

  it('covers the whole feature: PM, TL and DL once, then a developer, a reviewer and QA per ticket, and nothing else', () => {
    expect(featureId(DEMO_SLUG)).toBe(DEMO_FEATURE_ID);
    expect(DEMO_REQUIREMENT.split('\n')[0]).toBe('# Expression calculator');

    const ids = breakdown().tickets.map((_, index) => ticketId(DEMO_FEATURE_ID, index + 1));
    expect(ids).toHaveLength(4);
    const expected = [
      'pm',
      'tl_plan',
      'dl',
      ...ids.flatMap((id) => [`developer:${id}`, `code_reviewer:${id}`, `qa:${id}`]),
    ];
    expect(Object.keys(DEMO_SCRIPT).sort()).toEqual([...expected].sort());
  });

  it('only the developer writes files, and it writes exactly the files its payload names', () => {
    for (const [key, entry] of Object.entries(DEMO_SCRIPT)) {
      if (!key.startsWith('developer:')) {
        expect(entry.write, `${key} writes files`).toBeUndefined();
        continue;
      }
      const payload = entry.structured as DeveloperOutput;
      expect(Object.keys(entry.write ?? {}).sort()).toEqual([...payload.files_changed, ...payload.tests_added].sort());
    }
  });
});

describe('the breakdown', () => {
  it('gives each ticket files no other ticket touches, so no ticket conflicts with, or overwrites, another', () => {
    const owner = new Map<string, string>();
    for (const ticket of tickets()) {
      const files = Object.keys(ticket.developer.write ?? {});
      expect(files.length, `${ticket.id} writes nothing`).toBeGreaterThan(0);
      for (const file of files) {
        expect(owner.get(file), `${file} is written by both ${owner.get(file) ?? ''} and ${ticket.id}`).toBeUndefined();
        owner.set(file, ticket.id);
      }
    }
  });

  it('depends_on forms a DAG, and two tickets can start at once', () => {
    const nodes = tickets().map((ticket) => ({
      id: ticket.id,
      status: 'backlog' as const,
      depends_on: [...ticket.dependsOn],
    }));
    expect(nodes.flatMap((node) => node.depends_on).filter((id) => id.startsWith('unknown'))).toEqual([]);
    expect(detectCycles(nodes)).toEqual([]);
    expect(resolveActionable(nodes).map((node) => node.id)).toEqual([
      ticketId(DEMO_FEATURE_ID, 1),
      ticketId(DEMO_FEATURE_ID, 2),
    ]);
  });
});

describe('QA', () => {
  it('checks exactly the ticket’s acceptance criteria, and passes each one', () => {
    for (const ticket of tickets()) {
      const payload = ticket.qa.structured as QaOutput;
      expect(payload.verdict).toBe('pass');
      expect(payload.criteria_results.map((entry) => entry.criterion)).toEqual(ticket.criteria);
      expect(payload.criteria_results.every((entry) => entry.result === 'pass')).toBe(true);
    }
  });

  it('cites only tests that exist in the ticket’s own test file', () => {
    let citations = 0;
    for (const ticket of tickets()) {
      const payload = ticket.qa.structured as QaOutput;
      const testFile = (ticket.developer.structured as DeveloperOutput).tests_added[0] ?? '';
      const source = ticket.developer.write?.[testFile] ?? '';
      const cited = payload.criteria_results
        .map((entry) => /^passed: (.+)$/.exec(entry.evidence_output)?.[1])
        .filter((name): name is string => name !== undefined);
      citations += cited.length;
      for (const name of cited) {
        expect(source, `${ticket.id} cites a test that ${testFile} does not have`).toContain(`test('${name}'`);
      }
    }
    expect(citations, 'no QA evidence cites a test, so this check checked nothing').toBeGreaterThan(0);
  });
});

describe('the developer’s files, on the toy app’s real gates', () => {
  it(
    'pass npm test, npm run lint and npm run build on every ticket branch, and QA’s command-line evidence is what they print',
    () => {
      const all = tickets();
      for (const ticket of all) {
        const built = closure(all, ticket);
        const dir = toyAppWith(ticket.id, built);

        for (const [command, args] of GATES) {
          const result = run(dir, command, args);
          expect(
            result.status,
            `${ticket.id} (with ${built.map((t) => t.id).join(', ')}): \`${command} ${args.join(' ')}\` ` +
              `exited ${result.status}\n${result.stdout}\n${result.stderr}`,
          ).toBe(0);
        }

        for (const entry of (ticket.qa.structured as QaOutput).criteria_results) {
          if (entry.evidence_command.startsWith('npm ')) {
            // Only the gate commands just run above, so their exit codes are already proved.
            expect(GATE_COMMANDS, entry.criterion).toContain(entry.evidence_command);
            expect(entry.evidence_output, entry.criterion).toMatch(/^(passed: .+|Exited 0\.|All three exited 0\.)$/);
            continue;
          }
          const shell = spawnSync(entry.evidence_command, { cwd: dir, shell: true, encoding: 'utf8' });
          expect(shell.stdout.trim(), `${ticket.id}: ${entry.evidence_command}\n${shell.stderr}`).toBe(
            entry.evidence_output,
          );
        }
      }
    },
    120_000,
  );
});

/**
 * The feature `factory demo` builds, as scripted agent output. Its payloads must pass their role
 * schemas and its files the toy app's real gates; `test/unit/runner/demoScript.test.ts` checks both.
 */
import { featureId, ticketId } from '../domain/ids.js';

export const DEMO_SLUG = 'expression-calculator';
export const DEMO_FEATURE_ID = featureId(DEMO_SLUG);

export const DEMO_REQUIREMENT = [
  '# Expression calculator',
  '',
  'The calculator can only apply one named operation to two numbers. Make it work on whole',
  'expressions:',
  '',
  '- **Evaluate an expression** such as `2 + 3 * 4`, which is `14`: `*` and `/` before `+` and `-`,',
  '  parentheses, and any amount of whitespace. Malformed input and division by zero raise a clear,',
  '  named error, never `NaN` or `Infinity`.',
  '- **Format a result** for a person: at most six significant digits and no trailing zeros, so',
  '  `10 / 3` reads `3.33333` and `4` reads `4`.',
  '- **A command line**: type an expression in a terminal and see the formatted result. A bad',
  '  expression prints a short message and exits with a non-zero status, never a stack trace.',
  '',
].join('\n');

export const DEMO_PROJECT_MD = [
  '# Project',
  '',
  '## What this is',
  '',
  '`toy-app` is a small calculator library, copied here by `factory demo`. The agents in this vault',
  'are scripted: they cost nothing, and every file they write is fixed in advance. The worktrees,',
  'commits, gates and merges around them are real.',
  '',
  '## Stack and conventions',
  '',
  '- **Node 22, TypeScript, ESM only.** Node runs `.ts` files through type stripping, so only',
  '  erasable syntax is allowed.',
  '- **Zero npm dependencies.**',
  "- **Relative imports carry the real extension**: `import { add } from './calc.ts'`.",
  '- **Tests** use `node:test` and `node:assert/strict`, beside the code as `src/<name>.test.ts`.',
  '- **Errors** are named classes extending `Error`.',
  '',
  '## Gates',
  '',
  '`npm test`, `npm run lint` and `npm run build` must each exit 0.',
  '',
  '## Working agreement',
  '',
  '- The orchestrator is the only writer of this vault. Agents return structured output and the',
  '  orchestrator writes it.',
  '- `factory demo --fresh` deletes this demo and starts it again.',
  '',
].join('\n');

/** One scripted agent run. */
export interface DemoStep {
  /** Shown in the live transcript: the first line before the pause, the rest after it. */
  readonly say: readonly [string, ...string[]];
  /** Read before the pause, relative to the run's working directory. */
  readonly read?: readonly string[];
  /** Written after the pause, by path relative to the run's working directory. */
  readonly write?: Readonly<Record<string, string>>;
  readonly structured: unknown;
}

interface Criterion {
  readonly text: string;
  readonly command: string;
  readonly output: string;
}

interface Finding {
  readonly file: string;
  readonly line: number | null;
  readonly severity: 'minor' | 'nit';
  readonly message: string;
}

interface DemoTicket {
  readonly title: string;
  readonly module: string;
  readonly dependsOn: readonly string[];
  readonly description: string;
  readonly criteria: readonly Criterion[];
  readonly notes: string;
  readonly read: readonly string[];
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly source: string;
  readonly test: string;
}

const BASE = { outcome: 'ok', escalate_reason: null } as const;

const CLI = 'node --disable-warning=ExperimentalWarning --experimental-strip-types src/cli.ts';

const GATES_PASS: Criterion = {
  text: '`npm test`, `npm run lint` and `npm run build` exit 0',
  command: 'npm test && npm run lint && npm run build',
  output: 'All three exited 0.',
};

/** Toy-app source, byte for byte: backslashes kept, the newline after the opening backtick dropped. */
function toy(strings: TemplateStringsArray): string {
  return (strings.raw[0] ?? '').replace(/^\n/, '');
}

const TICKETS: readonly DemoTicket[] = [
  {
    title: 'Add the tokeniser',
    module: 'tokenise',
    dependsOn: [],
    description:
      'Create `src/tokenise.ts` exporting `tokenise(input: string): Token[]`. It turns an expression ' +
      'into number, operator and parenthesis tokens and skips whitespace. An unknown character throws ' +
      '`TokeniseError`, which records where it was.',
    criteria: [
      {
        text: "`tokenise('(2 + 3.5) * 4')` returns its seven tokens in order",
        command: 'npm test',
        output: 'passed: tokenise splits numbers, operators and parentheses',
      },
      {
        text: 'Whitespace between tokens makes no difference',
        command: 'npm test',
        output: 'passed: tokenise ignores whitespace',
      },
      {
        text: 'An unknown character throws `TokeniseError` carrying its position',
        command: 'npm test',
        output: 'passed: tokenise reports an unknown character and where it is',
      },
      GATES_PASS,
    ],
    notes: 'Touch only `src/tokenise.ts` and `src/tokenise.test.ts`. A number is digits with an optional decimal part.',
    read: ['CLAUDE.md'],
    summary:
      'Added `tokenise`, which splits an expression into number, operator and parenthesis tokens, and ' +
      '`TokeniseError` for anything else.',
    findings: [
      {
        file: 'src/tokenise.ts',
        line: null,
        severity: 'nit',
        message: '`TokeniseError` keeps the position but not the character; the character is only in the message.',
      },
    ],
    source: toy`
/** Splits an arithmetic expression into numbers, operators and parentheses. */

export type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'operator'; readonly symbol: string }
  | { readonly kind: 'paren'; readonly symbol: '(' | ')' };

export class TokeniseError extends Error {
  readonly position: number;

  constructor(character: string, position: number) {
    super('Unexpected character "' + character + '" at position ' + position);
    this.name = 'TokeniseError';
    this.position = position;
  }
}

const OPERATOR_SYMBOLS = ['+', '-', '*', '/'];
const NUMBER = /^\d+(\.\d+)?/;

export function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input.charAt(index);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const number = NUMBER.exec(input.slice(index));
    if (number !== null) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    if (OPERATOR_SYMBOLS.includes(character)) {
      tokens.push({ kind: 'operator', symbol: character });
    } else if (character === '(' || character === ')') {
      tokens.push({ kind: 'paren', symbol: character });
    } else {
      throw new TokeniseError(character, index);
    }
    index += 1;
  }
  return tokens;
}
`,
    test: toy`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokeniseError, tokenise } from './tokenise.ts';

test('tokenise splits numbers, operators and parentheses', () => {
  assert.deepEqual(tokenise('(2 + 3.5) * 4'), [
    { kind: 'paren', symbol: '(' },
    { kind: 'number', value: 2 },
    { kind: 'operator', symbol: '+' },
    { kind: 'number', value: 3.5 },
    { kind: 'paren', symbol: ')' },
    { kind: 'operator', symbol: '*' },
    { kind: 'number', value: 4 },
  ]);
});

test('tokenise ignores whitespace', () => {
  assert.deepEqual(tokenise('  7 -  1 '), tokenise('7-1'));
});

test('tokenise reports an unknown character and where it is', () => {
  assert.throws(
    () => tokenise('2 $ 3'),
    (error: unknown) => error instanceof TokeniseError && error.position === 2,
  );
});
`,
  },
  {
    title: 'Add the number formatter',
    module: 'formatNumber',
    dependsOn: [],
    description:
      'Create `src/formatNumber.ts` exporting `formatNumber(value: number): string`: at most six ' +
      'significant digits, no trailing zeros, and no exponent for ordinary sizes.',
    criteria: [
      {
        text: "`formatNumber(10 / 3)` returns `'3.33333'`",
        command: 'npm test',
        output: 'passed: formatNumber keeps at most six significant digits',
      },
      {
        text: "`formatNumber(4)` returns `'4'` and `formatNumber(2.5)` returns `'2.5'`",
        command: 'npm test',
        output: 'passed: formatNumber drops trailing zeros',
      },
      {
        text: "`formatNumber(100000)` returns `'100000'`, not exponent notation",
        command: 'npm test',
        output: 'passed: formatNumber writes ordinary sizes without an exponent',
      },
      {
        text: 'A value that is not finite throws `RangeError`',
        command: 'npm test',
        output: 'passed: formatNumber refuses a value that is not finite',
      },
      GATES_PASS,
    ],
    notes:
      'Touch only `src/formatNumber.ts` and `src/formatNumber.test.ts`. `Number(value.toPrecision(6))` ' +
      'rounds and drops the trailing zeros in one step.',
    read: ['CLAUDE.md'],
    summary: 'Added `formatNumber`, which rounds to six significant digits and drops trailing zeros.',
    findings: [],
    source: toy`
/** Renders a number for a person: at most six significant digits, no trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError('Cannot format ' + String(value));
  }
  return String(Number(value.toPrecision(6)));
}
`,
    test: toy`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatNumber } from './formatNumber.ts';

test('formatNumber keeps at most six significant digits', () => {
  assert.equal(formatNumber(10 / 3), '3.33333');
});

test('formatNumber drops trailing zeros', () => {
  assert.equal(formatNumber(4), '4');
  assert.equal(formatNumber(2.5), '2.5');
});

test('formatNumber writes ordinary sizes without an exponent', () => {
  assert.equal(formatNumber(100000), '100000');
});

test('formatNumber refuses a value that is not finite', () => {
  assert.throws(() => formatNumber(Infinity), RangeError);
});
`,
  },
  {
    title: 'Add the expression evaluator',
    module: 'evaluate',
    dependsOn: ['Add the tokeniser'],
    description:
      'Create `src/evaluate.ts` exporting `evaluate(input: string): number` and `ParseError`. It ' +
      'tokenises with `tokenise` and applies each operator through `OPERATIONS` in `src/calc.ts`, so ' +
      '`*` and `/` bind tighter than `+` and `-`, and parentheses group.',
    criteria: [
      {
        text: "`evaluate('2 + 3 * 4')` returns `14`",
        command: 'npm test',
        output: 'passed: evaluate multiplies before it adds',
      },
      {
        text: "`evaluate('(2 + 3) * 4')` returns `20` and `evaluate('10 - 4 / 2')` returns `8`",
        command: 'npm test',
        output: 'passed: evaluate honours parentheses and divides before it subtracts',
      },
      {
        text: "Malformed input such as `'2 +'` or `'(2 + 3'` throws `ParseError`",
        command: 'npm test',
        output: 'passed: evaluate rejects malformed input with a ParseError',
      },
      {
        text: "`evaluate('5 / 0')` throws `DivideByZeroError` from `src/calc.ts`",
        command: 'npm test',
        output: 'passed: evaluate reports division by zero instead of returning Infinity',
      },
      GATES_PASS,
    ],
    notes:
      'Touch only `src/evaluate.ts` and `src/evaluate.test.ts`. Apply operators through `OPERATIONS` ' +
      'rather than writing the arithmetic again.',
    read: ['src/calc.ts', 'src/tokenise.ts'],
    summary:
      'Added `evaluate`, a recursive-descent evaluator over the tokeniser that applies operators through ' +
      '`OPERATIONS`, and `ParseError` for malformed input.',
    findings: [
      {
        file: 'src/evaluate.ts',
        line: null,
        severity: 'minor',
        message:
          'A leading minus such as `-2 + 3` is rejected. That matches the out-of-scope list, but the ' +
          'error could say so.',
      },
    ],
    source: toy`
/** Evaluates an arithmetic expression: * and / before + and -, parentheses first. */
import { OPERATIONS, UnknownOperationError } from './calc.ts';
import { tokenise } from './tokenise.ts';
import type { Token } from './tokenise.ts';

export class ParseError extends Error {
  readonly input: string;

  constructor(problem: string, input: string) {
    super(problem + ' in "' + input + '"');
    this.name = 'ParseError';
    this.input = input;
  }
}

interface Cursor {
  readonly input: string;
  readonly tokens: readonly Token[];
  position: number;
}

export function evaluate(input: string): number {
  const cursor: Cursor = { input, tokens: tokenise(input), position: 0 };
  const value = sum(cursor);
  if (cursor.position < cursor.tokens.length) {
    throw new ParseError('Unexpected text after the expression', input);
  }
  return value;
}

function sum(cursor: Cursor): number {
  let value = product(cursor);
  let symbol = operatorAt(cursor, ['+', '-']);
  while (symbol !== null) {
    cursor.position += 1;
    value = apply(symbol, value, product(cursor));
    symbol = operatorAt(cursor, ['+', '-']);
  }
  return value;
}

function product(cursor: Cursor): number {
  let value = factor(cursor);
  let symbol = operatorAt(cursor, ['*', '/']);
  while (symbol !== null) {
    cursor.position += 1;
    value = apply(symbol, value, factor(cursor));
    symbol = operatorAt(cursor, ['*', '/']);
  }
  return value;
}

function factor(cursor: Cursor): number {
  const token = cursor.tokens[cursor.position];
  cursor.position += 1;
  if (token !== undefined && token.kind === 'number') {
    return token.value;
  }
  if (token !== undefined && token.kind === 'paren' && token.symbol === '(') {
    const value = sum(cursor);
    const closing = cursor.tokens[cursor.position];
    if (closing === undefined || closing.kind !== 'paren' || closing.symbol !== ')') {
      throw new ParseError('Missing closing parenthesis', cursor.input);
    }
    cursor.position += 1;
    return value;
  }
  throw new ParseError('Expected a number', cursor.input);
}

function operatorAt(cursor: Cursor, symbols: readonly string[]): string | null {
  const token = cursor.tokens[cursor.position];
  if (token !== undefined && token.kind === 'operator' && symbols.includes(token.symbol)) {
    return token.symbol;
  }
  return null;
}

function apply(symbol: string, left: number, right: number): number {
  const operation = OPERATIONS.find((candidate) => candidate.symbol === symbol);
  if (operation === undefined) {
    throw new UnknownOperationError(symbol);
  }
  return operation.apply(left, right);
}
`,
    test: toy`
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DivideByZeroError } from './calc.ts';
import { ParseError, evaluate } from './evaluate.ts';

test('evaluate multiplies before it adds', () => {
  assert.equal(evaluate('2 + 3 * 4'), 14);
});

test('evaluate honours parentheses and divides before it subtracts', () => {
  assert.equal(evaluate('(2 + 3) * 4'), 20);
  assert.equal(evaluate('10 - 4 / 2'), 8);
});

test('evaluate rejects malformed input with a ParseError', () => {
  for (const input of ['2 +', '(2 + 3', '2 3', '']) {
    assert.throws(() => evaluate(input), ParseError, input);
  }
});

test('evaluate reports division by zero instead of returning Infinity', () => {
  assert.throws(() => evaluate('5 / 0'), DivideByZeroError);
});
`,
  },
  {
    title: 'Add the command-line entry point',
    module: 'cli',
    dependsOn: ['Add the expression evaluator', 'Add the number formatter'],
    description:
      'Create `src/cli.ts` exporting `runCli(args, output): number`, which evaluates and formats one ' +
      'expression and returns the exit code. The module runs it only when Node runs the file directly.',
    criteria: [
      {
        text: `\`${CLI} "2 + 3 * 4"\` prints \`14\` and exits 0`,
        command: `${CLI} "2 + 3 * 4"; echo "exit $?"`,
        output: '14\nexit 0',
      },
      {
        text: 'A malformed expression prints one line with no stack trace and exits 1',
        command: `${CLI} "2 +" 2>&1; echo "exit $?"`,
        output: 'ParseError: Expected a number in "2 +"\nexit 1',
      },
      {
        text: 'Importing `src/cli.ts` runs nothing, so `npm run build` still passes',
        command: 'npm run build',
        output: 'Exited 0.',
      },
      GATES_PASS,
    ],
    notes:
      'Touch only `src/cli.ts` and `src/cli.test.ts`. Write with `process.stdout.write`: the lint gate ' +
      'forbids `console.log` under `src/`. `npm run build` imports every module, so call `runCli` only ' +
      'behind an entry-point check.',
    read: ['src/evaluate.ts', 'src/formatNumber.ts'],
    summary: 'Added `runCli`, and the entry-point check that runs it only when Node runs `src/cli.ts` directly.',
    findings: [],
    source: toy`
/** The command line: evaluates one expression and prints the formatted result. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluate } from './evaluate.ts';
import { formatNumber } from './formatNumber.ts';

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Returns the exit code: 0 for a result, 1 for a bad expression, 2 for no expression. */
export function runCli(args: readonly string[], output: CliOutput): number {
  const expression = args.join(' ').trim();
  if (expression === '') {
    output.stderr('Usage: src/cli.ts "<expression>"\n');
    return 2;
  }
  try {
    output.stdout(formatNumber(evaluate(expression)) + '\n');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.name + ': ' + error.message : String(error);
    output.stderr(message + '\n');
    return 1;
  }
}

/** True only when Node was asked to run this file, so npm run build can import it safely. */
function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) {
    return false;
  }
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
`,
    test: toy`
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { runCli } from './cli.ts';

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

test('the command line prints the formatted result', () => {
  assert.deepEqual(run(['10 / 3']), { code: 0, stdout: '3.33333\n', stderr: '' });
});

test('the command line reports a bad expression in one line, without a stack trace', () => {
  assert.deepEqual(run(['2 +']), {
    code: 1,
    stdout: '',
    stderr: 'ParseError: Expected a number in "2 +"\n',
  });
});

test('running the file directly evaluates its argument', () => {
  const script = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', script, '2 + 3 * 4'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '14\n');
});
`,
  },
];

const TECH_PLAN = [
  '## Approach',
  '',
  'Four small modules on top of `src/calc.ts`, which stays as it is. The evaluator applies each',
  'operator through `OPERATIONS`, so division by zero raises the existing `DivideByZeroError`.',
  '',
  '## Modules',
  '',
  '- `src/tokenise.ts`: `tokenise(input)` turns an expression into number, operator and parenthesis',
  '  tokens and skips whitespace. An unknown character throws `TokeniseError`.',
  '- `src/formatNumber.ts`: `formatNumber(value)` keeps six significant digits and drops trailing',
  '  zeros. A value that is not finite throws `RangeError`.',
  '- `src/evaluate.ts`: `evaluate(input)` parses the tokens by recursive descent (`*` and `/` bind',
  '  tighter than `+` and `-`, and parentheses recurse). Malformed input throws `ParseError`.',
  '- `src/cli.ts`: `runCli(args, output)` evaluates one expression and returns the exit code. The',
  '  module calls it only when Node runs the file directly.',
  '',
  'The tokeniser and the formatter share nothing, so both can start at once. The evaluator needs the',
  'tokeniser, and the command line needs the evaluator and the formatter.',
  '',
  '## Answer to the PM',
  '',
  'The command line takes the expression from its arguments. Node runs a `.ts` file only with the',
  'type-stripping flags:',
  '',
  `    ${CLI} "2 + 3 * 4"`,
  '',
].join('\n');

const PM_STEP: DemoStep = {
  say: [
    'Reading the raw requirement and the project description.',
    'Each behaviour comes with an exact example, so the acceptance criteria quote them.',
  ],
  structured: {
    ...BASE,
    notes_markdown:
      'Each behaviour in the requirement comes with an exact example, so the acceptance criteria quote ' +
      'those examples. File names and error class names are left to the Tech Lead.',
    refined_requirement:
      'Turn the single-operation calculator into an expression calculator: an evaluator that honours ' +
      'precedence and parentheses, a formatter that makes results readable, and a command line that ' +
      'ties the two together.',
    scope_in: [
      'Evaluate `+`, `-`, `*` and `/` with the usual precedence, parentheses and any whitespace',
      'A named error for malformed input, and for division by zero',
      'Format a number with at most six significant digits and no trailing zeros',
      'A command line that prints the formatted result, or a one-line error and a non-zero exit code',
    ],
    scope_out: [
      'Unary minus, powers, or functions such as `sqrt`',
      'Variables, or more than one expression per run',
      'An interactive prompt',
      'Locale-specific number formats',
    ],
    acceptance_criteria: [
      '`npm test`, `npm run lint` and `npm run build` all exit 0',
      'Evaluating `2 + 3 * 4` gives `14`, and `(2 + 3) * 4` gives `20`',
      'Evaluating `2 +` raises a named error, and `5 / 0` raises a named error rather than returning `Infinity`',
      'Formatting `10 / 3` gives `3.33333`, and formatting `4` gives `4`',
      'The command line prints `14` for `2 + 3 * 4` and exits 0',
      'The command line prints a one-line message, with no stack trace, for `2 +` and exits with a non-zero code',
    ],
    questions_for_tl: ['Should the command line read the expression from its arguments, from standard input, or both?'],
  },
};

const TL_STEP: DemoStep = {
  say: [
    'Reading the repo conventions and src/calc.ts.',
    'calc.ts already has the arithmetic and DivideByZeroError, so the evaluator reuses them.',
  ],
  read: ['CLAUDE.md', 'src/calc.ts'],
  structured: {
    ...BASE,
    notes_markdown: TECH_PLAN,
    feasibility:
      'Straightforward: four small modules and no new dependencies. `src/calc.ts` already has the ' +
      'arithmetic and `DivideByZeroError`, so nothing there changes.',
    risks: [
      '`scripts/lint.mjs` forbids `console.log` anywhere under `src/`, so the command line writes with ' +
        '`process.stdout.write`.',
      '`scripts/build.mjs` imports every module under `src/`, so `src/cli.ts` must run only when it is the ' +
        'entry point, or the build would run it.',
      'Tests run through type stripping: erasable TypeScript only, and relative imports keep their `.ts` extension.',
    ],
    phases: [
      'The tokeniser, `src/tokenise.ts`',
      'The number formatter, `src/formatNumber.ts`',
      'The evaluator, `src/evaluate.ts`, on top of the tokeniser',
      'The command line, `src/cli.ts`, on top of the evaluator and the formatter',
    ],
    questions_for_pm: [],
    request_refinement: false,
    tech_doc_updates: [],
  },
};

const DL_STEP: DemoStep = {
  say: [
    'Splitting the tech plan into tickets, one module each.',
    'The tokeniser and the formatter share nothing, so both can start at once.',
  ],
  read: ['CLAUDE.md'],
  structured: {
    ...BASE,
    notes_markdown:
      'Four tickets, one module each, so no two tickets touch the same file. The tokeniser and the ' +
      'formatter depend on nothing and can start at once.',
    tickets: TICKETS.map((ticket) => ({
      title: ticket.title,
      description_md: ticket.description,
      acceptance_criteria: ticket.criteria.map((criterion) => criterion.text),
      technical_notes_md: ticket.notes,
      depends_on: [...ticket.dependsOn],
    })),
  },
};

function ticketSteps(ticket: DemoTicket, index: number): [string, DemoStep][] {
  const id = ticketId(DEMO_FEATURE_ID, index + 1);
  const moduleFile = `src/${ticket.module}.ts`;
  const testFile = `src/${ticket.module}.test.ts`;
  const developer: DemoStep = {
    say: [
      `Writing ${moduleFile} and its tests for ${id}.`,
      `Wrote ${moduleFile} and ${testFile}. The orchestrator commits them and runs the gates.`,
    ],
    read: ticket.read,
    write: { [moduleFile]: ticket.source, [testFile]: ticket.test },
    structured: {
      ...BASE,
      notes_markdown: `Wrote \`${moduleFile}\` and \`${testFile}\`, touching nothing else.`,
      summary: ticket.summary,
      files_changed: [moduleFile],
      commit_message: `feat(${ticket.module}): ${ticket.title.toLowerCase()}`,
      tests_added: [testFile],
    },
  };
  const reviewer: DemoStep = {
    say: [
      `Reviewing ${id} against its acceptance criteria.`,
      ticket.findings.length === 0 ? 'Approving: nothing to raise.' : 'Approving, with one point that does not block.',
    ],
    read: [moduleFile, testFile],
    structured: {
      ...BASE,
      notes_markdown:
        ticket.findings.length === 0
          ? 'Read the change against the ticket. Nothing to raise.'
          : 'Read the change against the ticket. One small point, nothing blocking.',
      verdict: 'approve',
      findings: ticket.findings,
    },
  };
  const qa: DemoStep = {
    say: [
      `Checking each acceptance criterion for ${id} on its branch.`,
      `All ${ticket.criteria.length} criteria pass.`,
    ],
    read: [testFile],
    structured: {
      ...BASE,
      notes_markdown: 'Checked each acceptance criterion on this branch, against the commit the gates ran on.',
      verdict: 'pass',
      criteria_results: ticket.criteria.map((criterion) => ({
        criterion: criterion.text,
        result: 'pass',
        evidence_command: criterion.command,
        evidence_output: criterion.output,
      })),
    },
  };
  return [
    [`developer:${id}`, developer],
    [`code_reviewer:${id}`, reviewer],
    [`qa:${id}`, qa],
  ];
}

/** Keyed `<role>:<itemId>`, then `<role>`, as `DemoRunner` looks steps up. */
export const DEMO_SCRIPT: Readonly<Record<string, DemoStep>> = Object.freeze(
  Object.fromEntries([
    ['pm', PM_STEP],
    ['tl_plan', TL_STEP],
    ['dl', DL_STEP],
    ...TICKETS.flatMap((ticket, index) => ticketSteps(ticket, index)),
  ]),
);

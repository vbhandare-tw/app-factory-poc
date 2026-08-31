#!/usr/bin/env node
/**
 * A real lint gate with zero npm dependencies.
 *
 * The factory only cares that `npm run lint` is a real subprocess with a real
 * exit code that a bad change can actually turn red. These rules are the
 * mechanical, deterministic subset of what eslint would give us, implemented
 * over the source text so the fixture needs no `npm install`.
 *
 * Exit 0 = clean. Exit 1 = violations, printed as `file:line:col  rule  message`.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINT_DIRS = ['src', 'scripts'];
const LINT_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

/** @typedef {{ file: string, line: number, column: number, rule: string, message: string }} Violation */

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return found;
    }
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      found.push(...(await collectFiles(full)));
    } else if (LINT_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * @param {string} file
 * @param {string} source
 * @returns {Violation[]}
 */
function lintSource(file, source) {
  /** @type {Violation[]} */
  const violations = [];
  const relative = path.relative(REPO_ROOT, file);
  const lines = source.split('\n');

  const report = (line, column, rule, message) => {
    violations.push({ file: relative, line, column, rule, message });
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    const tabIndex = line.indexOf('\t');
    if (tabIndex !== -1) {
      report(lineNumber, tabIndex + 1, 'no-tabs', 'Tab character; indent with spaces.');
    }

    if (/[ \t]+$/.test(line)) {
      report(lineNumber, line.replace(/[ \t]+$/, '').length + 1, 'no-trailing-whitespace', 'Trailing whitespace.');
    }

    if (line.includes('\r')) {
      report(lineNumber, line.indexOf('\r') + 1, 'no-crlf', 'Carriage return; use LF line endings.');
    }

    const debuggerMatch = /(?:^|[^\w$.])debugger[ \t]*(?:;|$)/.exec(line);
    if (debuggerMatch) {
      report(lineNumber, debuggerMatch.index + 1, 'no-debugger', 'Leftover `debugger` statement.');
    }

    const varMatch = /(^|[^\w$])var\s+[A-Za-z_$]/.exec(line);
    if (varMatch) {
      report(lineNumber, varMatch.index + 1, 'no-var', 'Use `const` or `let`, never `var`.');
    }

    if (/(^|[^\w$.])(console\.log)\s*\(/.test(line) && !relative.startsWith('scripts' + path.sep)) {
      report(lineNumber, line.indexOf('console.log') + 1, 'no-console-log', 'No `console.log` in library code.');
    }
  });

  if (source.length > 0 && !source.endsWith('\n')) {
    report(lines.length, (lines.at(-1) ?? '').length + 1, 'eol-last', 'File must end with a newline.');
  }

  if (/\n{3,}/.test(source)) {
    const upTo = source.slice(0, source.search(/\n{3,}/));
    report(upTo.split('\n').length + 1, 1, 'no-multiple-empty-lines', 'More than one consecutive blank line.');
  }

  return violations;
}

async function main() {
  /** @type {string[]} */
  const files = [];
  for (const dir of LINT_DIRS) {
    files.push(...(await collectFiles(path.join(REPO_ROOT, dir))));
  }

  /** @type {Violation[]} */
  const violations = [];
  for (const file of files) {
    violations.push(...lintSource(file, await readFile(file, 'utf8')));
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}:${v.column}  ${v.rule}  ${v.message}`);
    }
    console.error(`\n${violations.length} problem(s) in ${files.length} file(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(`lint: ${files.length} file(s) clean.`);
}

await main();

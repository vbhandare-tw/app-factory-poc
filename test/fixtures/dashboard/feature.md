---
type: "feature"
id: "FEAT-CALCULATOR"
title: "A command-line expression calculator"
status: "done"
slug: "calculator"
priority: "medium"
attempts: 1
cost_usd: 1.1554462
feature_branch: null
tag: "factory/calculator/2026-09-22"
verified_sha: "cd17de7ecdb96eee6773796088bef3434af38a09"
base_verified_sha: null
approved_sha: null
approved_note: null
approved_tag: null
created_at: "2026-09-22T09:00:01.000Z"
updated_at: "2026-09-22T09:06:16.000Z"
locked_by: null
locked_at: null
pause_reason: null
pause_detail: null
resume_to: null
reject_to: null
paused_at: null
---
## Raw Requirement

```markdown
# A command-line expression calculator

The calculator can only apply one named operation to two numbers. Three things would make it
genuinely usable.

**Evaluating whole expressions.** `evaluate("2 + 3 * 4")` should return `14`. It must honour
normal operator precedence (`*` and `/` bind tighter than `+` and `-`), support parentheses,
ignore whitespace, and raise a clear, named error for malformed input and for division by zero
rather than returning `NaN` or `Infinity`.

**Formatting results for a person to read.** Division produces long decimals — `10 / 3` comes
out as `3.3333333333333335`, which nobody wants to look at. There should be a way to render any
number for display: at most six significant digits, no trailing zeros, and no exponent notation
for ordinary sizes. Formatting `3.3333333333333335` should give `3.33333`, and formatting `4`
should give `4`, not `4.00000`.

**A command line.** A person should be able to type an expression in a terminal and see the
formatted result, without writing any code. A malformed expression should print a clear message
and exit with a non-zero status rather than a stack trace.
```

## Refined Requirement

Extend the existing single-operation calculator into a full expression calculator with three additions:

1. An `evaluate` function that takes a string expression and returns a number. It must support the binary operators `+ - * /`, honour standard precedence (`*` and `/` bind tighter than `+` and `-`), support parentheses for grouping, and ignore any whitespace within the expression. On malformed input (e.g. incomplete expressions, unbalanced parentheses, invalid characters) it must throw a named `Error` subclass (not a bare `Error`) instead of returning `NaN`. On division by zero it must throw a named `Error` subclass instead of returning `Infinity` or `NaN`.

2. A display-formatting function that takes a number and returns a string for human display: at most 6 significant digits, no trailing zeros, and no exponential notation for numbers of ordinary magnitude.

3. A command-line entry point that reads one expression (from an argument or stdin — TL to decide, see questions), prints the formatted result of evaluating it, and exits 0 on success. On a malformed expression it prints a clear, human-readable error message (not a raw stack trace) to stderr and exits with a non-zero status.

**In scope**

- evaluate() supporting +, -, *, / with standard operator precedence
- Parentheses for grouping in expressions
- Whitespace-insensitive parsing
- Named Error subclass thrown for malformed/unparseable expressions
- Named Error subclass thrown for division by zero (no Infinity/NaN escaping to the caller)
- A number-formatting function: max 6 significant digits, no trailing zeros, no exponential notation for ordinary-sized numbers
- A CLI entry point that evaluates one expression per invocation and prints the formatted result
- CLI exits 0 on success, non-zero with a clear stderr message (no stack trace) on malformed input

**Out of scope**

- Operators beyond +, -, *, / (no exponentiation, modulo, unary minus/plus unless TL decides otherwise)
- Variables, named functions (sqrt, sin, etc.), or multi-statement input
- An interactive/REPL CLI mode that evaluates multiple expressions in one session
- Locale-specific formatting (thousands separators, decimal comma, currency)
- Defining behavior for extremely large/small numbers where exponential notation might be unavoidable — only 'ordinary sizes' is in scope, threshold left to TL
- Changing the API or removing the existing single-operation calculator function unless the TL determines it must be replaced
- Persisted history, config files, or CLI flags/options beyond the expression itself

**Questions for the Tech Lead**

- How should the CLI be invoked (a new npm script, e.g. `npm run calc -- "<expr>"`, or a documented `node <file>.ts "<expr>"` form), and where will that be documented so QA can find it (README or package.json)?
- Should the CLI accept the expression as a command-line argument, via stdin, or both?
- What named Error class(es) should be used — one shared class for both malformed input and division-by-zero, or two distinct classes (e.g. ParseError, DivisionByZeroError)?
- What is the exact threshold for 'ordinary sizes' before the formatter is allowed to fall back to exponential notation?
- Should the existing single-operation calculator function be kept for backward compatibility, or can it be replaced/removed in favor of evaluate()?
- Does whitespace handling need to cover tabs/newlines inside the expression, or only spaces?

## Acceptance Criteria

- Running `npm test` exits 0.
- Running `npm run lint` exits 0.
- Running `npm run build` exits 0.
- Per the tests exercised by `npm test`, `evaluate('2 + 3 * 4')` returns `14` (multiplication before addition).
- Per the tests exercised by `npm test`, `evaluate('(2 + 3) * 4')` returns `20` (parentheses override precedence).
- Per the tests exercised by `npm test`, `evaluate('10 - 4 / 2')` returns `8` (division before subtraction).
- Per the tests exercised by `npm test`, `evaluate('  2   +   3 ')` (with embedded whitespace) returns `5`.
- Per the tests exercised by `npm test`, `evaluate('2 +')` throws an Error whose constructor is a named subclass, not the bare `Error` class.
- Per the tests exercised by `npm test`, `evaluate('5 / 0')` throws a named Error subclass rather than returning `Infinity` or `NaN`.
- Per the tests exercised by `npm test`, the display-formatting function formats `3.3333333333333335` as `'3.33333'`.
- Per the tests exercised by `npm test`, the display-formatting function formats `4` as `'4'` (no decimal point, no trailing zeros).
- Per the tests exercised by `npm test`, the display-formatting function formats `2.5` as `'2.5'` (trailing zeros stripped, not `'2.50000'`).
- Per the tests exercised by `npm test`, the display-formatting function formats `100000` as `'100000'` (no exponential notation).
- The CLI, invoked the way this repo documents, prints `14` for input `2 + 3 * 4` and exits with status `0`.
- The CLI, invoked the way this repo documents, prints a non-empty error message with no stack trace to stderr and exits with a non-zero status for input `2 +`.
- The CLI, invoked the way this repo documents, prints a non-empty error message with no stack trace to stderr and exits with a non-zero status for input `5 / 0`.

## Tech Plan

Feasible with the existing repo as-is. The current `src/calc.ts` already exports pure `add`/`subtract`/`multiply`/`divide` functions and a `DivideByZeroError` class that can be reused directly by a new expression evaluator instead of duplicated. No new dependencies are needed (zero-dependency constraint is easy to honour: recursive-descent parsing and number formatting are both doable with stdlib-only JS). The one real trap is that `scripts/build.mjs` imports every non-test module under `src/` to verify it loads — a `src/cli.ts` that runs its main logic at module top level would execute (and potentially hang on stdin) during `npm run build` unless it's guarded behind the standard `import.meta.url === pathToFileURL(process.argv[1]).href` entry-point check. That's addressed below.

**Risks**

- `scripts/build.mjs` `import()`s every non-test module under `src/`, including `src/cli.ts`. If `cli.ts` runs its expression-reading/evaluating logic at module top level (unguarded), `npm run build` will execute the CLI — reading argv/stdin and potentially hanging or throwing — and the build gate breaks. `cli.ts` must guard its `main()` call behind `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.
- `scripts/lint.mjs`'s `no-console-log` rule only exempts files under `scripts/` — it applies to every file under `src/`, including `src/cli.ts`. A `console.log(...)` call for the CLI's success output will fail `npm run lint`; stdout output must go through `process.stdout.write` instead.
- No `README.md` exists in the repo today, so there is nowhere for the CLI invocation to already be documented; one must be created as part of this feature or the 'invoked the way this repo documents' acceptance criteria has nothing to point at.
- Overflow to `Infinity`/`NaN` from operations other than division by zero (e.g. multiplying two very large parsed numbers) is not guarded by this plan — it's explicitly out of scope per the refined requirement, but `evaluate()` can still return a non-finite number in that extreme case.
- `evaluate.ts` reuses `divide()` and `DivideByZeroError` from `calc.ts` for its division path; this couples the new evaluator's division-by-zero behaviour to `calc.ts`'s current implementation. Acceptable and intentional (avoids duplicating the zero-check and error class), but a future change to `calc.ts`'s `divide` signature or error type would need to be coordinated with `evaluate.ts`.

**Phases**

- Expression evaluator: `src/evaluate.ts` (exports `evaluate`, `ParseError`) plus `src/evaluate.test.ts`. Verify with `npm test` and `npm run build`. Independent of the formatter — does not import `src/format.ts`.
- Display formatter: `src/format.ts` (exports `formatNumber`) plus `src/format.test.ts`. Verify with `npm test` and `npm run build`. Independent of the evaluator — does not import `src/evaluate.ts` or `src/calc.ts`.
- CLI entry point: `src/cli.ts` plus `src/cli.test.ts`, the `calc` script added to `package.json`, and a new `README.md` documenting invocation. `src/cli.ts` imports `evaluate` from `./evaluate.ts` and `formatNumber` from `./format.ts`, so this phase needs both of the above in place. Verify with `npm test`, `npm run lint`, `npm run build`, and a manual run of `npm run calc -- "2 + 3 * 4"` (expect `14`, exit 0) and `npm run calc -- "2 +"` (expect a message on stderr, non-zero exit).
- Documentation touch-up: update `CLAUDE.md`'s Layout section to list the three new source files and their tests, and mention the `calc` npm script. Can be done alongside phase 3 since it documents the same files.

## Gate Results

**Feature-branch gates** — `feature/calculator` at `cd17de7ecdb96eee6773796088bef3434af38a09`, run before final acceptance. Every ticket passed its own gates and passed them again on the branch it merged into; this is the run that judges the branch as a whole, and it is what a human approves the base-branch merge against.

**Attempt 2** — All gates passed.
_Run against commit `cd17de7ecdb96eee6773796088bef3434af38a09`, so what was verified is what will be merged._

- **tests** — pass, exit 0, 646ms — `npm test`
  full output: `<ROOT>/.factory-test-repos/orch-vault-yaQxXb/logs/calculator/FEAT-CALCULATOR-close-cd17de7e-2-gate-tests.log`

- **lint** — pass, exit 0, 257ms — `npm run lint`
  full output: `<ROOT>/.factory-test-repos/orch-vault-yaQxXb/logs/calculator/FEAT-CALCULATOR-close-cd17de7e-2-gate-lint.log`

- **build** — pass, exit 0, 348ms — `npm run build`
  full output: `<ROOT>/.factory-test-repos/orch-vault-yaQxXb/logs/calculator/FEAT-CALCULATOR-close-cd17de7e-2-gate-build.log`

## Notes

```
## Interpretation

The raw requirement describes three additions to an existing single-operation calculator: (1) a full expression `evaluate()`, (2) a display-formatting function, (3) a CLI. I treated these as three cohesive but separately-testable pieces of one feature.

## Key decisions and assumptions

- I did not name any file paths, module names, or exact class names — those are implementation details for the Tech Lead. Acceptance criteria describe behavior ("a named Error subclass"), not a specific class name, since the requirement only asks for "a clear, named error," not a specific one.
- Per the project's testing convention (`node:test` files beside source, `npm test` as the gate), I anchored the function-level acceptance criteria to `npm test` rather than inventing an ad-hoc `node -e` invocation with a guessed import path — the repo doesn't yet expose one, and guessing would risk the same failure mode called out in the acceptance-criteria guidance (a command form the runtime rejects, failing correct code).
- For the CLI, no invocation is documented yet in this repo (no relevant npm script exists today). I used the same "invoked the way this repo documents" phrasing rather than inventing a command line, and raised a question asking the TL to define and document that invocation as part of the ticket, since the feature is unusable by a person without it.
- "Ordinary sizes" for number formatting is left deliberately vague in the raw requirement. I picked `100000` as a concrete, uncontroversial "ordinary" example for the acceptance criteria, and raised the exact threshold as an open question rather than guessing where exponential notation should kick in.
- Scoped out any operators, functions, or CLI modes (REPL, flags, config) not explicitly mentioned in the raw requirement, since "add expression evaluation" doesn't imply "add a general-purpose calculator language."
- Did not decide whether the existing single-operation function must be kept, replaced, or removed — that's a design call for the TL, raised as a question rather than assumed.
```

**Approved by a human**

the refined requirement matches what I asked for

Split along the tech plan's three independently-loadable modules. `src/evaluate.ts` and `src/format.ts` share no files and neither imports the other, so both run in parallel with no dependency. The CLI ticket imports both (`evaluate`/`ParseError` from `evaluate.ts`, `formatNumber` from `format.ts`), so it depends on both — that's a real compile dependency, not a preference. The `CLAUDE.md` documentation touch-up is plain text describing file paths that are already fixed by the tech plan; it shares no file with any other ticket and doesn't need those files to exist to be written, so it's independent and can run in parallel with everything else rather than being tacked onto the CLI ticket.

**Approved by a human**

the breakdown is right — start development

**Final acceptance — FEAT-CALCULATOR**

Approving merges `feature/calculator` into `main` with `--no-ff` and tags the result `factory/calculator/2026-09-22`. Rejecting sends the feature back to development with your reason.

Verified at `cd17de7ecdb96eee6773796088bef3434af38a09` on `feature/calculator`. Gate results are in the section above.

4 ticket(s):

- `FEAT-CALCULATOR-T001` — Add expression evaluator to src/evaluate.ts — done — merged as `1124631c`
- `FEAT-CALCULATOR-T002` — Add number display formatter to src/format.ts — done — merged as `81d258a6`
- `FEAT-CALCULATOR-T003` — Add CLI entry point src/cli.ts, wire up npm run calc, and document it in README.md — done — merged as `55561f13`
- `FEAT-CALCULATOR-T004` — Document new calculator modules in CLAUDE.md — done — merged as `cd17de7e`

**Approved by a human** — final acceptance.

`feature/calculator` merged into `main` at `b2d4c74f048072cb92ca6ae1221b02f914e6508b`, tagged `factory/calculator/2026-09-22`.

accepted — merge and tag it

## History

- 2026-09-22T09:00:13.000Z | intake → refining | orchestrator
- 2026-09-22T09:00:21.000Z | refining → needs_human | orchestrator | checkpoint after_pm_refinement
- 2026-09-22T09:00:26.000Z | needs_human → planning | human | approve: the refined requirement matches what I asked for
- 2026-09-22T09:00:43.000Z | planning → ticketing | orchestrator
- 2026-09-22T09:01:16.000Z | ticketing → needs_human | orchestrator | checkpoint after_ticket_breakdown
- 2026-09-22T09:01:24.000Z | needs_human → in_development | human | approve: the breakdown is right — start development
- 2026-09-22T09:06:01.000Z | in_development → awaiting_feature_close | orchestrator
- 2026-09-22T09:06:12.000Z | awaiting_feature_close → needs_human | orchestrator | checkpoint final_acceptance
- 2026-09-22T09:06:16.000Z | needs_human → done | human | final acceptance approved: merged b2d4c74f into main, tagged factory/calculator/2026-09-22 — accepted — merge and tag it

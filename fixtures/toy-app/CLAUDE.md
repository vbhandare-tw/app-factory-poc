# toy-app — repo conventions

A tiny calculator library. It is the target repo the App Factory builds against.

## Hard constraints

- **Zero npm dependencies, ever.** There is no `node_modules` and no network. Everything must run on what Node 22 ships. If a change needs a package, it is the wrong change.
- **ESM only** (`"type": "module"`). No `require`, no CommonJS.
- **TypeScript, erasable syntax only.** Node runs `.ts` through type stripping, not a compiler. That means: no `enum`, no `namespace`, no constructor parameter properties, no decorators, no `declare` merging. Interfaces, type aliases, generics and annotations are all fine.
- **Relative imports carry the real extension**: `import { add } from './calc.ts'`, not `'./calc'` and not `'./calc.js'`.

## Layout

```
src/calc.ts        the library
src/calc.test.ts   its tests (node:test + node:assert/strict)
scripts/lint.mjs   the lint gate
scripts/build.mjs  the build gate
```

## Gates

All three must exit 0. The factory runs them as subprocesses and only the exit code counts.

| Gate | Command | What it checks |
|---|---|---|
| tests | `npm test` | `node --test` over `src/**/*.test.ts` |
| lint | `npm run lint` | tabs, trailing whitespace, CRLF, `debugger`, `var`, `console.log` in library code, missing final newline, doubled blank lines |
| build | `npm run build` | every non-test module under `src/` loads under type stripping; emits `dist/build-manifest.json` |

`npm run build` validates syntax and module resolution, **not types** — there is no type checker here.

## Style

- One pure function per operation in `src/calc.ts`, registered in `OPERATIONS` so `applyOperation` picks it up automatically.
- Errors are named classes extending `Error`, never bare strings.
- Every new operation gets a test in `src/calc.test.ts`, including its failure mode.
- Two-space indent, single quotes, semicolons, trailing newline.

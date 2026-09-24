import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The pure-domain boundary (plan Phase 2 done condition).
 *
 * `src/domain/**` must stay a pure, in-memory layer: no filesystem, no process
 * spawning, and no imports from any other `src/` layer. It is enforced here
 * rather than by convention because a convention cannot fail a build.
 *
 * NOTE FOR ANY FUTURE EDITOR OF THIS FILE: this rule fails *open*. If the
 * `files` glob stops matching `src/domain/**`, or an import style is used that
 * the patterns below do not cover, the rule silently reports nothing and looks
 * exactly like a clean codebase. Any change here must be re-proved by adding a
 * deliberate violation, running `npm run lint`, and watching it error.
 */
const IO_MESSAGE =
  'src/domain must stay pure — no filesystem or child-process I/O. Move this into src/vault, src/git, src/gates or src/runner and pass the result in as data.';

const LAYER_MESSAGE =
  'src/domain may only import from within src/domain. A cross-layer import breaks the pure-domain boundary that makes the state machine testable without a disk.';

const domainRestrictedImports = [
  'error',
  {
    patterns: [
      {
        group: [
          'fs',
          'fs/*',
          'node:fs',
          'node:fs/*',
          'child_process',
          'child_process/*',
          'node:child_process',
          'node:child_process/*',
          // `createRequire` lives here, which is a one-line way back to fs.
          'module',
          'node:module',
        ],
        message: IO_MESSAGE,
      },
      {
        group: ['../*', '../**', 'src/*', 'src/**', '@/*', '@/**'],
        message: LAYER_MESSAGE,
      },
    ],
  },
];

/**
 * `no-restricted-imports` only sees static `import` declarations. Verified
 * empirically: `const fs = await import('node:fs')` passes it clean, in both
 * the base rule and the typescript-eslint variant. That is exactly the
 * fail-open shape this boundary is supposed to prevent, so the dynamic forms
 * are closed here.
 */
const domainRestrictedSyntax = [
  'error',
  {
    selector:
      "ImportExpression > Literal.source[value=/^(node:)?(fs|child_process|module)(\\/.*)?$/]",
    message: `${IO_MESSAGE} (dynamic import)`,
  },
  {
    selector: "ImportExpression > Literal.source[value=/^(\\.\\.\\/|src\\/|@\\/)/]",
    message: `${LAYER_MESSAGE} (dynamic import)`,
  },
  {
    selector: "CallExpression[callee.name=/^(require|createRequire)$/]",
    message: `${IO_MESSAGE} (require)`,
  },
  {
    selector: "MemberExpression[property.name='createRequire']",
    message: `${IO_MESSAGE} (createRequire)`,
  },
  {
    // A computed specifier cannot be checked statically, so it is banned
    // outright rather than allowed through unexamined.
    selector: 'ImportExpression:not(:has(> Literal))',
    message:
      'src/domain must not use a computed dynamic import — the specifier cannot be checked, so the boundary cannot be enforced.',
  },
];

/**
 * The dashboard never writes a vault note itself (plan Section E item 10,
 * ADR-002): it calls `actions.ts` and `addFeature`, which do. Like the domain
 * boundary this fails open, so a change here must be re-proved with a
 * deliberate violation.
 */
const DASHBOARD_WRITE_MESSAGE =
  'src/dashboard must not write vault notes. Call the existing write path (src/orchestrator/actions.ts, addFeature) instead.';

const DASHBOARD_WRITE_METHODS = '/^(writeNote|appendSection|appendHistory)$/';
const DASHBOARD_WRITE_FUNCTIONS = '/^(writeAnyNote|atomicWrite)$/';

const dashboardRestrictedImports = [
  'error',
  {
    patterns: [
      {
        regex: '(^|/)(vault/atomic|orchestrator/noteWrites|index)(\\.js)?$',
        importNames: ['atomicWrite', 'writeAnyNote'],
        message: DASHBOARD_WRITE_MESSAGE,
      },
    ],
  },
];

const dashboardRestrictedSyntax = [
  'error',
  {
    selector: `MemberExpression[property.name=${DASHBOARD_WRITE_METHODS}]`,
    message: DASHBOARD_WRITE_MESSAGE,
  },
  {
    selector: `MemberExpression[property.value=${DASHBOARD_WRITE_METHODS}]`,
    message: DASHBOARD_WRITE_MESSAGE,
  },
  {
    selector: `ObjectPattern > Property[key.name=${DASHBOARD_WRITE_METHODS}]`,
    message: DASHBOARD_WRITE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name=${DASHBOARD_WRITE_FUNCTIONS}]`,
    message: DASHBOARD_WRITE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=${DASHBOARD_WRITE_FUNCTIONS}]`,
    message: DASHBOARD_WRITE_MESSAGE,
  },
  {
    selector: "ImportExpression > Literal.source[value=/(^|\\/)(vault\\/atomic|orchestrator\\/noteWrites)(\\.js)?$/]",
    message: `${DASHBOARD_WRITE_MESSAGE} (dynamic import)`,
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'fixtures/**',
      '.factory-test-repos/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // The pure-domain boundary. Both rule names are set: the base rule catches
  // value imports, the typescript-eslint variant additionally catches
  // `import type` and `import x = require(...)`. Setting only one leaves a gap.
  // ---------------------------------------------------------------------
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': domainRestrictedImports,
      'no-restricted-syntax': domainRestrictedSyntax,
    },
  },

  {
    files: ['src/dashboard/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': dashboardRestrictedImports,
      'no-restricted-syntax': dashboardRestrictedSyntax,
    },
  },

  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // The dashboard page: plain ES modules run by the browser (plan A3). Only the
  // globals it uses are listed, so anything else stays a no-undef error.
  {
    files: ['dashboard-ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        EventSource: 'readonly',
        URLSearchParams: 'readonly',
        CSS: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Plain-JS test helpers that run as their own node process (the mid-write
  // crash script, the stub `claude`, the isolation probe). They are not
  // TypeScript because they are loaded through Node's type stripping or run
  // directly by a sandboxed agent, so they need the node globals declared here.
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);

// ESLint flat config (audit finding M2 — the repo declared a lint script with
// no linter installed and no config, and CI had no lint gate at all).
//
// Deliberately @eslint/js `recommended` and nothing stricter to start: the
// value is a real, running gate. Tighten per-rule when a defect class shows up,
// the same way logos.test.js rules accreted.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // Generated, vendored, or non-code trees. Keep in sync with .gitignore.
    ignores: ['node_modules/**', 'coverage/**', 'public/**', 'assets/**', 'docs/**'],
  },

  js.configs.recommended,

  {
    // Everywhere: a rest-sibling destructure ({ vendor: _drop, ...rest }) is
    // the idiomatic way to omit a key; underscore-prefixed names are declared
    // intentionally unused.
    rules: {
      'no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Workers runtime: web-platform globals, no Node built-ins.
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: {
      // The engine/worker boundary (CLAUDE.md): the engine must stay
      // runtime-agnostic, and eqeqeq-class slips are the kind of thing a
      // fail-closed codebase cannot afford.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    files: ['scripts/**/*.mjs', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Tests run under vitest on Node; they also exercise Worker code.
      globals: { ...globals.node, ...globals.browser },
    },
  },
];

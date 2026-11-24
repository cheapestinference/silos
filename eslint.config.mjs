// ESLint flat config for the whole monorepo (server, web, plugin-opencode,
// scripts). Syntax-level typescript-eslint rules only — no type-aware linting:
// `tsc --noEmit` (npm run typecheck) already owns type correctness, and a
// type-checked lint would double the CI time for little extra signal.
// Formatting is Prettier's job; eslint-config-prettier switches off every
// stylistic rule that would fight it.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      // gitignored local material (never part of a clone)
      'reference/**',
      '.superpowers/**',
      '**/*.tmp.mjs',
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-e2e/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/.pack/**',
      'internal/**',
      'context/**',
      '.claude/**',
      '.worktrees/**',
      '**/fixtures/**/*.jsonl',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Unused code is a real smell; a leading underscore marks a deliberate
      // placeholder (positional args, destructured-away fields).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // Off: the codebase reads untyped JSON (transcripts, SDK messages,
      // manifests) at its edges and narrows it on purpose; ~100 casts to
      // `any` would become `unknown` + assertions with no behaviour gained.
      '@typescript-eslint/no-explicit-any': 'off',
      // Off: parsing terminal output is core work here (ANSI/OSC escapes,
      // control characters in tmux panes); those regexes are intended.
      'no-control-regex': 'off',
      // Off: generators that never yield are deliberate stand-ins for
      // empty or never-ending SDK streams (the prompt iterable contract).
      'require-yield': 'off',
      // `cond && call()` / `a ? f() : g()` as statements is an accepted idiom
      // in this code; bare expressions that do nothing are still caught.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // Copy uses typographic spaces (narrow no-break before units) and
      // frontmatter regexes match a BOM: allowed inside strings, templates
      // and regexes, still caught in code.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipRegExps: true }],
      // A `let` declared before the closure that reads it and assigned later
      // (timers, objects built after their callbacks) cannot be `const`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}', 'web/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['web/public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  prettier,
)

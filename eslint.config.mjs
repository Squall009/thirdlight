// Thirdlight lint: a small set of correctness rules, not a style guide.
// Package sources are linted with type information (each package's own
// tsconfig through the project service) so promise misuse is caught; tests
// and tools outside the packages have no tsconfig and get the untyped rules.
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// AGENTS.md asks every eslint-disable to carry its reason on the same line;
// ESLint's own syntax for that is `eslint-disable-… rule -- reason`.
const disableNeedsReason = {
  meta: { type: 'suggestion', schema: [], messages: { missing: 'eslint-disable needs its reason on the same line: `-- why`.' } },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          if (/^eslint-(disable|enable)/.test(text) && !/\s--\s*\S/.test(text)) {
            context.report({ loc: comment.loc, messageId: 'missing' });
          }
        }
      },
    };
  },
};

const correctness = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-fallthrough': ['error', { allowEmptyCase: true }],
  'no-unreachable': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': 'error',
  'no-dupe-keys': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
  'thirdlight/disable-needs-reason': 'error',
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    'archive/**',
    'fixtures/**',
    'templates/**',
    'test-results/**',
    'playwright-report/**',
    '.claude/**',
    '**/.tl*-bundles/**',
    '**/.build/**',
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      thirdlight: { rules: { 'disable-needs-reason': disableNeedsReason } },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: correctness,
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['packages/editor/src/**/*.tsx', 'packages/editor/src/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]);

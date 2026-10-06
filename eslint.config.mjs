import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/.next/**', '**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/dashboard/public/pdf-assets/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Accessibility checks for the dashboard. eslint-plugin-jsx-a11y 6.10.2 declares ESLint 9 as its newest peer but runs under
  // ESLint 10 here (no crashes, checked on every dashboard file); revisit this when it publishes an ESLint 10 release.
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['apps/dashboard/**/*.tsx'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // `role={null}` on our own Notice component switches off its default role; it is not a DOM attribute.
      'jsx-a11y/aria-role': ['error', { ignoreNonDOM: true }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' } },
  },
);

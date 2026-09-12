import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'infra/**', '**/*.d.ts'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { project: false },
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', URL: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', TextDecoder: 'readonly', Buffer: 'readonly', URLSearchParams: 'readonly', Response: 'readonly', Headers: 'readonly', structuredClone: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off',
      'no-console': 'off',
    },
  },
];

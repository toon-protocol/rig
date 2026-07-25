import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
  {
    files: ['packages/rig-web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Relaxed rules for test files, examples
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.stories.ts',
      '**/*.stories.tsx',
      '**/test-setup.ts',
      '**/__integration__/**',
      '**/__tests__/**',
      '**/tests/**',
      '**/e2e/**',
      '**/examples/**',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-empty-function': 'off',
      'no-unsafe-finally': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      // The sandcastle runner scripts run via tsx and are not part of any
      // workspace tsconfig, so typed-lint (projectService) can't resolve them.
      // Exclude them here — same pattern as tooling dirs like .claude.
      '.sandcastle/**',
      // Dead pre-extraction e2e harness excluded from packages/rig-web's
      // tsconfig (rig#28) -- no longer part of any project, so typed-lint
      // can't resolve it either.
      'packages/rig-web/tests/e2e/seed/**',
    ],
  }
);

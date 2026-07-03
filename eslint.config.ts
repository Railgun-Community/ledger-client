import tseslint from 'typescript-eslint';

export default tseslint.config(
  tseslint.configs.strictTypeChecked,
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
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      // `noUncheckedIndexedAccess` is on, so the codebase uses `!` idiomatically
      // for array/buffer access already guarded by an explicit length check
      // (APDU parsing). Enforcing this stylistic rule there is pure noise.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Test code exercises mocks/fixtures where full type-aware strictness is
    // noise; keep syntactic linting but drop the type-checked rules (and the
    // typed-project requirement) for tests.
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      '*.config.*',
      // generated at build time from apps/** — not authored source
      'src/core/installer/bundled-artifacts.generated.ts',
    ],
  },
);

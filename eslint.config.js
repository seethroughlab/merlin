// Minimal flat ESLint config. Intent: catch real bugs (unused-vars,
// no-undef, no-fallthrough, accidental shadowing) without over-policing
// style or formatting. The next team can layer on stricter rules once
// they've settled on their preferences.
//
// Run: `npm run lint`. Auto-fix what you can: `npm run lint -- --fix`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'scripts/**',
      'td/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Catch real mistakes:
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      // Project explicitly allows `any` where the boundary requires it
      // (Spout native bindings, legacy event typings). Demoted to warn.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty interfaces are sometimes intentional as type-stub seams.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Test files lean on `any` for mock shapes; relax further there.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];

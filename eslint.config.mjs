// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // tsconfig.json leaves test/ out of the build; this one adds it so tests are linted with types too.
        project: './tsconfig.lint.json',
        tsconfigRootDir: import.meta.dirname
      }
    }
  }
);

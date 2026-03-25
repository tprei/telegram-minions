import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
    },
  },
  {
    rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'test/**'],
  }
)

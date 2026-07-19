import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['dist/', 'release/', 'node_modules/', 'public/', 'gallery/', 'spikes/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // catch{} needs a warn by CONTRIBUTING's silent-fallback rule, but that
      // judgement (warn-once wrappers, annotated benign catches) is human review's
      // job -- the lint gate only guards syntax-level accidents.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
]

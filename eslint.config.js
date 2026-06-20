import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // eslint-plugin-react-hooks v7 promotes the React Compiler advisory rules to
      // errors. This app deliberately defines its forms/pages as inline components
      // that close over parent state (so a remount wipes draft state on purpose —
      // see the formDirtyRef note in App.jsx), reads the date during render, and
      // loads data in effects. Those are intentional design choices, not bugs, and
      // reworking them would be a rewrite. Disable the three compiler-tier rules and
      // keep the genuinely useful hooks rules (rules-of-hooks, exhaustive-deps) on.
      'react-hooks/static-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
])

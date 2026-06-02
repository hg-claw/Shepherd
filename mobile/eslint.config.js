const expoConfig = require('eslint-config-expo/flat')

module.exports = [
  ...expoConfig,
  {
    settings: {
      react: {
        version: '19.2',
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**'],
  },
]

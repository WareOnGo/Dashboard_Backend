module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/integration/'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!src/server.js'
  ],
  coverageDirectory: 'coverage',
  // Floors reflect measured production-code coverage, with stricter checks on
  // the authorization caches changed by this regression work.
  coverageThreshold: {
    global: { statements: 55, branches: 46, functions: 51, lines: 55 },
    './src/utils/access.js': { lines: 100, branches: 90 },
    './src/utils/lookupCache.js': { lines: 100, branches: 95 },
    './src/middleware/scoutMiddleware.js': { lines: 100, branches: 100 },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  setupFiles: ['<rootDir>/tests/isolation.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  detectOpenHandles: true
};

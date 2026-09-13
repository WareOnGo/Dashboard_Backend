module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/isolation.js', '<rootDir>/tests/integration/setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 30000,
  maxWorkers: 1,
  detectOpenHandles: true,
};

// Test setup file
// Add any global test configuration here

// Set test timeout
jest.setTimeout(10000);

// Mock environment variables for tests
process.env.NODE_ENV = 'test';

// Suppress console.log during tests unless needed
if (process.env.VERBOSE_TESTS !== 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
}
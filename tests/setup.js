// Test setup file
// Add any global test configuration here

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
// Node's default HTTP agents can retain idle sockets after Supertest closes its
// temporary servers. Close those clients explicitly instead of forcing Jest out.
afterAll(() => {
  require('http').globalAgent.destroy();
  require('https').globalAgent.destroy();
});

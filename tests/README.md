# Testing

This directory contains the test suite for the Warehouse API.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with coverage (for CI/CD)
npm run test:ci
```

## Test Structure

- `app.test.js` - Basic application tests (health checks, 404 handling)
- `utils/` - Utility function tests
- `middleware/` - Middleware tests
- `routes/` - API endpoint tests

## Test Environment

Tests run in a Node.js environment with mocked database connections and services to avoid requiring a real database during CI/CD. The test suite uses:

- **Jest** - Testing framework
- **Supertest** - HTTP assertion library for API testing
- **Mocked services** - To isolate unit tests from external dependencies

## Coverage

Test coverage reports are generated in the `coverage/` directory and can be viewed by opening `coverage/lcov-report/index.html` in a browser.

## CI/CD Integration

The project includes GitHub Actions workflow (`.github/workflows/ci.yml`) that automatically runs tests on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches
- Multiple Node.js versions (18.x, 20.x)

## Test Files Structure

```
tests/
├── app.test.js              # Basic app functionality
├── middleware/
│   └── errorHandler.test.js # Error handling middleware
├── routes/
│   └── warehouse.test.js    # API endpoint tests
├── utils/
│   └── constants.test.js    # Utility constants
└── setup.js                 # Test configuration
```
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
// Validate before even loading the native client. The regular setup still blocks
// dotenv and external HTTP; only this dedicated local PostgreSQL is permitted.
process.env.TEST_DATABASE_URL = testDatabaseUrl(process.env.TEST_DATABASE_URL);
jest.doMock('@prisma/client', () => {
  const actual = jest.requireActual('@prisma/client');
  return { ...actual, PrismaClient: class extends actual.PrismaClient {
    constructor(options = {}) {
      const url = testDatabaseUrl(options.datasources?.db?.url, { allowSchema: true });
      super({ datasources: { db: { url } } });
    }
  } };
});

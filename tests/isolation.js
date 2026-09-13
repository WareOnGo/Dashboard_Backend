// Runs before application imports. Never read this checkout's live .env.
jest.mock('dotenv', () => ({
  ...jest.requireActual('dotenv'),
  config: jest.fn(() => ({ parsed: {} })),
}));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/warehouse_qa',
  DIRECT_URL: 'postgresql://unused:unused@127.0.0.1:1/warehouse_qa',
  JWT_SECRET: 'warehouse-qa-only-secret-never-used-in-production',
  ALLOWED_DOMAIN: 'wareongo.com',
  ADMIN_EMAILS: '',
  GOOGLE_CLIENT_ID: 'fixture-client',
  GOOGLE_CLIENT_SECRET: 'fixture-secret',
  FRONTEND_URL: 'http://localhost:3000',
  CORS_ORIGIN: 'http://localhost:3000',
  GUPSHUP_ENABLED: 'false',
  OPENAI_API_KEY: '',
  MAPBOX_ACCESS_TOKEN: '',
  R2_ACCOUNT_ID: 'fixture',
  R2_ACCESS_KEY_ID: 'fixture',
  R2_SECRET_ACCESS_KEY: 'fixture',
  R2_BUCKET_NAME: 'warehouse-qa-fixture',
  R2_PUBLIC_URL: 'https://fixture.invalid',
});
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key];
}

// Prisma uses a native engine, so a JavaScript socket guard alone is insufficient.
jest.mock('@prisma/client', () => ({
  ...jest.requireActual('@prisma/client'),
  PrismaClient: class {
    constructor() {
      throw new Error('Database access blocked in unit tests: inject a Prisma double or use test:integration');
    }
  },
}));

const net = require('net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  const host = typeof options === 'object' ? options.host : normalized[1];
  if (options?.path || typeof options === 'string' && !/^\d+$/.test(options)) {
    throw new Error('Unix socket access blocked in tests');
  }
  if (host && typeof host === 'string' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`External network access blocked in tests: ${host}`);
  }
  return originalConnect.apply(this, args);
};
global.fetch = jest.fn(async () => { throw new Error('Unmocked fetch blocked in tests'); });

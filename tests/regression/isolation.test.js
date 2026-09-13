const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const valid = 'postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa';
test('unit tests cannot construct a native Prisma client', () => {
  const { PrismaClient } = require('@prisma/client');
  expect(() => new PrismaClient()).toThrow('Database access blocked');
});
test('dotenv does not load checkout credentials', () => {
  const dotenv = require('dotenv');
  expect(dotenv.config()).toEqual({ parsed: {} });
  expect(process.env.DATABASE_URL).toBe('postgresql://unused:unused@127.0.0.1:1/warehouse_qa');
});
test('external socket connections are rejected before connection', () => {
  const socket = new (require('net').Socket)();
  try { expect(() => socket.connect({ host: 'live-db.invalid', port: 5432 })).toThrow('External network access blocked'); }
  finally { socket.destroy(); }
});
test('unmocked fetch is blocked', async () => {
  await expect(fetch('https://live-service.invalid')).rejects.toThrow('Unmocked fetch blocked');
});
test('the dedicated localhost test DB URL is accepted', () => expect(testDatabaseUrl(valid)).toBe(valid));
test.each([
  undefined, '', 'not a URL', valid.replace('127.0.0.1', 'db.example.com'),
  valid.replace('127.0.0.1', 'localhost'), valid.replace('warehouse_qa', 'production'),
  valid.replace('warehouse_test:warehouse_test', 'postgres:secret'), valid.replace(':55439', ''),
  valid.replace('postgresql:', 'https:'), `${valid}?host=live-db.invalid`,
  `${valid}?schema=public`, `${valid}?sslcert=/live/secret`, `${valid}#fragment`,
])('unsafe integration URL is rejected without exposing credentials: %s', value => {
  expect(() => testDatabaseUrl(value)).toThrow('Integration tests require TEST_DATABASE_URL');
});
test('integration clients can access only a generated test schema', () => {
  expect(testDatabaseUrl(`${valid}?schema=behavior_qa_1234567890abcdef`, { allowSchema: true }))
    .toContain('behavior_qa_1234567890abcdef');
  expect(() => testDatabaseUrl(`${valid}?schema=public`, { allowSchema: true })).toThrow();
  expect(() => testDatabaseUrl(`${valid}?schema=behavior_qa_1234567890abcdef&host=elsewhere`, { allowSchema: true })).toThrow();
});

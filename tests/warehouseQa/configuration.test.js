const { handoffMode } = require('../../src/warehouseQa/configuration');
const base = {
  AI_QA_HANDOFF: 'field-review',
  AI_QA_SOURCE: 'warehouse',
  DATABASE_URL: 'postgresql://app:secret@db.internal:5432/warehouses?schema=public',
  AI_QA_DATABASE_URL: 'postgresql://qa:secret@db.internal/warehouses'
};
test('real assignment requires an explicit mode and the same database/schema', () => {
  expect(handoffMode({})).toBe('staged');
  expect(handoffMode(base)).toBe('field-review');
});
test.each([
  { AI_QA_SOURCE: 'pilot' },
  { AI_QA_HANDOFF: 'live' },
  { AI_QA_DATABASE_URL: 'postgresql://qa:secret@localhost:55473/warehouse_qa' },
  { AI_QA_DATABASE_URL: base.AI_QA_DATABASE_URL + '?schema=other' },
  { AI_QA_DATABASE_URL: base.AI_QA_DATABASE_URL + '?host=elsewhere' }
])('unsafe handoff configuration fails closed: %j', (patch) => {
  expect(() => handoffMode({ ...base, ...patch })).toThrow();
});

// Exercise the production app, routers, auth, controllers, services, and models.
// Replace only the database and object-storage boundaries.
const mockPrisma = {};
for (const name of ['warehouse', 'stagedWarehouse', 'verifiedNumber', 'warehouseVisitNote',
  'microMarket', 'appSetting', 'auditLog', 'labeledWarehouseImage', 'cronRunLog',
  'warehouseProximity', 'pointOfInterest', 'osmPoi', 'scoutVoiceNoteAsset', 'warehouseFieldReview']) {
  mockPrisma[name] = {};
  for (const method of ['findMany', 'findFirst', 'findUnique', 'count', 'create',
    'update', 'updateMany', 'delete', 'upsert', 'aggregate', 'groupBy']) {
    mockPrisma[name][method] = jest.fn();
  }
}
mockPrisma.$queryRaw = jest.fn();
mockPrisma.$transaction = jest.fn();
const mockStorage = { send: jest.fn() };
const mockDatabase = {
  getClient: () => mockPrisma,
  connect: jest.fn(), disconnect: jest.fn(), healthCheck: jest.fn(),
};
jest.mock('../../src/utils/database', () => mockDatabase);
jest.mock('../../src/utils/s3Client', () => ({
  getClient: () => mockStorage,
  getBucketName: () => 'warehouse-qa-fixture',
  getPublicUrlBase: () => 'https://fixture.invalid',
  validateConfig: () => true,
}));

const app = require('../../src/app');
const jwt = require('jsonwebtoken');
const { invalidateCapabilities } = require('../../src/utils/access');
const { clearScoutCache } = require('../../src/middleware/scoutMiddleware');

function reset() {
  for (const [name, model] of Object.entries(mockPrisma)) {
    const methods = typeof model === 'function' ? { [name]: model } : model;
    for (const [method, fn] of Object.entries(methods)) {
      fn.mockReset().mockImplementation(() => { throw new Error(`Unexpected database call: ${name}.${method}`); });
    }
  }
  mockPrisma.$transaction.mockImplementation(async operation => Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma));
  mockPrisma.$queryRaw.mockImplementation(async (sql, ...values) => {
    if (String(sql).includes('pg_try_advisory_xact_lock(1784056941, 1919247476)')) return [{ locked: true }];
    if (String(sql).includes('AS "__editVersion" FROM "StagedWarehouse"')) {
      const row = await mockPrisma.stagedWarehouse.findUnique({ where: { id: values[0] } });
      return row ? [{ ...row, __editVersion: '1' }] : [];
    }
    throw new Error('Unexpected raw query');
  });
  // Capability reads return a bounded identity set; existing model fixtures
  // retain their single-row identity lookups for service-level assertions.
  mockPrisma.verifiedNumber.findMany.mockImplementation(async options => {
    if (options?.take !== 2 || !options?.where?.email) throw new Error('Unexpected roster list');
    if (options.where.email.equals.toLowerCase() === 'boss@wareongo.com') return [active({ id: 8, email: 'boss@wareongo.com' })];
    const row = await mockPrisma.verifiedNumber.findFirst(options);
    return row ? [row] : [];
  });
  mockPrisma.auditLog.create.mockResolvedValue({ id: 'fixture-audit' });
  mockStorage.send.mockReset().mockImplementation(() => { throw new Error('Unexpected storage call'); });
  mockDatabase.healthCheck.mockReset().mockResolvedValue(true);
  mockDatabase.connect.mockClear();
  mockDatabase.disconnect.mockClear();
  invalidateCapabilities();
  clearScoutCache();
  process.env.ADMIN_EMAILS = '';
}

function tokenFor(email = 'user@wareongo.com') {
  return jwt.sign({ id: 'qa-user', email, name: 'QA Fixture', domain: 'wareongo.com' }, process.env.JWT_SECRET, { expiresIn: '1h', audience: 'warehouse-frontend', issuer: 'warehouse-api' });
}
function active(overrides = {}) {
  return { id: 7, name: 'QA Fixture', email: 'user@wareongo.com',
    phone_number: '919800000001', empID: 'QA1234', is_active: true,
    adminAccess: false, dashboardAccess: true, reviewerAccess: false,
    viewOwnWarehouseEntries: true, editOwnWarehouseEntries: true,
    viewAllWarehouseEntries: true, editAllWarehouseEntries: true,
    callDashboardAccess: false, ...overrides };
}
module.exports = { app, prisma: mockPrisma, storage: mockStorage, database: mockDatabase, reset, tokenFor, active };

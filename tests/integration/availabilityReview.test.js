jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { PrismaClient } = require('@prisma/client');
const WarehouseModel = require('../../src/models/warehouseModel');
const WarehouseService = require('../../src/services/warehouseService');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const StagingService = require('../../src/services/stagingService');
const WarehouseValidator = require('../../src/validators/warehouseValidator');
const { migrate } = require('../../scripts/migrateAvailabilityReview');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { createSchema, dropSchema } = require('../helpers/availabilityReviewDatabase');

// A disposable Podman database only. The existing test helper refuses production
// URLs. Public is used here to exercise the exact, public-qualified migration.
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl(process.env.TEST_DATABASE_URL) } } });
const warehouseModel = new WarehouseModel(prisma);
const service = new WarehouseService(warehouseModel);
const stagedModel = new StagedWarehouseModel(prisma);
const staging = new StagingService(stagedModel, service);
const date = value => new Date(value + 'T00:00:00.000Z');
let setupComplete = false;

beforeAll(async () => {
    await createSchema(prisma);
    setupComplete = true;
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id, availability, status_updated_at) VALUES (700, 'Yes', '2025-01-01'::timestamp)`;
    const before = await migrate(prisma);
    expect(before.columns.every(column => !column.exists)).toBe(true);
    const applied = await migrate(prisma, true);
    expect(applied.addedTo).toEqual(['Warehouse', 'StagedWarehouse']);
    expect(await prisma.$queryRaw`SELECT "availabilityLastReviewedOn", status_updated_at FROM "Warehouse" WHERE id = 700`)
        .toEqual([{ availabilityLastReviewedOn: null, status_updated_at: date('2025-01-01') }]);
});

afterAll(async () => {
    try {
        if (setupComplete) await dropSchema(prisma);
    } finally { await prisma.$disconnect(); }
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "WarehouseData", "Warehouse", "StagedWarehouse", audit_logs');
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id, availability, "availabilityLastReviewedOn")
        VALUES (700, 'Yes', '2025-01-10'::date)`;
});

test('migration can run twice, preserving dates already recorded', async () => {
    expect((await migrate(prisma, true)).addedTo).toEqual([]);
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toEqual(date('2025-01-10'));
});

test('same-answer review, status flip, unrelated edit and clear round-trip through the real service', async () => {
    const before = { availability: 'Yes', availabilityLastReviewedOn: '2025-01-10' };
    await service.updateWarehouse(700, { availabilityLastReviewedOn: '2025-01-15', expectedAvailability: before });
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toEqual(date('2025-01-15'));
    await service.updateWarehouse(700, { ratePerSqft: '30' });
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toEqual(date('2025-01-15'));
    await service.updateWarehouse(700, { availability: 'No', availabilityLastReviewedOn: '2025-01-02' });
    expect(await warehouseModel.findById(700)).toMatchObject({ availability: 'No', availabilityLastReviewedOn: date('2025-01-02') });
    await service.updateWarehouse(700, { availabilityLastReviewedOn: null });
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toBeNull();
});

test('concurrent conditional writes allow only one change and cannot overwrite the winner', async () => {
    const before = { availability: 'Yes', availabilityLastReviewedOn: date('2025-01-10') };
    const results = await Promise.allSettled([
        warehouseModel.update(700, { availability: 'No', availabilityLastReviewedOn: date('2025-01-15') }, before),
        warehouseModel.update(700, { availabilityLastReviewedOn: date('2025-01-16') }, before),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
});

test('retrying an already saved pair is harmless; stale date-only edits are rejected', async () => {
    const request = { availability: 'No', availabilityLastReviewedOn: '2025-01-15',
        expectedAvailability: { availability: 'Yes', availabilityLastReviewedOn: '2025-01-10' } };
    await service.updateWarehouse(700, request);
    expect((await service.updateWarehouse(700, request)).changes).toEqual([]);
    await expect(service.updateWarehouse(700, { availabilityLastReviewedOn: '2025-01-20', expectedAvailability: request.expectedAvailability }))
        .rejects.toMatchObject({ statusCode: 409 });
});

test('new status from an older client clears the old review, while invalid dates write nothing', async () => {
    await expect(service.updateWarehouse(700, { availabilityLastReviewedOn: '2025-02-30' })).rejects.toMatchObject({ name: 'ValidationError' });
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toEqual(date('2025-01-10'));
    await service.updateWarehouse(700, { availability: 'No' });
    expect((await warehouseModel.findById(700)).availabilityLastReviewedOn).toBeNull();
});

test('staging edits and approval preserve the selected date, including SQL promotion', async () => {
    const input = WarehouseValidator.validateCreateOrThrow({ warehouseType: 'PEB', address: 'Fixture', city: 'Pune', state: 'Maharashtra',
        contactPerson: 'Fixture', contactNumber: '9999999999', totalSpaceSqft: [10000], compliances: 'Fixture', ratePerSqft: '25',
        uploadedBy: 'fixture', availability: 'Yes', availabilityLastReviewedOn: '2025-01-01', warehouseData: {} });
    const row = await stagedModel.create(staging.toStagedRow(input, { source: 'DASHBOARD', submittedBy: 'fixture@example.test' }));
    await staging.editSubmission(row.id, { availabilityLastReviewedOn: date('2025-01-02'),
        expectedAvailability: { availability: 'Yes', availabilityLastReviewedOn: date('2025-01-01') } });
    const promoted = await staging.approveSubmission(row.id, { email: 'fixture@example.test' });
    expect(promoted.availabilityLastReviewedOn).toEqual(date('2025-01-02'));
    expect((await warehouseModel.findById(promoted.id)).availabilityLastReviewedOn).toEqual(date('2025-01-02'));
    expect((await stagedModel.findByStagedId(row.id)).availabilityLastReviewedOn).toEqual(date('2025-01-02'));
    // A review edit racing with approval must not land only on the staged copy.
    await expect(stagedModel.updateStaged(row.id, { availabilityLastReviewedOn: date('2025-01-03') }, {
        availability: 'Yes', availabilityLastReviewedOn: date('2025-01-02'),
    })).rejects.toMatchObject({ statusCode: 409 });
});

test('approval cannot publish a review snapshot superseded while approval was being prepared', async () => {
    const input = WarehouseValidator.validateCreateOrThrow({ warehouseType: 'PEB', address: 'Fixture', city: 'Pune', state: 'Maharashtra',
        contactPerson: 'Fixture', contactNumber: '9999999999', totalSpaceSqft: [10000], compliances: 'Fixture', ratePerSqft: '25',
        uploadedBy: 'fixture', availability: 'Yes', availabilityLastReviewedOn: '2025-01-01', warehouseData: {} });
    const row = await stagedModel.create(staging.toStagedRow(input, { source: 'DASHBOARD', submittedBy: 'fixture@example.test' }));
    const duringApproval = jest.spyOn(service, 'applyMicroMarketTags').mockImplementationOnce(async () => {
        await staging.editSubmission(row.id, { availability: 'No', availabilityLastReviewedOn: date('2025-01-02') });
    });
    try {
        await expect(staging.approveSubmission(row.id, { email: 'fixture@example.test' })).rejects.toMatchObject({ statusCode: 409 });
        expect(await stagedModel.findByStagedId(row.id)).toMatchObject({ reviewStatus: 'PENDING', warehouseId: null,
            availability: 'No', availabilityLastReviewedOn: date('2025-01-02') });
        expect(await prisma.warehouse.count()).toBe(1); // Only the unrelated pre-existing fixture.
    } finally { duringApproval.mockRestore(); }
});

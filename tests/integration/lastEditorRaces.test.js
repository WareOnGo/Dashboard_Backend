jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { randomBytes, randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { createSchema } = require('../helpers/availabilityReviewDatabase');
const WarehouseModel = require('../../src/models/warehouseModel');
const WarehouseService = require('../../src/services/warehouseService');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const StagingService = require('../../src/services/stagingService');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');
const { formUpdateGuard } = require('../../src/utils/formChanges');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const url = new URL(base); url.searchParams.set('schema', schema);
const root = new PrismaClient({ datasources: { db: { url: base } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const warehouseModel = new WarehouseModel(db);
const warehouseService = new WarehouseService(warehouseModel);
const stagedModel = new StagedWarehouseModel(db);
const staging = new StagingService(stagedModel, warehouseService);
const submission = {
    warehouseType: 'PEB', address: 'Test Road', city: 'Bengaluru', state: 'Karnataka', zone: 'South',
    contactPerson: 'Test Owner', contactNumber: '+919999999999', totalSpaceSqft: [10000],
    compliances: 'CLU', ratePerSqft: '25', uploadedBy: 'creator@example.test',
    warehouseData: { latitude: 12, longitude: 77 },
};
const reviewer = { email: 'reviewer@example.test', capabilities: {
    DASHBOARD: true, WAREHOUSE_VIEW_OWN: true, WAREHOUSE_VIEW_ALL: true,
    WAREHOUSE_EDIT_OWN: true, WAREHOUSE_EDIT_ALL: true,
} };
let created = false;
beforeAll(async () => {
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true;
    await createSchema(db);
    await db.$executeRawUnsafe('ALTER TABLE "Warehouse" ADD COLUMN "availabilityLastReviewedOn" date');
    await db.$executeRawUnsafe('ALTER TABLE "StagedWarehouse" ADD COLUMN "availabilityLastReviewedOn" date');
});
afterAll(async () => {
    await db.$disconnect();
    if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await root.$disconnect();
});
beforeEach(async () => {
    jest.restoreAllMocks();
    await db.$executeRawUnsafe('TRUNCATE "WarehouseData","Warehouse","StagedWarehouse",audit_logs');
});
const stage = () => stagedModel.create({ id: randomUUID(), ...staging.toStagedRow(submission, {
    source: 'DASHBOARD', submittedBy: 'creator@example.test', lastEditedBy: 'creator@example.test',
}) });

test('an unchanged save cannot overwrite a concurrent edit while retaining the other editor', async () => {
    const row = await warehouseModel.create(submission);
    jest.spyOn(warehouseService, 'applyMicroMarketTags').mockImplementationOnce(async () => {
        await warehouseModel.update(row.id, { city: 'Mumbai', lastEditedBy: 'other@example.test' });
    });
    await warehouseService.updateWarehouse(row.id, { city: submission.city }, reviewer);
    expect(await warehouseModel.findById(row.id)).toMatchObject({ city: 'Mumbai', lastEditedBy: 'other@example.test' });
});

describe.each([
    ['status', ['Under construction', 'Ready to move']],
    ['lockInDate', [new Date('2027-01-01T00:00:00Z'), new Date('2027-02-01T00:00:00Z')]],
])('shared Availability database races: %s', (key, answers) => {
    test('rejects a competing write after authorization and the original row were read', async () => {
        const row = await warehouseModel.create(submission);
        jest.spyOn(warehouseService, 'applyMicroMarketTags').mockImplementationOnce(async () => {
            await warehouseModel.update(row.id, { [key]: answers[0], lastEditedBy: 'other@example.test' });
        });
        const editor = { ...reviewer, capabilities: { ...reviewer.capabilities, WAREHOUSE_EDIT_ALL: false } };
        await expect(warehouseService.updateWarehouse(row.id, {
            expectedFormValues: { ...pptFormSnapshot(row), status: null, lockInDate: null }, [key]: answers[1],
        }, editor)).rejects.toMatchObject({ statusCode: 409, code: 'FORM_FIELDS_CHANGED' });
        expect(await warehouseModel.findById(row.id)).toMatchObject({
            [key]: answers[0], lastEditedBy: 'other@example.test', uploadedBy: submission.uploadedBy,
        });
    });

    test('two simultaneous guarded writes have exactly one winner', async () => {
        const row = await warehouseModel.create(submission);
        const results = await Promise.allSettled(answers.map(answer => {
            const patch = { [key]: answer };
            return warehouseModel.update(row.id, patch, undefined, undefined, formUpdateGuard(row, patch));
        }));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
        expect(answers).toContainEqual((await warehouseModel.findById(row.id))[key]);
    });
});

test('approval rejects a submission edited after its content and editor were read', async () => {
    const row = await stage();
    jest.spyOn(warehouseService, 'applyMicroMarketTags').mockImplementationOnce(async () => {
        await staging.editSubmission(row.id, { city: 'Mumbai' }, { email: 'later@example.test' });
    });
    await expect(staging.approveSubmission(row.id, reviewer)).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.warehouse.count()).toBe(0);
    expect(await stagedModel.findByStagedId(row.id)).toMatchObject({ reviewStatus: 'PENDING', city: 'Mumbai', lastEditedBy: 'later@example.test' });
});

test('an edit started while pending cannot change a submission after it is approved', async () => {
    const row = await stage();
    const update = stagedModel.updateStaged.bind(stagedModel);
    jest.spyOn(stagedModel, 'updateStaged').mockImplementationOnce(async (...args) => {
        await staging.approveSubmission(row.id, reviewer);
        return update(...args);
    });
    await expect(staging.editSubmission(row.id, { city: 'Mumbai' }, { email: 'later@example.test' }))
        .rejects.toMatchObject({ statusCode: 409 });
    expect(await stagedModel.findByStagedId(row.id)).toMatchObject({ reviewStatus: 'APPROVED', city: submission.city, lastEditedBy: 'creator@example.test' });
    expect(await db.warehouse.findFirst()).toMatchObject({ city: submission.city, lastEditedBy: 'creator@example.test' });
});

jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createSchema } = require('../helpers/availabilityReviewDatabase');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const WarehouseModel = require('../../src/models/warehouseModel');
const WarehouseService = require('../../src/services/warehouseService');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const StagingService = require('../../src/services/stagingService');
const WarehouseValidator = require('../../src/validators/warehouseValidator');
const { completePptForm, requiredPaths, patchForPath } = require('../fixtures/pptForm');
const { formUpdateGuard } = require('../../src/utils/formChanges');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL), url = new URL(base);
url.searchParams.set('schema', schema);
const root = new PrismaClient({ datasources: { db: { url: base } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const model = new WarehouseModel(db), stagedModel = new StagedWarehouseModel(db);
const service = new WarehouseService(model), staging = new StagingService(stagedModel, service);
service.applyMicroMarketTags = jest.fn();
let created = false;
beforeAll(async () => {
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true;
    await createSchema(db);
    for (const table of ['Warehouse', 'StagedWarehouse']) await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "availabilityLastReviewedOn" date`);
});
afterAll(async () => {
    await db.$disconnect();
    if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await root.$disconnect();
});
afterEach(() => { jest.restoreAllMocks(); });
const input = () => service.applyCreateBusinessRules(WarehouseValidator.validateCreateOrThrow({ ...completePptForm(), zone: 'NORTH' }));
const staged = data => stagedModel.create(staging.toStagedRow(data, { source: 'DASHBOARD', submittedBy: 'fixture@example.test' }));
const editMaster = async (id, edits, original) => service.updateWarehouse(id,
    { expectedFormValues: pptFormSnapshot(original || await model.findById(id)), ...edits });
const editStaged = async (id, edits, original) => staging.editSubmission(id,
    { expectedFormValues: pptFormSnapshot(original || await stagedModel.findByStagedId(id)), ...edits });

test('submission, staged correction, approval and master edits preserve complete answers', async () => {
    const row = await staged(input());
    await editStaged(row.id, { numberOfDocks: '2' });
    const master = await staging.approveSubmission(row.id, { email: 'reviewer@example.test' });
    expect(await model.findById(master.id)).toMatchObject({ numberOfDocks: '2', washroom_count: 'Male: 0; Female: 0',
        plinthHeightFt: '0 feet', WarehouseData: { fireNocAvailable: false, powerKva: 'As per requirement' } });
    await editMaster(master.id, { warehouseData: { powerKva: '125 HP' } });
    expect((await model.findById(master.id)).WarehouseData.powerKva).toBe('125 HP');
    await expect(staging.approveSubmission(row.id, { email: 'reviewer@example.test' })).rejects.toMatchObject({ statusCode: 409 });
});
test.each(requiredPaths)('staged and master writes cannot erase %s', async path => {
    const row = await staged(input());
    await expect(editStaged(row.id, patchForPath(path, null))).rejects.toMatchObject({ statusCode: 400 });
    const master = await staging.approveSubmission(row.id, { email: 'reviewer@example.test' });
    const before = await model.findById(master.id);
    await expect(editMaster(master.id, patchForPath(path, null))).rejects.toMatchObject({ name: 'ValidationError' });
    expect(await model.findById(master.id)).toEqual(before);
});
test('old pending submissions and master blanks survive unrelated edits, then become protected after filling', async () => {
    const data = input(); data.clearHeightFt = null; data.warehouseData.fireNocAvailable = null;
    data.handoverDate = null;
    const row = await staged(data);
    await editStaged(row.id, { scoutNotes: 'Confirmed owner', clearHeightFt: null, handoverDate: null });
    const master = await staging.approveSubmission(row.id, { email: 'reviewer@example.test' });
    await editMaster(master.id, { scoutNotes: 'Visit arranged', warehouseData: { fireNocAvailable: null } });
    await editMaster(master.id, { clearHeightFt: '10 metres', warehouseData: { fireNocAvailable: false } });
    await expect(editMaster(master.id, { clearHeightFt: null })).rejects.toMatchObject({ statusCode: 400 });
    await expect(editMaster(master.id, { warehouseData: { fireNocAvailable: null } })).rejects.toMatchObject({ statusCode: 400 });
});
test.each([false, true].flatMap(pending => ['clearHeightFt', 'warehouseData.powerKva'].map(path => ({ pending, path }))))(
    'a value filled after the service read cannot be overwritten (staged=$pending, field=$path)', async ({ pending, path }) => {
    const nested = path.startsWith('warehouseData.');
    const key = path.split('.').at(-1), answer = nested ? '100 HP' : '40 feet';
    const data = input(); (nested ? data.warehouseData : data)[key] = null;
    const row = pending ? await staged(data) : await model.create(data);
    const read = pending ? stagedModel.findByStagedId.bind(stagedModel) : model.findById.bind(model);
    jest.spyOn(pending ? stagedModel : model, pending ? 'findByStagedId' : 'findById').mockImplementationOnce(async (...args) => {
        const old = await read(...args);
        await (pending ? db.stagedWarehouse : nested ? db.warehouseData : db.warehouse).update({
            where: pending || !nested ? { id: row.id } : { warehouseId: row.id }, data: { [key]: answer },
        });
        return old;
    });
    const update = { expectedFormValues: pptFormSnapshot(row), scoutNotes: 'Stale full form', ...patchForPath(path, nested ? '200 HP' : '50 feet') };
    await expect(pending ? staging.editSubmission(row.id, update) : service.updateWarehouse(row.id, update))
        .rejects.toMatchObject({ statusCode: 409, code: 'FORM_FIELDS_CHANGED' });
    const saved = await read(row.id);
    expect((nested && !pending ? saved.WarehouseData : saved)[key]).toBe(answer);
});

test.each([false, true])('stale unchanged answers are preserved, intentional conflicts rejected, retries idempotent (staged=%s)', async pending => {
    const row = pending ? await staged(input()) : await model.create(input());
    const edit = pending ? editStaged : editMaster;
    const read = pending ? stagedModel.findByStagedId.bind(stagedModel) : model.findById.bind(model);
    const power = row => pending ? row.powerKva : row.WarehouseData.powerKva;
    await edit(row.id, { warehouseData: { powerKva: '200 kVA' } }, row);
    await edit(row.id, { address: 'Address edited in stale browser', warehouseData: { powerKva: power(row) } }, row);
    expect(power(await read(row.id))).toBe('200 kVA');
    await expect(edit(row.id, { warehouseData: { powerKva: '300 kVA' } }, row))
        .rejects.toMatchObject({ statusCode: 409, code: 'FORM_FIELDS_CHANGED' });
    const current = await read(row.id);
    const payload = { warehouseData: { powerKva: '300 kVA' } };
    await edit(row.id, payload, current);
    const afterFirstSave = await read(row.id);
    await edit(row.id, payload, current);
    expect(await read(row.id)).toEqual(afterFirstSave);
});
test.each([false, true])('saved washroom components and inactive handover values cannot be cleared (staged=%s)', async pending => {
    const data = { ...input(), washroom_count: 'Male: 3; Female: 2', handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' };
    const row = pending ? await staged(data) : await model.create(data);
    const edit = pending ? editStaged : editMaster;
    for (const patch of [{ washroom_count: 'Female: 2' }, { washroom_count: 'Male: 3' }, { handoverDate: null }]) {
        await expect(edit(row.id, patch, row)).rejects.toMatchObject({ statusCode: 400 });
    }
    await edit(row.id, { washroom_count: 'Male: 0; Female: 2' }, row);
});
test.each([false, true])('unconfirmed floor loads preserve newer answers and reject stale replacements (staged=%s)', async pending => {
    const data = { ...input(), floorStrengthPerSqm: 'To be confirmed' };
    const row = pending ? await staged(data) : await model.create(data);
    const edit = pending ? editStaged : editMaster;
    const read = pending ? stagedModel.findByStagedId.bind(stagedModel) : model.findById.bind(model);
    await edit(row.id, { floorStrengthPerSqm: '6 tonnes/sq m' }, row);
    await edit(row.id, { address: 'Address edited in stale browser', floorStrengthPerSqm: 'To be confirmed' }, row);
    expect((await read(row.id)).floorStrengthPerSqm).toBe('6 tonnes/sq m');
    await expect(edit(row.id, { floorStrengthPerSqm: '7 tonnes/sq m' }, row))
        .rejects.toMatchObject({ statusCode: 409, code: 'FORM_FIELDS_CHANGED' });
    const current = await read(row.id);
    await expect(edit(row.id, { floorStrengthPerSqm: null }, current)).rejects.toMatchObject({ statusCode: 400 });
    await edit(row.id, { floorStrengthPerSqm: 'To be confirmed' }, current);
    const saved = await read(row.id);
    expect(saved.floorStrengthPerSqm).toBe('To be confirmed');
    await edit(row.id, { floorStrengthPerSqm: 'To be confirmed' }, current);
    expect(await read(row.id)).toEqual(saved);
});
test('an old warehouse without WarehouseData can save unrelated edits and fill its missing answers', async () => {
    const row = await model.create(input());
    await db.warehouseData.deleteMany({ where: { warehouseId: row.id } });
    const old = await model.findById(row.id);
    await editMaster(row.id, { address: 'Legacy locality updated', warehouseData: { powerKva: null, fireNocAvailable: null } }, old);
    expect((await model.findById(row.id)).WarehouseData).toBeNull();
    await editMaster(row.id, { warehouseData: { powerKva: '100 kVA', fireNocAvailable: false } });
    expect((await model.findById(row.id)).WarehouseData).toMatchObject({ powerKva: '100 kVA', fireNocAvailable: false });
    await expect(editMaster(row.id, { warehouseData: { powerKva: null } })).rejects.toMatchObject({ statusCode: 400 });
});
test('two simultaneous fills of a missing details row have one winner', async () => {
    const row = await model.create(input());
    await db.warehouseData.deleteMany({ where: { warehouseId: row.id } });
    const old = await model.findById(row.id);
    const updates = ['100 kVA', '200 kVA'].map(powerKva => ({ warehouseData: { powerKva } }));
    const results = await Promise.allSettled(updates.map(update => model.update(row.id, update, undefined, undefined, formUpdateGuard(old, update))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    expect(await db.warehouseData.count({ where: { warehouseId: row.id } })).toBe(1);
});
test.each([false, true])('missing browser baselines cannot bypass enforcement (staged=%s)', async pending => {
    const row = pending ? await staged(input()) : await model.create(input());
    const payload = { warehouseData: { powerKva: '200 kVA' } };
    await expect(pending ? staging.editSubmission(row.id, payload) : service.updateWarehouse(row.id, payload))
        .rejects.toMatchObject({ statusCode: 409, code: 'FORM_FIELDS_CHANGED' });
});
test.each([false, true])('concurrent guarded writes allow only one winner (nestedOnly=%s)', async nestedOnly => {
    const row = await model.create(input());
    const before = await model.findById(row.id);
    const edits = [
        { ...(!nestedOnly && { numberOfDocks: '2' }), warehouseData: { powerKva: '100 HP' } },
        { ...(!nestedOnly && { numberOfDocks: '3' }), warehouseData: { powerKva: '200 HP' } },
    ];
    const results = await Promise.allSettled(edits.map(edit => model.update(row.id, edit, undefined, undefined, formUpdateGuard(before, edit))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    const winner = results.findIndex(r => r.status === 'fulfilled');
    expect(await model.findById(row.id)).toMatchObject({ ...(!nestedOnly && { numberOfDocks: edits[winner].numberOfDocks }), WarehouseData: edits[winner].warehouseData });
});

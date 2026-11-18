const WarehouseService = require('../../src/services/warehouseService');
const StagingService = require('../../src/services/stagingService');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');

const submission = {
    warehouseType: 'Industrial', address: '1 Test Rd', city: 'Bengaluru', state: 'Karnataka',
    zone: 'South', contactPerson: 'Tester', contactNumber: '9999999999',
    totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25', uploadedBy: 'original@example.test',
    warehouseData: { latitude: 12.9, longitude: 77.5, powerKva: '500' },
};

function warehouseFixture() {
    let saved = { id: 123, ...submission, lastEditedBy: 'previous@example.test', WarehouseData: submission.warehouseData };
    const model = {
        findById: jest.fn(async () => saved),
        update: jest.fn(async (_id, data) => {
            saved = { ...saved, ...data };
            return saved;
        }),
    };
    return { service: new WarehouseService(model), model };
}

test.each([
    [{ email: ' editor@example.test ', id: 'user-123' }, 'editor@example.test'],
    [{ id: 'user-123' }, 'user-123'],
    [{ email: null, id: 42 }, '42'],
    [{ email: '', id: 'user-123' }, 'user-123'],
    [{ email: '   ', id: 0 }, '0'],
])('warehouse edits prefer email with user ID fallback: %j', async (user, expected) => {
    const { service, model } = warehouseFixture();
    const { warehouse, changes } = await service.updateWarehouse(123, {
        expectedFormValues: pptFormSnapshot(submission),
        warehouseData: { powerKva: '750' },
        lastEditedBy: 'spoofed@example.test', updatedByEmail: 'spoofed@example.test', updatedBy: 'spoofed-id',
    }, user);
    expect(warehouse.lastEditedBy).toBe(expected);
    expect(warehouse.uploadedBy).toBe(submission.uploadedBy);
    expect(model.update).toHaveBeenCalledWith(123, expect.objectContaining({ lastEditedBy: expected }), undefined,
        { actorEmail: expected }, { WarehouseData: { is: { powerKva: '500' } } });
    expect(changes.map(change => change.field)).toEqual(['warehouseData.powerKva']);
});

test('an unchanged save or an internal write without a user preserves the last editor', async () => {
    const { service, model } = warehouseFixture();
    expect((await service.updateWarehouse(123, { city: submission.city }, { email: 'other@example.test' })).warehouse.lastEditedBy)
        .toBe('previous@example.test');
    expect(model.update).not.toHaveBeenCalled();
    expect((await service.updateWarehouse(123, { city: 'Pune', lastEditedBy: 'spoofed@example.test' })).warehouse.lastEditedBy)
        .toBe('previous@example.test');
});

test('invalid edits do not persist attribution', async () => {
    const { service, model } = warehouseFixture();
    await expect(service.updateWarehouse(123, { city: {} }, { email: 'editor@example.test' }))
        .rejects.toMatchObject({ name: 'ValidationError' });
    expect(model.update).not.toHaveBeenCalled();
});

function stagingFixture() {
    const warehouseService = new WarehouseService({});
    const model = {
        create: jest.fn(async data => ({ ...data, id: 'staged-123' })),
        findByStagedId: jest.fn(),
        updateStaged: jest.fn(async (_id, data) => ({ ...data, id: 'staged-123' })),
        promote: jest.fn(async (_id, data) => ({ ...data, id: 123 })),
    };
    return {
        service: new StagingService(model, warehouseService, { getAutoApprove: async () => false }), model,
    };
}

test.each([
    ['createDashboardSubmission', 'user', { email: 'creator@example.test', id: 'user-1' }, 'creator@example.test'],
    ['createScoutSubmission', 'scout', { email: null, id: 7, name: 'Scout Seven' }, '7'],
])('authenticated submissions set editor metadata: %s', async (method, actorKey, actor, expected) => {
    const { service, model } = stagingFixture();
    await service[method]({ submission: { ...submission, lastEditedBy: 'spoofed@example.test' }, [actorKey]: actor });
    expect(model.create.mock.calls[0][0].lastEditedBy).toBe(expected);
});

test.each([
    [{ email: 'reviewer@example.test', id: 4 }, 'reviewer@example.test'],
    [{ email: ' ', id: 4 }, '4'],
])('staged edits use the authenticated reviewer: %j', async (user, expected) => {
    const { service, model } = stagingFixture();
    model.findByStagedId.mockResolvedValue({ id: 'staged-123', reviewStatus: 'PENDING', city: 'Pune' });
    const result = await service.editSubmission('staged-123', {
        city: 'Mumbai', lastEditedBy: 'spoofed@example.test',
        warehouseData: { lastEditedBy: 'also-spoofed@example.test' },
    }, user);
    expect(result.submission.lastEditedBy).toBe(expected);
    expect(result.changes.map(change => change.field)).toEqual(['city']);
});

test('an unchanged staged edit cannot overwrite attribution', async () => {
    const { service, model } = stagingFixture();
    model.findByStagedId.mockResolvedValue({ id: 'staged-123', reviewStatus: 'PENDING', city: 'Pune', lastEditedBy: 'previous@example.test' });
    const result = await service.editSubmission('staged-123', { city: 'Pune', lastEditedBy: 'spoofed@example.test' }, { email: 'reviewer@example.test' });
    expect(result.submission.lastEditedBy).toBe('previous@example.test');
    expect(model.updateStaged).not.toHaveBeenCalled();
});

test.each(['reviewer@example.test', '7', null])('promotion preserves the recorded editor: %s', async lastEditedBy => {
    const { service, model } = stagingFixture();
    const row = service.toStagedRow(submission, { source: 'SCOUT', submittedBy: 'creator@example.test', lastEditedBy });
    model.findByStagedId.mockResolvedValue({ ...row, id: 'staged-123', __editVersion: '1' });
    const published = await service.approveSubmission('staged-123', { email: 'system:auto-approve' });
    expect(published.lastEditedBy).toBe(lastEditedBy);
    expect(published.uploadedBy).toBe('creator@example.test');
});

test('external submissions cannot claim an editor through their payload', () => {
    const { service } = stagingFixture();
    const row = service.toStagedRow({ ...submission, lastEditedBy: 'spoofed@example.test' }, {
        source: 'PARTNER_API', submittedBy: 'webhook:partner_api',
    });
    expect(row.lastEditedBy).toBeNull();
});

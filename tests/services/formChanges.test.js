const WarehouseService = require('../../src/services/warehouseService');
const StagingService = require('../../src/services/stagingService');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');
const original = { id: 123, googleLocation: 'legacy map description', uploadedBy: 'original@example.test',
    WarehouseData: { landType: 'Legacy CLU', latitude: 12, longitude: 77 } };

function setup(staged, overrides = {}) {
    const saved = { ...original, ...overrides };
    const write = jest.fn().mockImplementation(async (_id, updates) => ({ ...saved, ...updates }));
    if (staged) {
        const row = { ...saved, ...saved.WarehouseData, reviewStatus: 'PENDING' };
        const service = new StagingService({ findByStagedId: jest.fn().mockResolvedValue(row), updateStaged: write }, {});
        return { write, update: edits => service.editSubmission('staged-id', { expectedFormValues: pptFormSnapshot(row), ...edits }) };
    }
    const service = new WarehouseService({ findById: jest.fn().mockResolvedValue(saved), update: write });
    service.applyMicroMarketTags = jest.fn();
    return { write, update: edits => service.updateWarehouse(123, { expectedFormValues: pptFormSnapshot(saved), ...edits }) };
}

describe.each([false, true])('changed-field validation (staged=%s)', staged => {
    test('saved land and location cannot be cleared without rollout configuration', async () => {
        const { update, write } = setup(staged);
        await expect(update({ googleLocation: '', warehouseData: { landType: '' } })).rejects.toHaveProperty('issues');
        expect(write).not.toHaveBeenCalled();
    });
    test('unrelated edits preserve legacy URLs, land types and uploader', async () => {
        const { update, write } = setup(staged);
        await update({ address: 'New locality', googleLocation: original.googleLocation,
            uploadedBy: 'reviewer@example.test', warehouseData: { landType: 'Legacy CLU' } });
        expect(write).toHaveBeenCalled();
        expect(write.mock.calls[0][1]).not.toHaveProperty('uploadedBy');
    });
    test('unchanged missing fields remain saveable without historical flags', async () => {
        const { update, write } = setup(staged, { googleLocation: null, WarehouseData: { landType: null } });
        await update({ address: 'New locality', googleLocation: null, warehouseData: { landType: null } });
        expect(write).toHaveBeenCalled();
    });
    test.each([
        { googleLocation: '' },
        { warehouseData: { landType: '' } },
    ])('changed invalid fields block the write: %j', async edits => {
        const { update, write } = setup(staged);
        await expect(update(edits)).rejects.toHaveProperty('issues');
        expect(write).not.toHaveBeenCalled();
    });
    test('changed short links save without contacting Maps or replacing supplied coordinates', async () => {
        const { update, write } = setup(staged);
        const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Maps unavailable'));
        try {
            await update({ googleLocation: 'https://maps.app.goo.gl/ttMpsPTNwLcrdHas5', warehouseData: { latitude: 0, longitude: 77 } });
            const data = write.mock.calls[0][1];
            expect(data.googleLocation).toBe('https://maps.app.goo.gl/ttMpsPTNwLcrdHas5');
            expect(staged ? data : data.warehouseData).toMatchObject({ latitude: 0, longitude: 77 });
            expect(fetch).not.toHaveBeenCalled();
        } finally { fetch.mockRestore(); }
    });
});

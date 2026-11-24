const WarehouseService = require('../../src/services/warehouseService');
const StagingService = require('../../src/services/stagingService');
const { completePptForm, requiredPaths, patchForPath } = require('../fixtures/pptForm');
const { flatFormValues, pptFormSnapshot } = require('../../src/utils/pptFormPolicy');
const { formUpdateGuard } = require('../../src/utils/formChanges');

function setup(staged, row = completePptForm()) {
    const saved = staged ? { ...flatFormValues(row), reviewStatus: 'PENDING' } : { ...row, id: 123, WarehouseData: row.warehouseData };
    const write = jest.fn(async (_id, update) => ({ ...saved, ...update }));
    const service = staged ? new StagingService({ findByStagedId: jest.fn().mockResolvedValue(saved), updateStaged: write }, {})
        : new WarehouseService({ findById: jest.fn().mockResolvedValue(saved), update: write });
    service.applyMicroMarketTags = jest.fn();
    return { write, update: edits => {
        const payload = { expectedFormValues: pptFormSnapshot(saved), ...edits };
        return staged ? service.editSubmission('staged-id', payload) : service.updateWarehouse(123, payload);
    } };
}
describe.each([false, true])('PPT save validation staged=%s', staged => {
    test('persists an unconfirmed floor load and accepts a later measured answer', async () => {
        const first = setup(staged);
        await first.update({ floorStrengthPerSqm: 'To be confirmed' });
        expect(first.write.mock.calls[0][1]).toMatchObject({ floorStrengthPerSqm: 'To be confirmed' });
        const second = setup(staged, { ...completePptForm(), floorStrengthPerSqm: 'To be confirmed' });
        await second.update({ floorStrengthPerSqm: '8 tonnes/sq m' });
        expect(second.write.mock.calls[0][1]).toMatchObject({ floorStrengthPerSqm: '8 tonnes/sq m' });
    });
    test.each(requiredPaths.filter(p => !['warehouseType', 'address', 'totalSpaceSqft', 'ratePerSqft'].includes(p)))('rejects clearing %s before a write', async path => {
        const { write, update } = setup(staged);
        await expect(update(patchForPath(path, null))).rejects.toHaveProperty('issues');
        expect(write).not.toHaveBeenCalled();
    });
    test('omits untouched legacy fields and guards only the intended edit', async () => {
        const row = completePptForm(); row.clearHeightFt = null; row.warehouseData.fireNocAvailable = null;
        const { write, update } = setup(staged, row);
        await update({ address: 'New address', clearHeightFt: null, warehouseData: { fireNocAvailable: null } });
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0].at(-1)).toEqual({ address: row.address });
        expect(write.mock.calls[0][1]).not.toHaveProperty('clearHeightFt');
        expect(write.mock.calls[0][1]).not.toHaveProperty('expectedFormValues');
    });
    test('changing a known handover mode requires complete replacement timing', async () => {
        const { update, write } = setup(staged);
        await expect(update({ handoverType: 'VARIABLE', handoverLeadValue: 2 })).rejects.toHaveProperty('issues');
        expect(write).not.toHaveBeenCalled();
        await update({ handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' });
        expect(write).toHaveBeenCalledTimes(1);
    });
    test('saved values are protected without rollout configuration', async () => {
        const { update, write } = setup(staged);
        await expect(update({ clearHeightFt: null })).rejects.toHaveProperty('issues');
        expect(write).not.toHaveBeenCalled();
    });
});
test('guards include the full handover selection and a missing WarehouseData relation', () => {
    expect(formUpdateGuard({ handoverType: 'FIXED', handoverDate: null }, { handoverType: 'VARIABLE', warehouseData: { powerKva: null } }))
        .toMatchObject({ handoverType: 'FIXED', handoverDate: null, handoverLeadValue: null, handoverLeadUnit: null, WarehouseData: { is: null } });
});

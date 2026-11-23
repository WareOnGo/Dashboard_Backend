const WarehouseService = require('../../src/services/warehouseService');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');

const baseline = { id: 1, status: null, lockInDate: null };
const expectedFormValues = { ...pptFormSnapshot(baseline), status: null, lockInDate: null };
const setup = row => {
    const update = jest.fn(async (_id, data) => ({ ...row, ...data }));
    const service = new WarehouseService({ findById: jest.fn().mockResolvedValue(row), update });
    service.applyMicroMarketTags = jest.fn();
    return { update, save: data => service.updateWarehouse(1, data) };
};

describe.each([
    ['status', 'Under construction', 'Ready to move'],
    ['lockInDate', new Date('2027-01-01T00:00:00Z'), '2027-02-01'],
])('Availability concurrency: %s', (key, current, intended) => {
    test('rejects an intentional edit from a stale form without a write', async () => {
        const { save, update } = setup({ ...baseline, [key]: current });
        await expect(save({ expectedFormValues, [key]: intended })).rejects.toMatchObject({ statusCode: 409 });
        expect(update).not.toHaveBeenCalled();
    });

    test('omits untouched values instead of reverting a concurrent edit', async () => {
        const { save, update } = setup({ ...baseline, [key]: current });
        await save({ expectedFormValues, [key]: null });
        expect(update).not.toHaveBeenCalled();
    });

    test('allows an idempotent retry after the first request succeeded', async () => {
        const stored = key === 'lockInDate' ? new Date(`${intended}T00:00:00Z`) : intended;
        const { save, update } = setup({ ...baseline, [key]: stored });
        await save({ expectedFormValues, [key]: intended });
        expect(update).not.toHaveBeenCalled();
    });

    test('guards the database write and retains compatibility with older clients', async () => {
        const { save, update } = setup(baseline);
        await save({ [key]: intended });
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0].at(-1)).toEqual({ [key]: null });
    });
});

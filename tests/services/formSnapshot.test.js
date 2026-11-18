const { prepareFormUpdate, formUpdateGuard, expectedFormValuesSchema } = require('../../src/utils/formChanges');
const { pptFormSnapshot, flatFormValues } = require('../../src/utils/pptFormPolicy');
const { completePptForm, requiredPaths, patchForPath } = require('../fixtures/pptForm');
const copy = value => JSON.parse(JSON.stringify(value));
const changed = value => Array.isArray(value) ? [20000] : typeof value === 'boolean' ? !value : `Updated ${value}`;
const updateRow = (original, path, value) => {
    const patch = patchForPath(path, value);
    return { ...original, ...patch, warehouseData: { ...original.warehouseData, ...patch.warehouseData } };
};

describe.each([false, true])('client snapshots for staged=%s', staged => {
    const shape = value => {
        if (!staged) return value;
        const flat = flatFormValues(value);
        delete flat.warehouseData; delete flat.WarehouseData;
        return flat;
    };
    test.each(requiredPaths)('stale untouched %s cannot overwrite a newer answer', path => {
        const original = completePptForm(), key = path.split('.').at(-1);
        const oldValue = flatFormValues(original)[key];
        const current = updateRow(original, path, changed(oldValue));
        const patch = shape(patchForPath(path, oldValue));
        prepareFormUpdate(shape(current), patch, pptFormSnapshot(original), { staged });
        expect(flatFormValues(patch)).not.toHaveProperty(key);
    });
    test.each(requiredPaths)('an intentional stale change to %s is rejected', path => {
        const original = completePptForm(), key = path.split('.').at(-1), oldValue = flatFormValues(original)[key];
        const current = updateRow(original, path, changed(oldValue));
        const intended = Array.isArray(oldValue) ? [30000] : typeof oldValue === 'boolean' ? null : `Another ${oldValue}`;
        expect(() => prepareFormUpdate(shape(current), shape(patchForPath(path, intended)), pptFormSnapshot(original), { staged }))
            .toThrow(expect.objectContaining({ code: 'FORM_FIELDS_CHANGED', statusCode: 409 }));
    });
});
test('snapshot validation rejects missing fields and Prisma predicate objects', () => {
    const snapshot = pptFormSnapshot(completePptForm());
    expect(expectedFormValuesSchema.safeParse(snapshot).success).toBe(true);
    expect(expectedFormValuesSchema.safeParse({}).success).toBe(false);
    expect(expectedFormValuesSchema.safeParse({ ...snapshot, powerKva: { not: null } }).success).toBe(false);
    expect(expectedFormValuesSchema.safeParse({ ...snapshot, OR: [{}] }).success).toBe(false);
});
test('snapshots isolate area arrays and preserve No, zero counts, and unknown answers', () => {
    const original = completePptForm(); original.warehouseData.powerKva = null;
    const snapshot = pptFormSnapshot(original);
    original.totalSpaceSqft.push(20000);
    expect(snapshot).toMatchObject({ totalSpaceSqft: [10000], fireNocAvailable: false, numberOfDocks: '0', powerKva: null });
});
test('a handover mode switch checks both active and retained timing from the browser', () => {
    const original = { ...completePptForm(), handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' };
    const current = { ...original, handoverLeadValue: 3 };
    expect(() => prepareFormUpdate(current, { handoverType: 'VARIABLE' }, pptFormSnapshot(original)))
        .toThrow(expect.objectContaining({ statusCode: 409 }));
    const untouched = Object.fromEntries(['handoverType', 'handoverDate', 'handoverLeadValue', 'handoverLeadUnit'].map(key => [key, original[key]]));
    prepareFormUpdate(current, untouched, pptFormSnapshot(original));
    expect(untouched).toEqual({});
});
test('snapshots and their atomic guard apply without rollout configuration', () => {
    const original = completePptForm(), patch = { clearHeightFt: '40 feet' };
    prepareFormUpdate(original, patch, pptFormSnapshot(original));
    expect(formUpdateGuard(original, patch)).toEqual({ clearHeightFt: original.clearHeightFt });
    expect(() => prepareFormUpdate({ ...original, clearHeightFt: '35 feet' }, copy(patch), pptFormSnapshot(original)))
        .toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => prepareFormUpdate(original, copy(patch))).toThrow(expect.objectContaining({ statusCode: 409 }));
});
test('enforcement requires original answers only when protected fields are supplied', () => {
    expect(() => prepareFormUpdate(completePptForm(), { clearHeightFt: '40 feet' }))
        .toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => prepareFormUpdate(completePptForm(), { scoutNotes: 'New note' })).not.toThrow();
});

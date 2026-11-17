const { warehousePermissionPatch: patch, effectiveWarehousePermissions: effective } = require('../../src/utils/warehousePermissions');
const keys = ['dashboardAccess', 'viewOwnWarehouseEntries', 'editOwnWarehouseEntries', 'viewAllWarehouseEntries', 'editAllWarehouseEntries'];
const all = Object.fromEntries(keys.map(key => [key, true]));
const none = Object.fromEntries(keys.map(key => [key, false]));

test.each([
    ['dashboardAccess', none],
    ['viewOwnWarehouseEntries', { ...none, dashboardAccess: true }],
    ['editOwnWarehouseEntries', { ...all, editOwnWarehouseEntries: false, editAllWarehouseEntries: false }],
    ['viewAllWarehouseEntries', { ...all, viewAllWarehouseEntries: false, editAllWarehouseEntries: false }],
    ['editAllWarehouseEntries', { ...all, editAllWarehouseEntries: false }],
])('revoking %s clears exactly its dependents', (key, expected) => {
    expect(patch(all, { [key]: false })).toEqual(expected);
});

test('granting edit all enables all prerequisites; restoring Dashboard does not restore revoked grants', () => {
    expect(patch(none, { editAllWarehouseEntries: true })).toEqual(all);
    expect(patch(none, { dashboardAccess: true })).toEqual({ ...none, dashboardAccess: true });
});

test('view all can coexist with edit own and without edit all', () => {
    expect(patch(all, { editAllWarehouseEntries: false })).toEqual({ ...all, editAllWarehouseEntries: false });
});

test('unrelated roster edits preserve dormant migration grants', () => {
    expect(patch({ ...all, dashboardAccess: false }, { name: 'Renamed' })).toEqual({});
});

test('missing or malformed stored permissions fail closed', () => {
    expect(effective({ dashboardAccess: true, editAllWarehouseEntries: true })).toEqual({ ...none, dashboardAccess: true });
    expect(effective({ ...all, viewOwnWarehouseEntries: 'true' })).toEqual({ ...none, dashboardAccess: true });
});

test('every stored combination and partial update obeys dependencies and explicit revocations', () => {
    // 32 stored states × 243 possible absent/false/true PATCH bodies.
    for (let state = 0; state < 32; state++) {
        const stored = Object.fromEntries(keys.map((key, i) => [key, !!(state & (1 << i))]));
        for (let code = 1; code < 243; code++) {
            let n = code;
            const edits = {};
            for (const key of keys) { const value = n % 3; n = Math.floor(n / 3); if (value) edits[key] = value === 2; }
            const next = patch(stored, edits);
            expect(next.viewOwnWarehouseEntries && !next.dashboardAccess).toBe(false);
            expect(next.editOwnWarehouseEntries && !next.viewOwnWarehouseEntries).toBe(false);
            expect(next.viewAllWarehouseEntries && !next.viewOwnWarehouseEntries).toBe(false);
            expect(next.editAllWarehouseEntries && !(next.editOwnWarehouseEntries && next.viewAllWarehouseEntries)).toBe(false);
            for (const key of keys) if (edits[key] === false) expect(next[key]).toBe(false);
        }
    }
});

// Dashboard is the parent grant. Editing requires viewing, and "all" includes
// "own". Keep this graph aligned with the admin UI's warehousePermissions.js.
const DEPENDENCIES = Object.freeze({
    dashboardAccess: [],
    viewOwnWarehouseEntries: ['dashboardAccess'],
    editOwnWarehouseEntries: ['viewOwnWarehouseEntries'],
    viewAllWarehouseEntries: ['viewOwnWarehouseEntries'],
    editAllWarehouseEntries: ['editOwnWarehouseEntries', 'viewAllWarehouseEntries'],
});
const WAREHOUSE_PERMISSION_COLUMNS = Object.freeze(Object.keys(DEPENDENCIES).slice(1));
// Creation defaults only: changing these must never regrant existing employees.
const NEW_EMPLOYEE_WAREHOUSE_PERMISSIONS = Object.freeze({
    dashboardAccess: true,
    viewOwnWarehouseEntries: true,
    editOwnWarehouseEntries: true,
    viewAllWarehouseEntries: true,
    editAllWarehouseEntries: false,
});

function effectiveWarehousePermissions(row = {}) {
    const result = {};
    for (const [key, parents] of Object.entries(DEPENDENCIES)) {
        result[key] = row[key] === true && parents.every(parent => result[parent]);
    }
    return result;
}

// Used inside the roster transaction: no stale client snapshot can restore an
// unrelated revoked grant. Explicit false wins in contradictory API payloads.
function warehousePermissionPatch(existing, edits) {
    const keys = Object.keys(DEPENDENCIES);
    if (!keys.some(key => Object.hasOwn(edits, key))) return {};
    const next = Object.fromEntries(keys.map(key => [key, (edits[key] ?? existing[key]) === true]));
    const enable = key => {
        if (edits[key] === false) return;
        next[key] = true;
        DEPENDENCIES[key].forEach(enable);
    };
    keys.filter(key => edits[key] === true).forEach(enable);
    return effectiveWarehousePermissions(next);
}

module.exports = { DEPENDENCIES, WAREHOUSE_PERMISSION_COLUMNS, NEW_EMPLOYEE_WAREHOUSE_PERMISSIONS, effectiveWarehousePermissions, warehousePermissionPatch };

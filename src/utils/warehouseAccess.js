const { CAPS } = require('./access');
const insensitiveExact = require('./insensitiveExact');

const forbidden = () => Object.assign(new Error('You do not have access to this warehouse action.'), { name: 'ForbiddenError', statusCode: 403 });
const emailOf = user => typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
// Only the Availability section is shared with employees who can edit their own
// entries. Request-only concurrency snapshots are allowed, never persisted.
const AVAILABILITY_FIELDS = Object.freeze([
    'availability', 'availabilityLastReviewedOn', 'handoverType', 'handoverDate',
    'handoverLeadValue', 'handoverLeadUnit', 'lockInDate', 'status',
]);
const availabilityUpdateKeys = new Set([...AVAILABILITY_FIELDS, 'expectedAvailability', 'expectedFormValues']);

function warehouseScope(user, action = 'view') {
    const caps = user?.capabilities;
    const own = action === 'edit' ? CAPS.WAREHOUSE_EDIT_OWN : CAPS.WAREHOUSE_VIEW_OWN;
    const all = action === 'edit' ? CAPS.WAREHOUSE_EDIT_ALL : CAPS.WAREHOUSE_VIEW_ALL;
    if (!caps?.[CAPS.DASHBOARD] || !caps?.[own]) throw forbidden();
    if (caps[all]) return {};
    const email = emailOf(user);
    if (!email) throw forbidden();
    return { uploadedBy: insensitiveExact(email) };
}

function assertWarehouseAccess(user, warehouse, action = 'view') {
    const scope = warehouseScope(user, action);
    if (scope.uploadedBy && (typeof warehouse?.uploadedBy !== 'string'
        || warehouse.uploadedBy.toLowerCase() !== emailOf(user))) throw forbidden();
}

function canAccessWarehouse(user, warehouse, action = 'view') {
    try { assertWarehouseAccess(user, warehouse, action); return true; }
    catch (error) { if (error.statusCode === 403) return false; throw error; }
}

function assertWarehouseUpdateAccess(user, warehouse, edits) {
    if (canAccessWarehouse(user, warehouse, 'edit')) return;
    // The exception changes writable fields, never the employee's view scope.
    warehouseScope(user, 'edit');
    assertWarehouseAccess(user, warehouse, 'view');
    if (Object.keys(edits || {}).some(key => !availabilityUpdateKeys.has(key))) throw forbidden();
}

module.exports = { warehouseScope, assertWarehouseAccess, canAccessWarehouse, assertWarehouseUpdateAccess, AVAILABILITY_FIELDS };

const { CAPS } = require('./access');
const insensitiveExact = require('./insensitiveExact');

const forbidden = () => Object.assign(new Error('You do not have access to this warehouse action.'), { name: 'ForbiddenError', statusCode: 403 });
const emailOf = user => typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';

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

module.exports = { warehouseScope, assertWarehouseAccess, canAccessWarehouse };

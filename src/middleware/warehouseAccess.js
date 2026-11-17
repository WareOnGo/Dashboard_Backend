const database = require('../utils/database');
const { warehouseScope, assertWarehouseAccess } = require('../utils/warehouseAccess');

// Install after requireAccess: authorization comes from the current roster,
// never from a submitted uploader, query filter, or JWT permission claim.
const requireWarehouseEntry = (action = 'view') => async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id) || id > 2147483647) {
            return res.status(400).json({ error: 'Invalid warehouse ID.' });
        }
        const scope = warehouseScope(req.user, action);
        if (scope.uploadedBy) {
            const warehouse = await database.getClient().warehouse.findUnique({
                where: { id }, select: { uploadedBy: true },
            });
            if (!warehouse) return res.status(404).json({ error: 'Warehouse not found.' });
            assertWarehouseAccess(req.user, warehouse, action);
        }
        next();
    } catch (error) { next(error); }
};

module.exports = { requireWarehouseEntry };

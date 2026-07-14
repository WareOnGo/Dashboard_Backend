// src/models/visitNoteModel.js
const BaseModel = require('./baseModel');

/**
 * VisitNoteModel — site-visit log entries for a warehouse.
 * A warehouse has many visit notes; rows cascade-delete with the warehouse.
 */
class VisitNoteModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.warehouseVisitNote;
    }

    listByWarehouseId(warehouseId) {
        return this.model.findMany({
            where: { warehouseId: Number(warehouseId) },
            orderBy: [{ visitDate: 'desc' }, { createdAt: 'desc' }],
        });
    }

    getById(id) {
        return this.model.findUnique({ where: { id: Number(id) } });
    }

    createOne(data) {
        return this.model.create({ data });
    }

    updateById(id, data) {
        return this.model.update({ where: { id: Number(id) }, data });
    }

    deleteById(id) {
        return this.model.delete({ where: { id: Number(id) } });
    }
}

module.exports = VisitNoteModel;

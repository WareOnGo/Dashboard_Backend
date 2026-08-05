// src/models/microMarketModel.js
const BaseModel = require('./baseModel');

/**
 * MicroMarketModel — reviewer-drawn polygon areas.
 * IDs are strings (client-supplied draw ids / uuids), so the integer-based
 * helpers on BaseModel are not used; these methods address rows by string id.
 */
class MicroMarketModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.microMarket;
    }

    listAll() {
        return this.model.findMany({ orderBy: { createdAt: 'asc' } });
    }

    /**
     * Just the columns point-in-polygon tagging needs. Skips reviewer/timestamp
     * columns so the cached set stays small.
     * @returns {Promise<Array<{id: string, name: string, geometry: Object}>>}
     */
    listForTagging() {
        return this.model.findMany({ select: { id: true, name: true, geometry: true } });
    }

    getById(id) {
        return this.model.findUnique({ where: { id: String(id) } });
    }

    createOne(data) {
        return this.model.create({ data });
    }

    updateById(id, data) {
        return this.model.update({ where: { id: String(id) }, data });
    }

    deleteById(id) {
        return this.model.delete({ where: { id: String(id) } });
    }
}

module.exports = MicroMarketModel;

// src/models/verifiedNumberModel.js
const BaseModel = require('./baseModel');

/**
 * VerifiedNumberModel — WareOnGo staff / points-of-contact whose numbers are
 * verified. Used to populate POC pickers (e.g. the PPT generator).
 */
class VerifiedNumberModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.verifiedNumber;
    }

    /**
     * List active verified numbers as lightweight { id, name, phone_number, email }
     * rows, ordered by name. Only fields needed for a POC dropdown are selected;
     * email lets the client preselect the logged-in user's own entry.
     * @returns {Promise<Array<{ id: number, name: string, phone_number: string, email: string|null }>>}
     */
    listActive() {
        return this.model.findMany({
            where: { is_active: true },
            select: { id: true, name: true, phone_number: true, email: true },
            orderBy: { name: 'asc' },
        });
    }
}

module.exports = VerifiedNumberModel;

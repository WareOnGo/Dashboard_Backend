// src/services/microMarketService.js
const BaseService = require('./baseService');

const clientError = (message, statusCode) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

/**
 * MicroMarketService — CRUD for reviewer-drawn polygon areas.
 * Single-statement operations only (no interactive transactions) to stay safe
 * on the Supabase pooler. Reviewer identity is stamped from the JWT.
 */
class MicroMarketService extends BaseService {
    /**
     * @param {MicroMarketModel} microMarketModel
     */
    constructor(microMarketModel) {
        super();
        this.microMarketModel = microMarketModel;
    }

    list() {
        return this.executeOperation(() => this.microMarketModel.listAll());
    }

    create({ id, name, city, geometry, reviewer }) {
        return this.executeOperation(async () => {
            if (!geometry || geometry.type == null) {
                throw clientError('geometry (GeoJSON) is required', 400);
            }
            const data = {
                name: name || '',
                city: city || '',
                geometry,
                reviewerEmail: reviewer?.email || null,
                reviewerName: reviewer?.name || null,
            };
            if (id != null) data.id = String(id);
            try {
                return await this.microMarketModel.createOne(data);
            } catch (err) {
                if (err.code === 'P2002') throw clientError('id already exists', 409);
                throw err;
            }
        });
    }

    update(id, { name, city, geometry, reviewer }) {
        return this.executeOperation(async () => {
            const data = {};
            if (geometry) data.geometry = geometry;
            if (typeof name === 'string') data.name = name;
            if (typeof city === 'string') data.city = city;
            // Stamp the last editor so attribution reflects who touched it most recently.
            if (reviewer?.email) data.reviewerEmail = reviewer.email;
            if (reviewer?.name) data.reviewerName = reviewer.name;
            try {
                return await this.microMarketModel.updateById(id, data);
            } catch (err) {
                if (err.code === 'P2025') throw clientError('not found', 404);
                throw err;
            }
        });
    }

    remove(id) {
        return this.executeOperation(async () => {
            try {
                await this.microMarketModel.deleteById(id);
            } catch (err) {
                // Idempotent: deleting a missing row is a no-op success.
                if (err.code !== 'P2025') throw err;
            }
        });
    }
}

module.exports = MicroMarketService;

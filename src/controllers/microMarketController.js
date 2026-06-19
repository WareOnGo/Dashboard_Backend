// src/controllers/microMarketController.js
const BaseController = require('./baseController');

/**
 * MicroMarketController — reviewer-facing CRUD for drawn polygon areas.
 * Returns GeoJSON (FeatureCollection on list, Feature on create/update).
 */
class MicroMarketController extends BaseController {
    /**
     * @param {MicroMarketService} microMarketService
     */
    constructor(microMarketService) {
        super();
        this.microMarketService = microMarketService;
    }

    /** Map service-thrown client errors (4xx) to responses; let 5xx bubble. */
    handleServiceError(res, error, next) {
        if (error && error.statusCode && error.statusCode < 500) {
            return this.sendError(res, error.message, error.statusCode);
        }
        return next(error);
    }

    /** Prisma row -> GeoJSON Feature */
    toFeature(row) {
        return {
            type: 'Feature',
            id: row.id,
            properties: {
                name: row.name,
                city: row.city,
                reviewerEmail: row.reviewerEmail,
                reviewerName: row.reviewerName,
                updatedAt: row.updatedAt,
            },
            geometry: row.geometry,
        };
    }

    reviewerFrom(req) {
        return { email: req.user?.email, name: req.user?.name };
    }

    /** GET /api/micro-markets */
    list = this.asyncHandler(async (req, res, next) => {
        try {
            const rows = await this.microMarketService.list();
            this.sendSuccess(res, {
                type: 'FeatureCollection',
                features: rows.map((r) => this.toFeature(r)),
            });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/micro-markets */
    create = this.asyncHandler(async (req, res, next) => {
        try {
            const { id, name, city, geometry } = req.body || {};
            const row = await this.microMarketService.create({
                id, name, city, geometry, reviewer: this.reviewerFrom(req),
            });
            if (typeof req.audit === 'function') {
                req.audit('CREATE', 'micro_market', row.id, `Created micro-market ${row.name || row.id}`);
            }
            this.sendCreated(res, this.toFeature(row));
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** PUT /api/micro-markets/:id */
    update = this.asyncHandler(async (req, res, next) => {
        try {
            const { name, city, geometry } = req.body || {};
            const row = await this.microMarketService.update(req.params.id, {
                name, city, geometry, reviewer: this.reviewerFrom(req),
            });
            if (typeof req.audit === 'function') {
                req.audit('UPDATE', 'micro_market', row.id, `Updated micro-market ${row.id}`);
            }
            this.sendSuccess(res, this.toFeature(row));
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** DELETE /api/micro-markets/:id */
    remove = this.asyncHandler(async (req, res, next) => {
        try {
            await this.microMarketService.remove(req.params.id);
            if (typeof req.audit === 'function') {
                req.audit('DELETE', 'micro_market', req.params.id, `Deleted micro-market ${req.params.id}`);
            }
            this.sendNoContent(res);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });
}

module.exports = MicroMarketController;

// src/services/geoService.js
const BaseService = require('./baseService');

/**
 * Rows returned per layer per viewport request.
 *
 * Sized for what a map can usefully draw, not for what the database can return:
 * past a few thousand points a viewport is visual noise, and the honest fix is to
 * zoom in or filter, not to ship more geometry. The response reports `truncated`
 * so the UI can say so rather than silently showing a partial picture.
 */
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

/** Refuse absurd viewports — a bbox spanning the globe is a bug, not a query. */
const MAX_BBOX_SPAN_DEG = 30;

/**
 * Types a point of interest may have. The dashboard renders these as a dropdown
 * and gives each one its own map glyph; the list is duplicated there because the
 * two need different shapes (codes here, codes plus labels and glyphs there).
 * Add to both, and only ever append — an existing code is stored on live rows.
 */
const POI_CATEGORIES = [
    'POTENTIAL_CLIENT',
    'POTENTIAL_WAREHOUSE',
    'FOOD_PLACE',
    'HOTEL_RESTAURANT',
    'LABOR_QUARTERS',
    'OPEN_YARD_BTS',
];

/**
 * GeoService — assembles GeoJSON for the map view.
 *
 * Returns GeoJSON FeatureCollections because that is what Mapbox consumes
 * directly as a source; no client-side transformation, and the same payload can
 * be handed to any other GIS tool unchanged.
 */
class GeoService extends BaseService {
    constructor(geoModel) {
        super();
        this.geoModel = geoModel;
    }

    /**
     * Parse and sanity-check a "west,south,east,north" bbox string.
     * @param {string} raw
     * @returns {{west:number,south:number,east:number,north:number}}
     * @private
     */
    parseBbox(raw) {
        const parts = String(raw ?? '').split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            throw this.validationError('bbox must be "west,south,east,north" in decimal degrees');
        }
        const [west, south, east, north] = parts;
        if (west >= east || south >= north) {
            throw this.validationError('bbox must have west < east and south < north');
        }
        if (Math.abs(north - south) > MAX_BBOX_SPAN_DEG || Math.abs(east - west) > MAX_BBOX_SPAN_DEG) {
            throw this.validationError(`bbox is too large; keep each span under ${MAX_BBOX_SPAN_DEG} degrees`);
        }
        if (south < -90 || north > 90 || west < -180 || east > 180) {
            throw this.validationError('bbox is outside valid coordinate ranges');
        }
        return { west, south, east, north };
    }

    /** @private */
    validationError(message) {
        const error = new Error(message);
        error.name = 'ValidationError';
        error.issues = [{ path: ['bbox'], message }];
        return error;
    }

    /** @private */
    parseCategories(raw) {
        return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    }

    /** @private */
    clampLimit(raw) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
        return Math.min(Math.floor(n), MAX_LIMIT);
    }

    /**
     * Wrap rows as a GeoJSON FeatureCollection.
     * @private
     */
    toFeatureCollection(rows, buildProps, limit) {
        return {
            type: 'FeatureCollection',
            // The client shows a "zoom in to see everything" hint on this rather
            // than quietly rendering a partial layer.
            truncated: rows.length >= limit,
            features: rows.map((r) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
                properties: buildProps(r),
            })),
        };
    }

    /** OSM points for a viewport. */
    async osmPois({ bbox, categories, limit }) {
        return this.executeOperation(async () => {
            const box = this.parseBbox(bbox);
            const cats = this.parseCategories(categories);
            const cap = this.clampLimit(limit);
            const rows = await this.geoModel.osmPoisInBbox(box, cats, cap);
            return this.toFeatureCollection(rows, (r) => ({
                id: r.id, category: r.category, name: r.name, source: 'osm',
            }), cap);
        });
    }

    /** Our own points for a viewport. */
    async ownPois({ bbox, categories, limit }) {
        return this.executeOperation(async () => {
            const box = this.parseBbox(bbox);
            const cats = this.parseCategories(categories);
            const cap = this.clampLimit(limit);
            const rows = await this.geoModel.ownPoisInBbox(box, cats, cap);
            return this.toFeatureCollection(rows, (r) => ({
                id: r.id, category: r.category, name: r.name,
                notes: r.notes, city: r.city, createdBy: r.createdBy, source: 'internal',
            }), cap);
        });
    }

    /** Warehouses for a viewport. */
    async warehouses({ bbox, limit }) {
        return this.executeOperation(async () => {
            const box = this.parseBbox(bbox);
            const cap = this.clampLimit(limit);
            const rows = await this.geoModel.warehousesInBbox(box, cap);
            return this.toFeatureCollection(rows, (r) => ({
                id: r.id, city: r.city, availability: r.availability, warehouseType: r.warehouseType,
            }), cap);
        });
    }

    /**
     * Everything the layer sidebar needs to render its toggles, in one call.
     */
    async layers() {
        return this.executeOperation(async () => {
            const [osm, own] = await Promise.all([
                this.geoModel.osmCategories(),
                this.geoModel.ownCategories(),
            ]);
            return { osm, internal: own };
        });
    }

    // --- CRUD for our own points ---

    /** @private */
    validatePoiPayload(body, { partial = false } = {}) {
        const out = {};
        const need = (k) => {
            if (body[k] === undefined || body[k] === null || body[k] === '') {
                throw this.validationError(`${k} is required`);
            }
        };

        if (!partial) { need('name'); need('category'); }
        if (body.name !== undefined) out.name = String(body.name).trim();
        if (body.category !== undefined) {
            const cat = String(body.category).trim();
            // The UI offers these as a dropdown; enforcing the same list here is
            // what actually keeps the column a usable facet, since the endpoint
            // is reachable without the UI.
            if (!POI_CATEGORIES.includes(cat)) {
                throw this.validationError(`category must be one of: ${POI_CATEGORIES.join(', ')}`);
            }
            out.category = cat;
        }
        if (body.notes !== undefined) out.notes = body.notes === null ? null : String(body.notes);
        if (body.city !== undefined) out.city = body.city === null ? null : String(body.city);

        for (const [key, min, max] of [['lat', -90, 90], ['lng', -180, 180]]) {
            if (body[key] === undefined) {
                if (!partial) throw this.validationError(`${key} is required`);
                continue;
            }
            const n = Number(body[key]);
            if (!Number.isFinite(n) || n < min || n > max) {
                throw this.validationError(`${key} must be a number between ${min} and ${max}`);
            }
            out[key] = n;
        }
        return out;
    }

    /**
     * Load a point and confirm the caller may change it.
     *
     * Enforced here rather than in the UI: hiding a button stops nobody from
     * calling the endpoint directly, so ownership has to be checked on the
     * server or it is not a guard at all.
     *
     * Admins are allowed through — they can already delete warehouses, and
     * without an override the only way to remove a bad point left by someone
     * who has left the company would be raw SQL.
     *
     * @private
     */
    async loadOwnedPoi(id, user) {
        const row = await this.geoModel.findOwnPoi(id);
        if (!row) {
            const error = new Error(`Point ${id} not found`);
            error.name = 'NotFoundError';
            error.statusCode = 404;
            throw error;
        }
        const email = user?.email;
        if (!user?.isAdmin && row.createdBy !== email) {
            const error = new Error('You can only change points you added.');
            error.name = 'ForbiddenError';
            error.statusCode = 403;
            throw error;
        }
        return row;
    }

    async createOwnPoi(body, user) {
        return this.executeOperation(async () => {
            const data = this.validatePoiPayload(body);
            data.createdBy = user?.email || 'unknown';
            return this.geoModel.createOwnPoi(data);
        });
    }

    async updateOwnPoi(id, body, user) {
        return this.executeOperation(async () => {
            await this.loadOwnedPoi(id, user);
            const data = this.validatePoiPayload(body, { partial: true });
            if (!Object.keys(data).length) throw this.validationError('no updatable fields supplied');
            // createdBy is never updatable: a point's author is a fact about who
            // added it, not a field its author can hand off.
            delete data.createdBy;
            return this.geoModel.updateOwnPoi(id, data);
        });
    }

    async deleteOwnPoi(id, user) {
        return this.executeOperation(async () => {
            await this.loadOwnedPoi(id, user);
            await this.geoModel.deleteOwnPoi(id);
            return { id };
        });
    }
}

module.exports = GeoService;

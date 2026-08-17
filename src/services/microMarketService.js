// src/services/microMarketService.js
const BaseService = require('./baseService');
const { resolveTags, labelFor } = require('../utils/microMarketGeometry');
const { fuzzyMatches, DEFAULT_THRESHOLD } = require('../utils/fuzzyMatch');

const clientError = (message, statusCode) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

/**
 * How long a cached polygon set is trusted. Writes made through this service
 * bust the cache immediately, so the TTL only covers changes made out-of-band
 * (direct SQL, the standalone micro-market-mapper app, another instance).
 */
const POLYGON_CACHE_TTL_MS = 5 * 60 * 1000;

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
        /** @type {{ at: number, markets: Array }|null} Cached polygon set for tagging. */
        this.polygonCache = null;
    }

    list() {
        return this.executeOperation(() => this.microMarketModel.listAll());
    }

    /** Drop the cached polygon set so the next tag call re-reads from the DB. */
    invalidatePolygonCache() {
        this.polygonCache = null;
    }

    /**
     * The polygon set used for tagging, cached in memory.
     *
     * Worth caching: the containment maths costs ~8µs, but fetching the polygons
     * over the Supabase pooler costs ~250-800ms. Uncached, every tagged write
     * would pay that round trip. The whole set is ~17KB, so holding it is cheap.
     * @private
     */
    async getPolygons() {
        const fresh = this.polygonCache && Date.now() - this.polygonCache.at < POLYGON_CACHE_TTL_MS;
        if (fresh) return this.polygonCache.markets;

        const markets = await this.microMarketModel.listForTagging();
        this.polygonCache = { at: Date.now(), markets };
        return markets;
    }

    /**
     * Micro-market tags for a coordinate pair — the names of every polygon
     * containing the point (id as a fallback for unnamed polygons), sorted.
     * Overlapping polygons are legitimate, hence an array.
     *
     * Never throws: tagging is an enrichment, so a polygon-fetch failure must not
     * break the warehouse write that triggered it. Returns [] on failure.
     * @param {number|null} lat
     * @param {number|null} lon
     * @returns {Promise<string[]>}
     */
    async tagsForPoint(lat, lon) {
        if (lat == null || lon == null) return [];
        try {
            return resolveTags(await this.getPolygons(), lat, lon);
        } catch (err) {
            console.error('MicroMarketService: micro-market tagging failed', err.message);
            return [];
        }
    }

    /**
     * Micro-market tags whose name approximately matches a free-text term.
     *
     * Exists because `Warehouse.micromarket` is a Postgres `text[]`, and Prisma's
     * scalar-list filters (`has`/`hasSome`) only do exact equality — there is no
     * `contains`/`mode: 'insensitive'` for array columns. So instead of matching
     * loosely against the stored array, we resolve the search term to concrete tag
     * names first (the vocabulary is closed and already cached in memory for
     * tagging) and then match those exactly.
     *
     * Never throws: search must degrade to "no micro-market hits" rather than 500.
     *
     * @param {string} term - free-text search term
     * @param {number} [threshold=DEFAULT_THRESHOLD] - similarity floor, 0..1
     * @returns {Promise<string[]>} matching tags, de-duplicated and sorted
     */
    async namesMatching(term, threshold = DEFAULT_THRESHOLD) {
        const needle = String(term ?? '').trim();
        if (!needle) return [];
        try {
            const markets = await this.getPolygons();
            const hits = markets
                .map(labelFor)
                .filter((label) => fuzzyMatches(needle, label, threshold));
            return [...new Set(hits)].sort();
        } catch (err) {
            console.error('MicroMarketService: micro-market name lookup failed', err.message);
            return [];
        }
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
                const created = await this.microMarketModel.createOne(data);
                this.invalidatePolygonCache();
                return created;
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
                const updated = await this.microMarketModel.updateById(id, data);
                this.invalidatePolygonCache();
                return updated;
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
            this.invalidatePolygonCache();
        });
    }
}

module.exports = MicroMarketService;

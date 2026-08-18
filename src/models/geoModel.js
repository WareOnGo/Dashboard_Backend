// src/models/geoModel.js
const { Prisma } = require('@prisma/client');
const BaseModel = require('./baseModel');

/**
 * GeoModel — viewport queries for the map view.
 *
 * Every read is bounded by a bbox and a row limit. A map query without both is a
 * request for the whole country: at national zoom an unbounded POI select would
 * try to return every row in the table, so the bound is a correctness property
 * rather than an optimisation.
 *
 * Bounding boxes use the `&&` operator against a geography envelope, which is
 * answered by the GiST index on the generated `geog` column (see
 * scripts/setupGeoColumns.js). Prisma cannot express geography, so these are raw.
 */
class GeoModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
    }

    /**
     * OSM points inside a bbox, optionally restricted to categories.
     * @param {{west:number,south:number,east:number,north:number}} bbox
     * @param {string[]} categories - empty means all
     * @param {number} limit
     */
    async osmPoisInBbox(bbox, categories, limit) {
        try {
            const envelope = Prisma.sql`ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)::geography`;
            const categoryFilter = categories.length
                ? Prisma.sql`AND category IN (${Prisma.join(categories)})`
                : Prisma.empty;

            return await this.prisma.$queryRaw`
                SELECT id, category, name, lat, lng
                FROM osm_poi
                WHERE geog && ${envelope}
                ${categoryFilter}
                LIMIT ${limit}
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Category list with counts, for building the layer toggles. Cheap enough to
     * call on page load — it is an index-only scan over osm_poi_category_idx.
     */
    async osmCategories() {
        try {
            return await this.prisma.$queryRaw`
                SELECT category, COUNT(*)::int AS count
                FROM osm_poi GROUP BY category ORDER BY category
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Our own points inside a bbox. Small table — the bbox is for consistency. */
    async ownPoisInBbox(bbox, categories, limit) {
        try {
            const envelope = Prisma.sql`ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)::geography`;
            const categoryFilter = categories.length
                ? Prisma.sql`AND category IN (${Prisma.join(categories)})`
                : Prisma.empty;

            return await this.prisma.$queryRaw`
                SELECT id, category, name, notes, city, lat, lng, "createdBy"
                FROM point_of_interest
                WHERE geog && ${envelope}
                ${categoryFilter}
                LIMIT ${limit}
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Warehouses inside a bbox, as points.
     *
     * Deliberately lean: id, availability and coordinates only. The map needs a
     * dot and a colour; opening a warehouse fetches the full record.
     */
    async warehousesInBbox(bbox, limit) {
        try {
            const envelope = Prisma.sql`ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)::geography`;
            return await this.prisma.$queryRaw`
                SELECT w.id, w.city, w.availability, w."warehouseType",
                       d.latitude AS lat, d.longitude AS lng
                FROM "WarehouseData" d
                JOIN "Warehouse" w ON w.id = d."warehouseId"
                WHERE d.geog && ${envelope}
                LIMIT ${limit}
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    // --- CRUD for our own points ---

    async createOwnPoi(data) {
        try {
            return await this.prisma.pointOfInterest.create({ data });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    async updateOwnPoi(id, data) {
        try {
            return await this.prisma.pointOfInterest.update({ where: { id: String(id) }, data });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    async deleteOwnPoi(id) {
        try {
            return await this.prisma.pointOfInterest.delete({ where: { id: String(id) } });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Distinct categories in use on our own points, for the toggle UI. */
    async ownCategories() {
        try {
            return await this.prisma.$queryRaw`
                SELECT category, COUNT(*)::int AS count
                FROM point_of_interest GROUP BY category ORDER BY category
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = GeoModel;

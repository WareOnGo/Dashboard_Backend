const { Prisma } = require('@prisma/client');

// These column names are fixed here; request values are always SQL parameters.
const TEXT_FIELDS = [
    'city', 'state', 'zone', 'warehouseType', 'warehouseOwnerType',
    'availability', 'isBroker', 'uploadedBy', 'contactPerson', 'listing_type', 'status',
];
const SEARCH_FIELDS = ['address', 'city', 'contactPerson', 'warehouseType', 'warehouseOwnerType'];
const column = (field) => Prisma.raw(`w."${field}"`);
const contains = (field, value) => Prisma.sql`${column(field)} ILIKE ${`%${value}%`}`;

/**
 * SQL equivalent of WarehouseService.buildWhere/resolveWhere for viewport reads.
 * Apply filters in the spatial query BEFORE LIMIT; filtering a capped set of pins
 * afterwards would silently omit matching warehouses in busy areas.
 */
function warehouseMapFilters(filters = {}, microMarkets = []) {
    const conditions = [];
    if (filters.afterId != null) conditions.push(Prisma.sql`w.id > ${filters.afterId}`);
    const term = filters.search?.trim();
    if (term) {
        const search = SEARCH_FIELDS.map(field => contains(field, term));
        if (/^\d+$/.test(term)) search.push(Prisma.sql`w.id = ${Number(term)}`);
        if (microMarkets.length) search.push(Prisma.sql`w.micromarket && ARRAY[${Prisma.join(microMarkets)}]::text[]`);
        conditions.push(Prisma.sql`(${Prisma.join(search, ' OR ')})`);
    }
    for (const field of TEXT_FIELDS) {
        if (filters[field]) conditions.push(contains(field, filters[field]));
    }
    if (filters.ids) {
        const ids = [...new Set(filters.ids.split(',').map(Number).filter(id => Number.isInteger(id) && id > 0))];
        conditions.push(ids.length ? Prisma.sql`w.id IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
    }
    if (filters.visibility === 'visible') conditions.push(Prisma.sql`w.visibility IS TRUE`);
    if (filters.visibility === 'hidden') conditions.push(Prisma.sql`w.visibility IS NOT TRUE`);
    if (filters.fireNoc === 'available') conditions.push(Prisma.sql`d."fireNocAvailable" IS TRUE`);
    // Match the listing's Prisma NOT relation filter: on an existing data row,
    // SQL NULL is excluded by that predicate. A row without coordinates cannot
    // appear in either map query in the first place.
    if (filters.fireNoc === 'not_available') conditions.push(Prisma.sql`d."fireNocAvailable" IS FALSE`);
    if (filters.landType) conditions.push(Prisma.sql`d."landType" ILIKE ${`%${filters.landType}%`}`);

    // Match the listing's numeric filters: ANY offered area, and a safely parsed
    // text rate. Keeping these inside this query avoids an all-warehouse ID scan.
    if (filters.minArea != null || filters.maxArea != null) {
        conditions.push(Prisma.sql`EXISTS (
            SELECT 1 FROM unnest(w."totalSpaceSqft") AS area
            WHERE area BETWEEN ${filters.minArea ?? 0} AND ${filters.maxArea ?? 2147483647}
        )`);
    }
    if (filters.minRate != null || filters.maxRate != null) {
        const cleaned = Prisma.sql`regexp_replace(COALESCE(w."ratePerSqft", ''), '[^0-9.]', '', 'g')`;
        conditions.push(Prisma.sql`(CASE WHEN ${cleaned} ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN ${cleaned}::double precision ELSE NULL END)
            BETWEEN ${filters.minRate ?? 0} AND ${filters.maxRate ?? 1000000000}`);
    }
    return conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

module.exports = { warehouseMapFilters };

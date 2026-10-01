const { Prisma } = require('@prisma/client');

// Names come from the generated schema. Values remain bound parameters.
function fields(model, data, excluded) {
    const definition = Prisma.dmmf.datamodel.models.find(entry => entry.name === model);
    const allowed = new Set(definition.fields.filter(field => ['scalar', 'enum'].includes(field.kind)
        && !excluded.includes(field.name)).map(field => field.name));
    const keys = Object.keys(data).filter(key => data[key] !== undefined);
    if (keys.some(key => !allowed.has(key))) throw new Error('Invalid promotion fields');
    return keys;
}
const readFields = model => Prisma.dmmf.datamodel.models.find(entry => entry.name === model).fields
    .filter(field => ['scalar', 'enum'].includes(field.kind) && !['geog', 'embedding'].includes(field.name)).map(field => field.name);
const quoted = key => '"' + key.replaceAll('"', '""') + '"';

async function atomicPromotion(prisma, id, warehouse, warehouseData, reviewer) {
    const data = { ...warehouse, status_updated_at: new Date() };
    const columns = fields('Warehouse', data, ['id']);
    const extra = fields('WarehouseData', warehouseData, ['id', 'warehouseId', 'geog', 'embedding']);
    // Lock the pending submission, insert both records and update staging ONCE.
    // A failed link or queue trigger rolls back every insert in this statement.
    const rows = await prisma.$queryRawUnsafe(`WITH claim AS MATERIALIZED (
        SELECT id FROM "StagedWarehouse" WHERE id=$1 AND "reviewStatus"='PENDING' FOR UPDATE
      ), master AS (
        INSERT INTO "Warehouse" (${columns.map(quoted).join(',')})
        SELECT ${columns.map(key => 'p.' + quoted(key)).join(',')}
        FROM jsonb_populate_record(NULL::"Warehouse",$2::jsonb) p WHERE EXISTS(SELECT 1 FROM claim)
        RETURNING *
      ), details AS (
        INSERT INTO "WarehouseData" ("warehouseId"${extra.length ? ',' + extra.map(quoted).join(',') : ''})
        SELECT m.id${extra.length ? ',' + extra.map(key => 'p.' + quoted(key)).join(',') : ''}
        FROM master m CROSS JOIN jsonb_populate_record(NULL::"WarehouseData",$3::jsonb) p RETURNING *
      ), linked AS (
        UPDATE "StagedWarehouse" s SET "reviewStatus"='APPROVED',"warehouseId"=m.id,
          "reviewedBy"=$4,"reviewedAt"=$5::timestamp,"rejectionReason"=NULL
        FROM master m,claim c WHERE s.id=c.id AND EXISTS(SELECT 1 FROM details) RETURNING s.id
      ) SELECT (SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(m)) WHERE key=ANY($6::text[]))
          ||jsonb_build_object('WarehouseData',
            (SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(d)) WHERE key=ANY($7::text[]))) AS created
        FROM master m JOIN details d ON d."warehouseId"=m.id WHERE EXISTS(SELECT 1 FROM linked)`,
    id, JSON.stringify(data), JSON.stringify(warehouseData), reviewer.email, new Date(), readFields('Warehouse'), readFields('WarehouseData'));
    if (!rows.length) return null;
    const created = rows[0].created;
    for (const field of Prisma.dmmf.datamodel.models.find(entry => entry.name === 'Warehouse').fields) {
        const value = created[field.name];
        if (field.type === 'DateTime' && typeof value === 'string') {
            created[field.name] = new Date(value.length === 10 ? value + 'T00:00:00Z'
                : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + 'Z');
        }
    }
    return created;
}

module.exports = { atomicPromotion };

const { Prisma } = require('@prisma/client');
const q = value => '"' + value.replaceAll('"', '""') + '"';
const models = ['Warehouse', 'WarehouseData', 'StagedWarehouse', 'AuditLog', 'WarehouseProximity']
    .map(name => Prisma.dmmf.datamodel.models.find(model => model.name === name));
const enumNames = new Set(models.flatMap(model => model.fields.filter(field => field.kind === 'enum').map(field => field.type)));

// Shared by the PostgreSQL integration tests and the browser-to-API checks.
// Callers use testDatabaseUrl, which only permits the disposable local database.
async function createSchema(prisma) {
    // CREATE deliberately fails if a fixture table already exists.
    for (const name of enumNames) {
        const definition = Prisma.dmmf.datamodel.enums.find(entry => entry.name === name);
        await prisma.$executeRawUnsafe(`CREATE TYPE ${q(name)} AS ENUM (${definition.values.map(value => `'${value.name}'`).join(',')})`);
    }
    for (const model of models) {
        const columns = model.fields.filter(field => ['scalar', 'enum'].includes(field.kind)
            && field.name !== 'availabilityLastReviewedOn').map(field => {
            if (field.isId) return `${q(field.name)} ${field.type === 'Int' ? 'serial' : 'text'} PRIMARY KEY`;
            const type = field.kind === 'enum' ? q(field.type) : ({ String: 'text', Int: 'integer', Float: 'double precision',
                Boolean: 'boolean', DateTime: 'timestamp(3)', Json: 'jsonb', BigInt: 'bigint', Decimal: 'numeric' })[field.type];
            if (!type) return null;
            let fallback = '';
            if (field.isList) fallback = " DEFAULT '{}'";
            else if (field.kind === 'enum' && typeof field.default === 'string') fallback = ` DEFAULT '${field.default}'`;
            else if (field.isRequired) fallback = ({ String: " DEFAULT ''", Int: ' DEFAULT 0', Float: ' DEFAULT 0',
                Boolean: ' DEFAULT false', DateTime: ' DEFAULT CURRENT_TIMESTAMP', Json: " DEFAULT '[]'" })[field.type] || '';
            return `${q(field.dbName || field.name)} ${type}${field.isList ? '[]' : ''}${fallback}`;
        }).filter(Boolean);
        await prisma.$executeRawUnsafe(`CREATE TABLE ${q(model.dbName || model.name)} (${columns.join(',')})`);
    }
}

async function dropSchema(prisma) {
    for (const model of [...models].reverse()) await prisma.$executeRawUnsafe(`DROP TABLE ${q(model.dbName || model.name)}`);
    for (const name of enumNames) await prisma.$executeRawUnsafe(`DROP TYPE ${q(name)}`);
}

module.exports = { createSchema, dropSchema };

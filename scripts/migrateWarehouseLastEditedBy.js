// Inspect by default; --apply adds only the two nullable attribution columns.
const fs = require('node:fs');
const path = require('node:path');

async function inspect(prisma) {
    const rows = await prisma.$queryRaw`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('Warehouse', 'StagedWarehouse')
          AND column_name IN ('id', 'lastEditedBy')
    `;
    return ['Warehouse', 'StagedWarehouse'].map(table => {
        if (!rows.some(row => row.table_name === table && row.column_name === 'id')) {
            throw new Error(`Missing expected ${table} table`);
        }
        const column = rows.find(row => row.table_name === table && row.column_name === 'lastEditedBy');
        if (column && (column.data_type !== 'text' || column.is_nullable !== 'YES' || column.column_default !== null)) {
            throw new Error(`Unexpected definition for ${table}.lastEditedBy; expected nullable text without a default`);
        }
        return { table, column: 'lastEditedBy', exists: Boolean(column) };
    });
}

async function migrate(prisma, apply = false) {
    const before = await inspect(prisma);
    if (!apply) return { mode: 'dry-run', columns: before };
    const statements = fs.readFileSync(path.join(__dirname, 'sql/warehouseLastEditedBy.sql'), 'utf8')
        .split('-- statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
    await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'"),
        ...statements.map(sql => prisma.$executeRawUnsafe(sql)),
    ]);
    const columns = await inspect(prisma);
    if (columns.some(column => !column.exists)) throw new Error('Last editor column verification failed');
    return { mode: 'apply', addedTo: before.filter(column => !column.exists).map(column => column.table), columns };
}

module.exports = { migrate };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--apply')) {
        console.error('Usage: node scripts/migrateWarehouseLastEditedBy.js [--apply]');
        process.exitCode = 1;
    } else {
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        migrate(prisma, process.argv.includes('--apply'))
            .then(report => console.log(JSON.stringify(report, null, 2)))
            .catch(error => {
                // Do not print connection strings from Prisma errors.
                console.error('Last editor migration failed', {
                    name: error.name,
                    code: error.code || error.errorCode,
                    ...(error.name === 'Error' ? { message: error.message } : {}),
                });
                process.exitCode = 1;
            })
            .finally(() => prisma.$disconnect());
    }
}

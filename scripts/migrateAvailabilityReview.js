// Inspect by default; --apply adds only the two nullable availability review date columns.
const fs = require('node:fs');
const path = require('node:path');

const tables = ['Warehouse', 'StagedWarehouse'];
const sqlPath = path.join(__dirname, 'sql/availabilityReview.sql');

async function inspect(prisma) {
    const rows = await prisma.$queryRaw`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('Warehouse', 'StagedWarehouse')
          AND column_name IN ('id', 'availabilityLastReviewedOn')
        ORDER BY table_name, column_name
    `;
    return tables.map(table => {
        if (!rows.some(row => row.table_name === table && row.column_name === 'id')) {
            throw new Error(`Missing expected public.${table} table`);
        }
        const column = rows.find(row => row.table_name === table && row.column_name === 'availabilityLastReviewedOn');
        if (column && (column.data_type !== 'date' || column.is_nullable !== 'YES' || column.column_default !== null)) {
            throw new Error(`Unexpected definition for ${table}.availabilityLastReviewedOn; expected nullable date without a default`);
        }
        return { table, column: 'availabilityLastReviewedOn', exists: Boolean(column), type: 'date', nullable: true };
    });
}

async function migrate(prisma, apply = false) {
    const before = await inspect(prisma);
    if (!apply) return { mode: 'dry-run', columns: before };
    const statements = fs.readFileSync(sqlPath, 'utf8')
        .split('-- statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
    // Array transactions work with the pooler; do not use an interactive transaction.
    await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'"),
        ...statements.map(sql => prisma.$executeRawUnsafe(sql)),
    ]);
    const after = await inspect(prisma);
    if (after.some(column => !column.exists)) throw new Error('Availability review date column verification failed');
    return { mode: 'apply', addedTo: before.filter(column => !column.exists).map(column => column.table), columns: after };
}

module.exports = { migrate };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--apply')) {
        console.error('Usage: node scripts/migrateAvailabilityReview.js [--apply]');
        process.exitCode = 1;
    } else {
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        migrate(prisma, process.argv.includes('--apply'))
            .then(report => console.log(JSON.stringify(report, null, 2)))
            .catch(error => {
                // Prisma connection errors can contain infrastructure details.
                const message = String(error.message || '');
                const reason = /max.?clients|too many (?:clients|connections)|connection slots/i.test(message)
                    ? 'Database connection capacity reached'
                    : /can.t reach database|connection.*(?:closed|refused)|timed? ?out|timeout|ECONN|ETIMEDOUT/i.test(message)
                        ? 'Database connection unavailable or timed out'
                        : /authentication|password|P1000/i.test(message)
                            ? 'Database authentication failed'
                            : /query engine|schema engine|could not locate/i.test(message)
                                ? 'Prisma engine unavailable'
                                : undefined;
                console.error('Warehouse availability review date migration failed', {
                    name: error.name,
                    code: error.code || error.errorCode,
                    reason,
                    ...(error.name === 'Error' ? { message: error.message } : {}),
                });
                process.exitCode = 1;
            })
            .finally(() => prisma.$disconnect());
    }
}

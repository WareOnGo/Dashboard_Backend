// Inspect by default. --apply adds one default-false roster capability only.
const fs = require('node:fs');
const path = require('node:path');

async function inspect(prisma) {
    const rows = await prisma.$queryRaw`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'VerifiedNumber'
          AND column_name IN ('id', 'analystAccess')
    `;
    if (!rows.some(row => row.column_name === 'id' && row.data_type === 'integer')) {
        throw new Error('Expected employee roster table is unavailable');
    }
    const column = rows.find(row => row.column_name === 'analystAccess');
    if (column && (column.data_type !== 'boolean' || column.is_nullable !== 'NO' || column.column_default !== 'false')) {
        throw new Error('Existing Analyst column has an incompatible definition');
    }
    return { exists: Boolean(column), column: 'analystAccess', type: 'boolean', default: false };
}

async function migrate(prisma, apply = false) {
    const before = await inspect(prisma);
    if (!apply) return { mode: 'dry-run', ...before };
    if (!before.exists) {
        // Fixed local SQL only. Array transactions work with the transaction pooler.
        const sql = fs.readFileSync(path.join(__dirname, 'sql/analystAccess.sql'), 'utf8');
        await prisma.$transaction([
            prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
            prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'"),
            prisma.$executeRawUnsafe(sql),
        ]);
    }
    const after = await inspect(prisma);
    if (!after.exists) throw new Error('Analyst column verification failed');
    return { mode: 'apply', added: !before.exists, ...after };
}
module.exports = { migrate };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--apply')) {
        console.error('Usage: node scripts/migrateAnalystAccess.js [--apply]');
        process.exitCode = 1;
    } else {
        const { PrismaClient } = require('@prisma/client');
        const prisma = new PrismaClient();
        migrate(prisma, process.argv.includes('--apply'))
            .then(report => console.log(JSON.stringify(report)))
            .catch(() => { console.error('Analyst access migration failed; no credentials or roster data were logged.'); process.exitCode = 1; })
            .finally(() => prisma.$disconnect());
    }
}

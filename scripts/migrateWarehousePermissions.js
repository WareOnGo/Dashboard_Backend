// Additive, rerunnable rollout. Existing employees retain all four grants;
// new employees default to View all + Edit own, including their prerequisites.
const path = require('node:path');
const { WAREHOUSE_PERMISSION_COLUMNS, NEW_EMPLOYEE_WAREHOUSE_PERMISSIONS } = require('../src/utils/warehousePermissions');

async function migrate(prisma, apply = false) {
    const columns = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'VerifiedNumber'
    `;
    if (!columns.length) throw new Error('VerifiedNumber must exist before migrating warehouse permissions.');
    const existing = new Set(columns.map(row => row.column_name));
    const [{ count }] = await prisma.$queryRaw`SELECT count(*)::int AS count FROM "VerifiedNumber"`;
    if (apply) {
        await prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'");
            for (const column of WAREHOUSE_PERMISSION_COLUMNS) {
                // The identifiers come exclusively from the constant allowlist.
                // ADD's true default backfills only a newly added column. A retry
                // never turns a permission back on after an admin has revoked it.
                await tx.$executeRawUnsafe(`ALTER TABLE "VerifiedNumber" ADD COLUMN IF NOT EXISTS "${column}" boolean NOT NULL DEFAULT true`);
            }
            // ALTER DEFAULT changes future inserts only, including when this is
            // rerun after the original default-off rollout. No existing row changes.
            for (const [column, enabled] of Object.entries(NEW_EMPLOYEE_WAREHOUSE_PERMISSIONS)) {
                await tx.$executeRawUnsafe(`ALTER TABLE "VerifiedNumber" ALTER COLUMN "${column}" SET DEFAULT ${enabled ? 'true' : 'false'}`);
            }
        }, { timeout: 40000 });
    }
    return {
        mode: apply ? 'apply' : 'dry-run',
        employees: count,
        columns: WAREHOUSE_PERMISSION_COLUMNS.map(name => ({ name, existed: existing.has(name) })),
        newEmployeeDefaults: NEW_EMPLOYEE_WAREHOUSE_PERMISSIONS,
        note: 'New columns are enabled for every existing employee, including inactive employees. Existing values are never regranted or changed. New employees default to Dashboard, View own, Edit own and View all; Edit all stays off. Active-account gates still apply.',
    };
}

module.exports = { migrate };
if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/migrateWarehousePermissions.js [--apply]');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    migrate(prisma, process.argv.includes('--apply'))
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error('Warehouse permission migration failed', { name: error.name, code: error.code });
            process.exitCode = 1;
        })
        .finally(() => prisma.$disconnect());
}

// Upgrade an existing review installation without rewriting data or triggers.
// Inspect by default; --apply changes the status constraint and partial index.
const fs = require('node:fs');
const path = require('node:path');
async function inspect(db) {
  const [state] = await db.$queryRaw`SELECT
    to_regclass('"WarehouseFieldFlag"') IS NOT NULL AS installed,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('"WarehouseFieldFlag"')
      AND conname = 'WarehouseFieldFlag_status_check' AND pg_get_constraintdef(oid) LIKE '%CANCELLED%') AS status_ready,
    EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('field_review_one_active_field')
      AND indisvalid AND indisunique AND pg_get_expr(indpred,indrelid) LIKE '%CANCELLED%') AS index_ready`;
  return state;
}
async function migrate(db, apply = false) {
  const before = await inspect(db);
  if (!before.installed) throw new Error('Install field review before enabling cancellation.');
  if (!apply) return { mode: 'dry-run', ...before };
  const after = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    await tx.$executeRawUnsafe(fs.readFileSync(path.join(__dirname, 'sql/fieldReviewCancellation.sql'), 'utf8'));
    const state = await inspect(tx);
    if (!state.status_ready || !state.index_ready) throw new Error('Cancellation constraint verification failed.');
    return state;
  }, { timeout: 45000 });
  return { mode: 'apply', changed: !before.status_ready || !before.index_ready, ...after };
}
module.exports = { migrate };
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/migrateFieldReviewCancellation.js [--apply]');
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  migrate(db, process.argv.includes('--apply')).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error('Cancellation migration failed', { name: error.name, code: error.code }); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}

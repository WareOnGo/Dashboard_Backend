// Explicit migration; importing the application never creates tables.
const fs = require('node:fs');
const path = require('node:path');
const tables = [
  'WarehouseQaRun',
  'WarehouseQaItem',
  'WarehouseQaEvent',
  'WarehouseQaCache',
  'WarehouseQaCursor'
];
async function migrate(db, apply = false) {
  const inspect = (tx) => tx.$queryRaw`SELECT c.relname AS name, c.relrowsecurity AS rls,
    (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity)) AS backend_access,
    (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
      AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) AS backend_privileges,
    EXISTS(SELECT 1 FROM pg_roles api WHERE api.rolname IN ('anon','authenticated','service_role')
      AND has_table_privilege(api.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS api_access,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0) AS public_access
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user
    WHERE n.nspname=current_schema() AND c.relname IN ('WarehouseQaRun','WarehouseQaItem','WarehouseQaEvent','WarehouseQaCache','WarehouseQaCursor')`;
  if (!apply) return { mode: 'dry-run', tables, security: await inspect(db), warehouse_changes: false };
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
      for (const sql of fs
        .readFileSync(path.join(__dirname, 'sql/warehouseQa.sql'), 'utf8')
        .split('-- statement-breakpoint'))
        if (sql.trim()) await tx.$executeRawUnsafe(sql);
      const security = await inspect(tx);
      if (
        security.length !== 5 ||
        security.some(
          (s) => !s.rls || !s.backend_access || !s.backend_privileges || s.api_access || s.public_access
        )
      )
        throw new Error('QA database permissions verification failed');
      return { mode: 'apply', security, warehouse_changes: false };
    },
    { timeout: 45000 }
  );
}
module.exports = { migrate };
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  if (process.argv.slice(2).some((a) => a !== '--apply'))
    throw new Error('Usage: node scripts/migrateWarehouseQa.js [--apply]');
  // An explicit QA URL is required: never silently migrate the main database.
  if (!process.env.AI_QA_DATABASE_URL)
    throw new Error('Set AI_QA_DATABASE_URL explicitly for this migration');
  const db = new (require('@prisma/client').PrismaClient)({
    datasourceUrl: process.env.AI_QA_DATABASE_URL,
    log: []
  });
  migrate(db, process.argv.includes('--apply'))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('QA migration failed', { code: e.code, name: e.name });
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}

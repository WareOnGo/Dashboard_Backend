// Explicit --apply only. No startup migration and no warehouse data rewrite.
const fs = require('node:fs');
const path = require('node:path');
const tables = ['WarehouseFieldReview', 'WarehouseFieldFlag', 'WarehouseFieldReviewEvent', 'WarehouseFieldVersion', 'WarehouseFieldEdit'];
async function security(prisma) {
  return prisma.$queryRaw`SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
    (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity)) AS server_bypasses_rls,
    (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
      AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE')) AS server_access,
    EXISTS(SELECT 1 FROM pg_roles api WHERE api.rolname IN ('anon','authenticated','service_role')
      AND has_table_privilege(api.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS api_access,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0) AS public_access
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user
    WHERE n.nspname=current_schema() AND c.relname IN
      ('WarehouseFieldReview','WarehouseFieldFlag','WarehouseFieldReviewEvent','WarehouseFieldVersion','WarehouseFieldEdit')`;
}
async function migrate(prisma, apply = false) {
  const found = await prisma.$queryRawUnsafe('SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()');
  const existing = new Set(found.map(x => x.table_name));
  if (!existing.has('Warehouse') || !existing.has('WarehouseData')) throw new Error('Warehouse and WarehouseData must exist');
  let access;
  if (apply) {
    const statements = ['fieldReview.sql', 'fieldReviewCancellation.sql'].flatMap(file =>
      fs.readFileSync(path.join(__dirname, 'sql', file), 'utf8').split('-- statement-breakpoint').filter(s => s.trim()));
    access = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      const checked = await security(tx);
      // Verification is part of the DDL transaction: a rejected configuration
      // must not leave tracking hooks or permission changes installed.
      if (checked.length !== tables.length || checked.some(row => !row.rls_enabled
        || !row.server_bypasses_rls || !row.server_access || row.api_access || row.public_access)) {
        throw new Error('Field-review database protections or backend access verification failed');
      }
      return checked;
    }, { timeout: 45000 });
  } else access = await security(prisma);
  return {
    mode: apply ? 'apply' : 'dry-run',
    tables: tables.map(name => ({
      name,
      existed: existing.has(name)
    })),
    triggers: ['Warehouse', 'WarehouseData'],
    security: access,
    note: 'Versions/history begin at installation; earlier edit history is not fabricated.'
  };
}
module.exports = {
  migrate
};
if (require.main === module) {
  require('dotenv').config({
    path: path.resolve(__dirname, '../.env'),
    quiet: true
  });
  if (process.argv.slice(2).some(a => a !== '--apply')) throw new Error('Usage: node scripts/migrateFieldReview.js [--apply]');
  const {
    PrismaClient
  } = require('@prisma/client');
  const prisma = new PrismaClient();
  migrate(prisma, process.argv.includes('--apply')).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error('Field review migration failed', {
      name: e.name,
      code: e.code
    });
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}

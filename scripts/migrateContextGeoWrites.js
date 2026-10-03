// Inspect by default. Apply this feature's additive DDL only with --apply.
const fs = require('node:fs');
const path = require('node:path');
const expected = {
    ContextGeoWrite: { issuer: 'text', employeeId: 'integer', operationId: 'uuid', bodyHash: 'text',
        pointId: 'text', result: 'jsonb', createdAt: 'timestamp with time zone' },
    ContextGeoNonce: { hash: 'text', expiresAt: 'timestamp with time zone' },
};
async function inspect(prisma) {
    const columns = await prisma.$queryRaw`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('ContextGeoWrite','ContextGeoNonce') ORDER BY table_name,ordinal_position`;
    for (const [table, fields] of Object.entries(expected)) {
        const existing = columns.filter(row => row.table_name === table);
        if (!existing.length) continue;
        if (existing.length !== Object.keys(fields).length || existing.some(row => fields[row.column_name] !== row.data_type || row.is_nullable !== 'NO')) {
            throw new Error('UNEXPECTED_CONTEXT_GEO_SCHEMA');
        }
    }
    const security = await prisma.$queryRaw`SELECT c.relname,c.relrowsecurity AS rls_enabled,
        (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity)) AS server_bypasses_rls,
        (has_table_privilege(c.oid,'SELECT') AND has_table_privilege(c.oid,'INSERT')
            AND has_table_privilege(c.oid,'DELETE')) AS server_access,
        EXISTS(SELECT 1 FROM pg_roles api WHERE api.rolname IN ('anon','authenticated','service_role')
            AND has_table_privilege(api.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS api_access,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0) AS public_access
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.rolname=current_user
        WHERE n.nspname='public' AND c.relname IN ('ContextGeoWrite','ContextGeoNonce')`;
    const indexes = await prisma.$queryRaw`SELECT tablename,indexname,indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename IN ('ContextGeoWrite','ContextGeoNonce') ORDER BY indexname`;
    const primaryKeys = await prisma.$queryRaw`SELECT c.relname,pg_get_constraintdef(p.oid) AS definition
        FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('ContextGeoWrite','ContextGeoNonce') AND p.contype='p'`;
    const keys = { ContextGeoWrite: 'PRIMARY KEY (issuer, "employeeId", "operationId")', ContextGeoNonce: 'PRIMARY KEY (hash)' };
    for (const table of Object.keys(expected)) {
        if (columns.some(row => row.table_name === table) && !primaryKeys.some(row => row.relname === table && row.definition === keys[table])) {
            throw new Error('UNEXPECTED_CONTEXT_GEO_PRIMARY_KEY');
        }
    }
    return { columns, security, indexes };
}
async function migrate(prisma, apply = false) {
    const before = await inspect(prisma);
    if (!apply) return { mode: 'inspect', ...before };
    const statements = fs.readFileSync(path.join(__dirname, 'sql/contextGeoWrites.sql'), 'utf8')
        .split('-- statement-breakpoint').map(value => value.trim()).filter(Boolean);
    await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout='3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout='20s'"),
        ...statements.map(sql => prisma.$executeRawUnsafe(sql)),
    ]);
    const after = await inspect(prisma);
    if (after.columns.length !== 9 || after.security.length !== 2
        || after.security.some(row => !row.rls_enabled || !row.server_bypasses_rls || !row.server_access || row.api_access || row.public_access)
        || !after.indexes.some(row => row.indexname === 'ContextGeoNonce_expiresAt_idx')) throw new Error('CONTEXT_GEO_SCHEMA_VERIFICATION_FAILED');
    return { mode: 'applied', ...after };
}
module.exports = { migrate };
if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    migrate(prisma, process.argv.includes('--apply')).then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(() => { console.error('CONTEXT_GEO_MIGRATION_FAILED'); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}

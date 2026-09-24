// Additive schema migration. Dry-run unless --apply; never runs Prisma db push.
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const root = path.resolve(__dirname, '..');
const sqlFiles = ['imageCompressionMetadata.sql', 'imagePipeline.sql', 'imageJpegVariant.sql'];

async function snapshot(tx, table, keys) {
    const metadata = await tx.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, table);
    const columns = keys || metadata.map(row => row.column_name);
    const addedColumns = metadata.map(row => row.column_name).filter(key => !columns.includes(key));
    // Hash inside PostgreSQL: preserve exact JSONB values (including large
    // integers) without transferring both full tables twice while holding locks.
    const [result] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(md5((to_jsonb(t) - ARRAY(
        SELECT jsonb_array_elements_text($1::jsonb)))::text), '' ORDER BY id), '')) AS digest
      FROM public."${table}" t`, JSON.stringify(addedColumns));
    return { ...result, columns };
}

async function migrate(prisma, apply = false, files = sqlFiles) {
    if (!files.length || files.some(file => !sqlFiles.includes(file))) throw new Error('Invalid migration files');
    const statements = files.flatMap(file => fs.readFileSync(path.join(root, 'scripts/sql', file), 'utf8')
        .split('-- statement-breakpoint').map(sql => sql.trim()).filter(Boolean));
    if (!apply) return { mode: 'dry-run', files, statements: statements.length };
    return prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
        // A short, stable snapshot proves every old column survived unchanged.
        await tx.$executeRawUnsafe('LOCK TABLE public."Warehouse" IN SHARE MODE');
        await tx.$executeRawUnsafe('LOCK TABLE public.labeled_warehouse_images IN SHARE ROW EXCLUSIVE MODE');
        const warehousesBefore = await snapshot(tx, 'Warehouse');
        const imagesBefore = await snapshot(tx, 'labeled_warehouse_images');
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
        const warehousesAfter = await snapshot(tx, 'Warehouse', warehousesBefore.columns);
        const imagesAfter = await snapshot(tx, 'labeled_warehouse_images', imagesBefore.columns);
        if (warehousesBefore.digest !== warehousesAfter.digest || warehousesBefore.count !== warehousesAfter.count
            || imagesBefore.digest !== imagesAfter.digest || imagesBefore.count !== imagesAfter.count) {
            throw new Error('Preservation check failed; transaction rolled back');
        }
        return { mode: 'apply', files, warehouses: warehousesAfter.count, imageRows: imagesAfter.count,
            warehouseDigest: warehousesAfter.digest, imageDigest: imagesAfter.digest,
            oldColumnsPreserved: true, mediaPreserved: true };
    }, { maxWait: 10000, timeout: 60000 });
}

module.exports = { migrate };
if (require.main === module) {
    require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/migrateImagePipeline.js [--apply]');
    const prisma = new PrismaClient();
    migrate(prisma, args.includes('--apply')).then(report => {
        const directory = path.join(root, 'tools/image-pipeline');
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-schema.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ ...report, report: file }));
    }).catch(error => { console.error('Image migration failed', { code: error.code, name: error.name }); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}

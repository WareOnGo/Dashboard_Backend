// Remove only the unused JPEG variant fields. Preview unless --apply is given.
const fs = require('node:fs');
const path = require('node:path');
const { snapshot } = require('./migrateImagePipeline');

const JPEG_FIELDS = ['jpegUrl', 'jpegBytes', 'jpegAt', 'jpegVersion', 'jpegStatus', 'jpegError'];

async function dropUnusedJpeg(prisma, apply = false) {
    return prisma.$transaction(async tx => {
        if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'");
        if (apply) {
            // Match the existing migration's lock order. Block writes only while
            // checking preservation and dropping the six explicitly named fields.
            await tx.$executeRawUnsafe('LOCK TABLE public."Warehouse" IN SHARE MODE');
            await tx.$executeRawUnsafe('LOCK TABLE public.labeled_warehouse_images IN ACCESS EXCLUSIVE MODE');
        }
        const columns = (await tx.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'labeled_warehouse_images' ORDER BY column_name`))
            .map(row => row.column_name);
        if (!columns.length) throw new Error('Image table does not exist');
        const present = JPEG_FIELDS.filter(field => columns.includes(field));
        const predicates = present.map(field => field === 'jpegStatus'
            ? `("jpegStatus" IS NOT NULL AND "jpegStatus" <> 'PENDING')`
            : `"${field}" IS NOT NULL`);
        const [{ populatedRows }] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS "populatedRows"
          FROM public.labeled_warehouse_images WHERE ${predicates.join(' OR ') || 'FALSE'}`);
        if (!apply) return { mode: 'dry-run', columnsToDrop: present, populatedRows };
        if (populatedRows) throw new Error(`Refusing to drop JPEG columns: ${populatedRows} row(s) contain JPEG data`);

        const remaining = columns.filter(field => !JPEG_FIELDS.includes(field));
        const warehousesBefore = await snapshot(tx, 'Warehouse');
        const imagesBefore = await snapshot(tx, 'labeled_warehouse_images', remaining);
        if (present.length) {
            // No CASCADE: an unexpected external dependency must stop the change.
            await tx.$executeRawUnsafe(`ALTER TABLE public.labeled_warehouse_images
              ${present.map(field => `DROP COLUMN "${field}"`).join(', ')}`);
        }
        const warehousesAfter = await snapshot(tx, 'Warehouse', warehousesBefore.columns);
        const imagesAfter = await snapshot(tx, 'labeled_warehouse_images', remaining);
        if (warehousesBefore.digest !== warehousesAfter.digest || warehousesBefore.count !== warehousesAfter.count
            || imagesBefore.digest !== imagesAfter.digest || imagesBefore.count !== imagesAfter.count) {
            throw new Error('Preservation check failed; transaction rolled back');
        }
        return { mode: 'apply', removedColumns: present, populatedRows,
            warehouses: warehousesAfter.count, imageRows: imagesAfter.count,
            warehouseDigest: warehousesAfter.digest, imageDigest: imagesAfter.digest,
            remainingImageValuesPreserved: true, warehouseValuesPreserved: true, mediaPreserved: true };
    }, { maxWait: 10000, timeout: 60000 });
}

module.exports = { dropUnusedJpeg, JPEG_FIELDS };
if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/dropUnusedImageJpeg.js [--apply]');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    dropUnusedJpeg(prisma, args.includes('--apply')).then(report => {
        const directory = path.resolve(__dirname, '../tools/image-pipeline');
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-drop-jpeg-schema.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ ...report, report: file }));
    }).catch(error => {
        console.error('JPEG cleanup failed', { code: error.code, name: error.name,
            reason: error.message?.startsWith('Refusing to drop JPEG') ? error.message : undefined });
        process.exitCode = 1;
    }).finally(() => prisma.$disconnect());
}

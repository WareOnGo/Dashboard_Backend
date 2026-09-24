// Read-only schema/data audit. Prints counts, never source URLs or credentials.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function audit() {
    const [summary] = await prisma.$queryRawUnsafe(`WITH referenced AS (
      SELECT DISTINCT unnest(public.wareongo_image_urls(media::jsonb, photos)) AS url FROM "Warehouse"
    ) SELECT
      (SELECT count(*)::int FROM "Warehouse") AS warehouses,
      (SELECT count(*)::int FROM labeled_warehouse_images) AS "imageRows",
      (SELECT count(*)::int FROM referenced) AS "referencedOriginals",
      (SELECT count(*)::int FROM referenced r LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = r.url WHERE l.id IS NULL) AS unregistered,
      (SELECT count(*)::int FROM labeled_warehouse_images WHERE classification IS NULL) AS "pendingLabels",
      (SELECT count(*)::int FROM labeled_warehouse_images WHERE "compressedImageUrl" IS NOT NULL
        AND "webpVersion" IS NULL AND "compressedImageUrl" IS DISTINCT FROM "webpUrl") AS "importMismatches"`);
    const webp = await prisma.$queryRawUnsafe('SELECT "webpStatus" AS status, count(*)::int AS count FROM labeled_warehouse_images GROUP BY "webpStatus" ORDER BY "webpStatus"');
    console.log(JSON.stringify({ ...summary, webp, readOnly: true }));
}
audit().catch(error => { console.error('Image audit failed', { code: error.code, name: error.name }); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());

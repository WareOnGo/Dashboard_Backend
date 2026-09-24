// Read-only verification of stored variants and completed backfill reports.
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
sharp.cache(false); sharp.concurrency(1);
const prisma = new PrismaClient();

function evenlySpaced(values, limit) {
    if (values.length <= limit) return values;
    return Array.from({ length: limit }, (_, i) => values[Math.round(i * (values.length - 1) / (limit - 1))]);
}

async function main() {
    const day = process.argv[2];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('report_day_required');
    const directory = path.resolve(__dirname, '../tools/image-pipeline');
    const files = (await fs.readdir(directory)).filter(file => file.startsWith(`${day}T`) && file.endsWith('-webp-apply.json')).sort();
    assert.ok(files.length, 'No backfill reports');
    const reports = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))));
    for (const report of reports) {
        assert.ok(report.finishedAt && !report.fatal, 'A backfill run has not finished');
        assert.deepEqual(report.verification.mismatches, []);
        assert.equal(report.verification.checked, report.updated);
        assert.deepEqual(report.preservation.images.changed, []);
        assert.deepEqual(report.preservation.images.removed, []);
        assert.deepEqual(report.preservation.warehouses.changed, []);
        assert.deepEqual(report.preservation.warehouses.removed, []);
    }
    const site = process.env.IMAGE_PIPELINE_WEBSITE_ROOT ?? path.resolve(__dirname, '../../../website_combined/WareOnGo-Website-Backend');
    const { compressionConfig, createPhotoStore } = await import(pathToFileURL(path.join(site, 'services/webpCompression.js')));
    const store = createPhotoStore(compressionConfig());
    const signal = AbortSignal.timeout(240000);
    const existing = await store.existingKeys(signal);
    const rows = await prisma.$queryRawUnsafe(`SELECT id, "imageUrl", "webpUrl", "webpObjectKey",
      "webpBytes"::text AS bytes, "webpStatus" AS status FROM labeled_warehouse_images ORDER BY id`);
    const byId = new Map(rows.map(row => [row.id, row]));
    const completed = new Map(reports.flatMap(report => report.results.filter(row => row.updated)).map(row => [row.imageId, row]));
    for (const id of completed.keys()) assert.equal(byId.get(id)?.status, 'READY', `Completed image ${id} is not READY`);
    const missing = rows.filter(row => row.status === 'READY' && !existing.has(row.webpObjectKey)).map(row => row.id);
    assert.deepEqual(missing, [], 'A READY row has no nonempty object in R2');
    const uploaded = [...completed.values()].filter(row => row.uploaded).map(row => row.imageId).sort((a, b) => a - b);
    const reused = [...completed.values()].filter(row => row.reused).map(row => row.imageId).sort((a, b) => a - b);
    const sample = [...new Set([...evenlySpaced(uploaded, 15), ...evenlySpaced(reused, 5),
        ...reports.flatMap(report => report.recoveryImageIds ?? [])])];
    const decoded = [];
    for (const id of sample) {
        const row = byId.get(id);
        assert.equal(new URL(row.webpUrl).origin, store.publicBase);
        assert.equal(new URL(row.imageUrl).origin, store.publicBase);
        const response = await fetch(row.webpUrl, { signal, redirect: 'error' });
        assert.equal(response.status, 200, `WebP HTTP response for ${id}`);
        assert.ok(/^image\/webp(?:;|$)/i.test(response.headers.get('content-type') ?? ''), `WebP MIME type for ${id}`);
        assert.ok(Number(response.headers.get('content-length')) <= 20 * 1024 * 1024);
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
            bytes += chunk.length;
            assert.ok(bytes <= 20 * 1024 * 1024);
            chunks.push(chunk);
        }
        assert.equal(String(bytes), row.bytes, `WebP byte size for ${id}`);
        const body = Buffer.concat(chunks);
        const metadata = await sharp(body, { limitInputPixels: 16000000 }).metadata();
        assert.equal(metadata.format, 'webp');
        if (completed.get(id)?.uploaded) assert.ok(metadata.width <= 1280 && metadata.height <= 1280);
        await sharp(body, { limitInputPixels: 16000000 }).stats();
        const original = await fetch(row.imageUrl, { method: 'HEAD', signal, redirect: 'error' });
        assert.equal(original.status, 200, `Original still accessible for ${id}`);
        decoded.push({ imageId: id, format: metadata.format, width: metadata.width, height: metadata.height,
            bytes, originalAccessible: true });
    }
    const [coverage] = await prisma.$queryRawUnsafe(`WITH refs AS (
        SELECT DISTINCT unnest(public.wareongo_image_urls(media::jsonb, photos)) AS url FROM "Warehouse"
      ) SELECT (SELECT count(*)::int FROM "Warehouse") AS warehouses,
        (SELECT count(*)::int FROM labeled_warehouse_images) AS "imageRows",
        (SELECT count(*)::int FROM refs) AS "referencedOriginals",
        (SELECT count(*)::int FROM refs r LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = r.url WHERE l.id IS NULL) AS unregistered,
        (SELECT count(*)::int FROM labeled_warehouse_images WHERE classification IS NULL) AS "pendingLabels"`);
    const statuses = await prisma.$queryRawUnsafe(`SELECT "webpStatus" AS status, count(*)::int AS count
      FROM labeled_warehouse_images GROUP BY "webpStatus" ORDER BY "webpStatus"`);
    const summary = { verifiedAt: new Date().toISOString(), readOnly: true, backfillReports: files,
        inventoryScope: 'Fresh final inventory; supersedes earlier worker inventories taken before concurrent uploads.',
        filled: completed.size, uploaded: uploaded.length, reused: reused.length,
        uploadedBytes: reports.reduce((sum, report) => sum + report.bytes, 0),
        storedResultsChecked: reports.reduce((sum, report) => sum + report.verification.checked, 0),
        originalsLabelsCaptionsAndExistingWarehouseDataPreserved: true,
        ...coverage, statuses, readyObjectsMissing: missing, samplesDecoded: decoded.length, decoded };
    const reportPath = path.join(directory, `${summary.verifiedAt.replace(/[:.]/g, '-')}-webp-verification.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    const { decoded: _decoded, backfillReports: _reports, ...log } = summary;
    console.log(JSON.stringify({ ...log, reportPath }));
}
main().catch(error => { console.error('WebP verification failed', { name: error.name, code: error.code,
    assertion: error.name === 'AssertionError' ? error.message : undefined }); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());

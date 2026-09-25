// Explicitly bounded trial; never scans or compresses the full catalogue.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { performance } = require('node:perf_hooks');
const { JPEG_VERSION, sha, parsePilotArgs, downloadImage, compressJpeg, jpegTarget, publishJpeg } = require('./lib/jpegPilot');

async function runPilot(prisma, { ids, apply }, { publicBase, bucket, s3, PutObjectCommand }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 4
        || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Pilot requires 1–4 warehouse IDs');
    // The API membership function respects explicit empty media and legacy photos.
    const rows = await prisma.$queryRawUnsafe(`SELECT l.id,l."imageUrl",l.classification::text AS classification,
      l."documentKind"::text AS "documentKind",l."webpUrl",l."jpegUrl",l."jpegVersion",l."jpegStatus",
      array_agg(DISTINCT w.id ORDER BY w.id) AS "warehouseIds"
      FROM "Warehouse" w CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb,w.photos)) u(url)
      LEFT JOIN labeled_warehouse_images l ON l."imageUrl"=u.url
      WHERE w.id IN (SELECT jsonb_array_elements_text($1::jsonb)::int)
      GROUP BY l.id ORDER BY l.id`, JSON.stringify(ids));
    if (!rows.length || rows.length > 100 || rows.some(row => !row.id)) {
        throw new Error('Pilot requires 1–100 registered images; no writes made');
    }
    if (ids.some(id => !rows.some(row => row.warehouseIds.includes(id)))) {
        throw new Error('A selected warehouse is missing or has no images; no writes made');
    }
    const byWarehouse = ids.map(id => ({ id, images: rows.filter(row => row.warehouseIds.includes(id)).length }));
    const startedAt = new Date().toISOString();
    const report = { startedAt, mode: apply ? 'apply' : 'dry-run', ids, preset: JPEG_VERSION,
        byWarehouse, images: rows.length, fullBackfillStarted: false, results: [], failures: [] };
    if (!apply) return report;

    const directory = path.resolve(__dirname, '../tools/image-pipeline', `${startedAt.replace(/[:.]/g, '-')}-jpeg-pilot`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'report.json');
    const save = () => fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await save();
    const started = performance.now();
    // Sequential transfers make this small trial predictable and resumable.
    for (const row of rows) {
        const imageStarted = performance.now();
        let uploadedKey;
        try {
            const original = await downloadImage(row.imageUrl, publicBase);
            const originalFile = path.join(directory, `${row.id}.original`);
            const jpegFile = path.join(directory, `${row.id}.jpg`);
            await fs.writeFile(originalFile, original, { mode: 0o600 });
            let jpeg, jpegUrl, objectKey, uploaded = false, encodeMs = 0, preservation;
            if (row.jpegStatus === 'READY' && row.jpegVersion === JPEG_VERSION && row.jpegUrl) {
                jpeg = await downloadImage(row.jpegUrl, publicBase);
                if ((await sharp(jpeg).metadata()).format !== 'jpeg') throw new Error('stored_variant_is_not_jpeg');
                jpegUrl = row.jpegUrl;
            } else {
                if (row.jpegUrl) throw new Error('existing_jpeg_result_requires_review');
                const encoded = await compressJpeg(original);
                jpeg = encoded.data; encodeMs = encoded.encodeMs;
                const target = jpegTarget(row.imageUrl, original, publicBase);
                jpegUrl = target.url; objectKey = target.key;
                try {
                    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: target.key, Body: jpeg,
                        ContentType: 'image/jpeg', CacheControl: 'public,max-age=31536000,immutable',
                        IfNoneMatch: '*', Metadata: { 'original-url-sha256': sha(row.imageUrl),
                            'source-sha256': sha(original), 'jpeg-version': JPEG_VERSION } }),
                    { abortSignal: AbortSignal.timeout(30000) });
                    uploaded = true; uploadedKey = target.key;
                } catch (error) {
                    if (error.$metadata?.httpStatusCode !== 412) throw error;
                }
                // Verify bytes through the URL that the PPT will actually fetch.
                const stored = await downloadImage(jpegUrl, publicBase);
                if (sha(stored) !== sha(jpeg)) throw new Error('stored_jpeg_does_not_match');
                preservation = await publishJpeg(prisma, row, ids, { url: jpegUrl, bytes: jpeg.length });
            }
            await fs.writeFile(jpegFile, jpeg, { mode: 0o600 });
            const metadata = await sharp(jpeg).metadata();
            report.results.push({ imageId: row.id, warehouseIds: row.warehouseIds,
                originalUrl: row.imageUrl, jpegUrl, webpUrl: row.webpUrl,
                classification: row.classification, documentKind: row.documentKind,
                originalBytes: original.length, jpegBytes: jpeg.length,
                jpegWidth: metadata.width, jpegHeight: metadata.height,
                originalFile, jpegFile, objectKey, uploaded, encodeMs,
                totalMs: performance.now() - imageStarted, ...preservation });
            console.log(JSON.stringify({ imageId: row.id, warehouseIds: row.warehouseIds,
                status: 'READY', originalBytes: original.length, jpegBytes: jpeg.length, uploaded }));
        } catch (error) {
            const reason = /^[a-z_0-9]+$/.test(error.message) ? error.message : (error.name || 'jpeg_pilot_failed');
            report.failures.push({ imageId: row.id, warehouseIds: row.warehouseIds, reason,
                uploadedKey, httpStatus: error.$metadata?.httpStatusCode });
            // Do not erase an existing result if a verification attempt failed.
            await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegStatus"='FAILED',"jpegError"=$2
              WHERE id=$1 AND "imageUrl"=$3 AND "jpegUrl" IS NULL`, row.id, reason, row.imageUrl);
            console.log(JSON.stringify({ imageId: row.id, status: 'FAILED', reason }));
        }
        await save();
    }
    report.finishedAt = new Date().toISOString();
    report.elapsedSeconds = (performance.now() - started) / 1000;
    report.originalBytes = report.results.reduce((sum, row) => sum + row.originalBytes, 0);
    report.jpegBytes = report.results.reduce((sum, row) => sum + row.jpegBytes, 0);
    report.newR2Bytes = report.results.reduce((sum, row) => sum + (row.uploaded ? row.jpegBytes : 0), 0);
    await save();
    return { mode: report.mode, ids, images: rows.length, ready: report.results.length,
        failed: report.failures.length, originalBytes: report.originalBytes, jpegBytes: report.jpegBytes,
        newR2Bytes: report.newR2Bytes, elapsedSeconds: report.elapsedSeconds, report: file, fullBackfillStarted: false };
}

module.exports = { runPilot };
if (require.main === module) {
    const args = parsePilotArgs(process.argv.slice(2));
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const prisma = new PrismaClient();
    const s3 = args.apply ? new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        requestChecksumCalculation: 'WHEN_REQUIRED', maxAttempts: 2 }) : null;
    sharp.cache(false); sharp.concurrency(1);
    runPilot(prisma, args, { s3, PutObjectCommand, publicBase: process.env.R2_PUBLIC_URL, bucket: process.env.R2_BUCKET_NAME })
        .then(report => { console.log(JSON.stringify(report)); if (report.failed) process.exitCode = 1; })
        .catch(error => { console.error('JPEG pilot failed', { name: error.name, code: error.code }); process.exitCode = 1; })
        .finally(async () => { await prisma.$disconnect(); s3?.destroy(); });
}

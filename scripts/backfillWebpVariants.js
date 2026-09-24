// Fill WebP columns on existing image rows before the application cutover.
// Does not register rows, relabel images, or update any Warehouse column.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { mkdir, writeFile, rename } = require('node:fs/promises');

function collisionKeys(urls, photoTarget, publicBase) {
    const owners = new Map(), collisions = new Set();
    for (const url of urls) {
        const target = photoTarget(url, publicBase);
        if (!target) continue;
        if (owners.has(target.key) && owners.get(target.key) !== url) collisions.add(target.key);
        owners.set(target.key, url);
    }
    return collisions;
}

function failureReason(error) {
    if (/^source_[a-z_0-9]+$/.test(error?.message ?? '')) return error.message;
    if (error?.name === 'TimeoutError') return 'source_timeout';
    if (error?.code === 'WEBP_MEMORY_PRESSURE') return 'webp_memory_pressure';
    return 'conversion_or_storage_failed';
}

async function runBackfill({ repository, store, compressOne, existing, collisions, signal,
    limit, report, checkpoint }) {
    while (report.scanned < limit) {
        signal.throwIfAborted();
        const [row] = await repository.claim('webp', { limit: 1 });
        if (!row) { report.passComplete = true; break; }
        report.scanned++;
        report.activeImageId = row.id;
        try {
            const result = await compressOne(row, { repository, store, existing, collisions, signal,
                onProgress: async () => {} });
            for (const [key, value] of Object.entries(result)) report[key] += value;
            report.results.push({ imageId: row.id, ...result });
        } catch (error) {
            const deferred = signal.aborted || error?.code === 'WEBP_MEMORY_PRESSURE';
            const reason = failureReason(error);
            await repository.fail('webp', row, reason, { deferred });
            report.errors.push({ imageId: row.id, reason, deferred });
            if (deferred) throw error;
            report.failed++;
        }
        delete report.activeImageId;
        await checkpoint();
    }
}

const protectedImageFields = `to_jsonb(l) - ARRAY[
  'storageBucket','originalObjectKey','webpUrl','webpObjectKey','webpBytes','webpAt',
  'webpStatus','webpError','webpCheckedAt','webpVersion','webpAttempts',
  'webpNextAttemptAt','webpClaimToken','webpLeaseUntil']`;

async function snapshot(prisma) {
    const images = await prisma.$queryRawUnsafe(`SELECT id, "imageUrl", "webpStatus", "webpObjectKey",
      "webpBytes"::text AS "webpBytes", "webpAttempts", "webpNextAttemptAt",
      md5((${protectedImageFields})::text) AS digest FROM labeled_warehouse_images l ORDER BY id`);
    const warehouses = await prisma.$queryRawUnsafe(`SELECT id, md5(to_jsonb(w)::text) AS digest,
      public.wareongo_image_urls(media::jsonb, photos) AS urls FROM "Warehouse" w ORDER BY id`);
    return { images, warehouses };
}

function differences(before, after) {
    const current = new Map(after.map(row => [row.id, row.digest]));
    return { changed: before.filter(row => current.has(row.id) && current.get(row.id) !== row.digest).map(row => row.id),
        removed: before.filter(row => !current.has(row.id)).map(row => row.id),
        added: after.length - before.filter(row => current.has(row.id)).length };
}

function inventoryCounts(data, store, existing, collisions, photoTarget, versionedTarget) {
    const referenced = new Set(data.warehouses.flatMap(row => row.urls));
    const result = { images: data.images.length, warehouses: data.warehouses.length,
        pendingReferenced: 0, pendingUnreferenced: 0, reusable: 0, needUpload: 0,
        unsupported: 0, readyObjectsMissing: 0, collisions: collisions.size, statuses: {} };
    for (const row of data.images) {
        result.statuses[row.webpStatus] = (result.statuses[row.webpStatus] ?? 0) + 1;
        if (row.webpStatus === 'READY') {
            if (!existing.has(row.webpObjectKey)) result.readyObjectsMissing++;
            continue;
        }
        if (!referenced.has(row.imageUrl)) { result.pendingUnreferenced++; continue; }
        result.pendingReferenced++;
        const legacy = photoTarget(row.imageUrl, store.publicBase);
        if (!legacy) { result.unsupported++; continue; }
        const keys = [row.webpObjectKey, versionedTarget(row, store).key, !collisions.has(legacy.key) && legacy.key];
        if (keys.some(key => key && existing.has(key))) result.reusable++;
        else result.needUpload++;
    }
    return result;
}

async function main() {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply' && !/^--limit=\d+$/.test(arg)
        && !/^--recover-jpeg-warnings=\d+(,\d+)*$/.test(arg))) throw new Error('invalid_options');
    const apply = args.includes('--apply');
    const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 10000);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid_limit');
    const recoveryIds = [...new Set(args.find(arg => arg.startsWith('--recover-jpeg-warnings='))?.split('=')[1].split(',').map(Number) ?? [])];
    if (recoveryIds.length > 100 || recoveryIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('invalid_recovery_ids');
    const websiteRoot = process.env.IMAGE_PIPELINE_WEBSITE_ROOT ??
        path.resolve(__dirname, '../../../website_combined/WareOnGo-Website-Backend');
    const { compressionConfig, createPhotoStore, photoTarget } = await import(pathToFileURL(path.join(websiteRoot, 'services/webpCompression.js')));
    const { compressOne, versionedTarget } = await import(pathToFileURL(path.join(websiteRoot, 'services/webpPipeline.js')));
    const { convertImageFile } = await import(pathToFileURL(path.join(websiteRoot, 'services/webpImageProcess.js')));
    const { ImagePipelineRepository } = require('../src/models/imagePipelineRepository.cjs');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const repository = new ImagePipelineRepository(prisma);
    const store = createPhotoStore(compressionConfig(), recoveryIds.length ? {
        convertFile: (input, output, config, signal) => convertImageFile(input, output, config, signal,
            { workerPath: path.join(__dirname, 'lib/webpJpegRecoveryWorker.cjs') }),
    } : {});
    if (recoveryIds.length) {
        // Operator-selected retry of recoverable JPEG warnings only. Keep strict
        // decoding in the regular pipeline and preserve the old encoder version.
        store.version += '-jpeg-warning-recovery';
        const remaining = [...recoveryIds];
        repository.claim = async stage => {
            if (stage !== 'webp') throw new Error('invalid_recovery_stage');
            while (remaining.length) {
                const claimed = await prisma.$queryRawUnsafe(`UPDATE labeled_warehouse_images
                  SET "webpStatus" = 'RUNNING', "webpClaimToken" = $2,
                    "webpLeaseUntil" = now() + interval '5 minutes', "webpAttempts" = "webpAttempts" + 1
                  WHERE id = $1 AND "webpStatus" = 'FAILED' AND "webpError" = 'source_conversion_failed'
                  RETURNING id, "warehouseId", "imageUrl", "webpClaimToken", "webpAttempts", "webpObjectKey", "webpVersion"`,
                remaining.shift(), randomUUID());
                if (claimed.length) return claimed;
            }
            return [];
        };
    }
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('operator_interrupted'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const started = new Date().toISOString();
    const directory = path.resolve(__dirname, '../tools/image-pipeline');
    const reportPath = path.join(directory, `${started.replace(/[:.]/g, '-')}-webp-${apply ? 'apply' : 'audit'}.json`);
    const report = { mode: apply ? 'apply' : 'read-only', startedAt: started, encoder: store.version,
        warehouseWrites: false, labelWrites: false, registration: false, scanned: 0, updated: 0,
        uploaded: 0, reused: 0, bytes: 0, failed: 0, skipped: 0, stale: 0, passComplete: false,
        results: [], errors: [] };
    if (recoveryIds.length) report.recoveryImageIds = recoveryIds;
    await mkdir(directory, { recursive: true });
    let lastCheckpoint = 0;
    const checkpoint = async (force = false) => {
        if (!force && Date.now() - lastCheckpoint < 15000) return;
        lastCheckpoint = Date.now();
        report.checkpointAt = new Date().toISOString();
        await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        await rename(`${reportPath}.tmp`, reportPath);
        const { results, errors, ...progress } = report;
        console.log(JSON.stringify({ ...progress, recentErrors: errors.slice(-3), reportPath }));
    };
    let before;
    try {
        before = await snapshot(prisma);
        const existing = await store.existingKeys(controller.signal);
        const collisions = collisionKeys([...before.images.map(row => row.imageUrl),
            ...before.warehouses.flatMap(row => row.urls)], photoTarget, store.publicBase);
        report.before = inventoryCounts(before, store, existing, collisions, photoTarget, versionedTarget);
        await checkpoint(true);
        if (apply) {
            await runBackfill({ repository, store, compressOne, existing, collisions, signal: controller.signal,
                limit, report, checkpoint });
            const after = await snapshot(prisma);
            // Another local worker may have uploaded objects since this run's
            // initial listing. Inventory again after the DB snapshot so their
            // completed variants are not misreported as missing.
            const finalInventory = await store.existingKeys(controller.signal);
            report.after = inventoryCounts(after, store, finalInventory, collisions, photoTarget, versionedTarget);
            report.preservation = { images: differences(before.images, after.images),
                warehouses: differences(before.warehouses, after.warehouses) };
            // Verify each completed row against actual storage, including exact byte size.
            // A GET/decode smoke check is separate; this is a bounded HEAD for every result.
            const completed = new Set(report.results.filter(row => row.updated).map(row => row.imageId));
            report.verification = { checked: 0, mismatches: [] };
            for (const row of after.images) {
                if (!completed.has(row.id)) continue;
                const metadata = await store.objectMetadata(row.webpObjectKey, controller.signal);
                report.verification.checked++;
                if (row.webpStatus !== 'READY' || !metadata || String(metadata.bytes) !== row.webpBytes) {
                    report.verification.mismatches.push(row.id);
                }
                await checkpoint();
            }
        }
        report.finishedAt = new Date().toISOString();
    } catch (error) {
        report.fatal = { reason: failureReason(error), name: error.name, code: error.code };
        throw error;
    } finally {
        await checkpoint(true);
        await prisma.$disconnect();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

module.exports = { collisionKeys, failureReason, runBackfill, differences };
if (require.main === module) main().catch(error => {
    console.error('WebP backfill stopped', { reason: failureReason(error), name: error.name, code: error.code });
    process.exitCode = 1;
});

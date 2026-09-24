/**
 * Extend labeled_warehouse_images and attach existing R2 WebPs to its label rows.
 * Dry-run by default. --apply adds only the documented compression columns,
 * then commits resumable batches. No R2 uploads, classification or legacy writes.
 *
 * node scripts/backfillImageCompression.js
 * node scripts/backfillImageCompression.js --apply
 * Optional: --batch-size=200 --report=/path/report.json --env-file=/path/.env
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { FIELDS, warehouseImageUrls, buildPlan, readInventory } = require('./lib/imageCompressionBackfill');

const ROOT = path.resolve(__dirname, '..');
const COLUMN_TYPES = {
    storageBucket: 'text', originalObjectKey: 'text', compressedImageUrl: 'text',
    compressedObjectKey: 'text', compressedBytes: 'int8', compressedAt: 'timestamptz',
    compressionStatus: 'varchar', compressionError: 'text', compressionCheckedAt: 'timestamptz', compressionVersion: 'text',
};
const LEGACY_FIELDS = ['id', 'warehouseId', 'imageUrl', 'classification', 'description', 'model', 'confidence', 'createdAt', 'documentKind'];
const UPDATE_SQL = `
    WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS r(id integer, "imageUrl" text, "before" jsonb, "after" jsonb, "beforeCheckedAt" timestamptz)
    )
    UPDATE public.labeled_warehouse_images AS l SET
      ${FIELDS.map(field => `"${field}" = (r."after"->>'${field}')::${COLUMN_TYPES[field]}`).join(',\n      ')},
      "compressionCheckedAt" = $2::timestamptz
    FROM incoming AS r
    WHERE l.id = r.id AND l."imageUrl" = r."imageUrl"
      ${FIELDS.map(field => `AND l."${field}" IS NOT DISTINCT FROM (r."before"->>'${field}')::${COLUMN_TYPES[field]}`).join('\n      ')}
      AND l."compressionCheckedAt" IS NOT DISTINCT FROM r."beforeCheckedAt"
    RETURNING l.id`;

function parseArgs(args) {
    const options = { apply: false, batchSize: 200, envFile: path.join(ROOT, '.env'), report: null };
    for (const arg of args) {
        if (arg === '--apply') options.apply = true;
        else if (arg === '--dry-run') options.apply = false;
        else if (arg.startsWith('--batch-size=')) {
            const value = Number(arg.slice('--batch-size='.length));
            if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error('batch-size must be an integer from 1 to 500');
            options.batchSize = value;
        } else if (arg.startsWith('--env-file=')) options.envFile = path.resolve(arg.slice('--env-file='.length));
        else if (arg.startsWith('--report=')) options.report = path.resolve(arg.slice('--report='.length));
        else throw new Error(`Unsupported argument: ${arg.split('=')[0]}`);
    }
    options.report ||= path.join(ROOT, 'tools', 'image-compression-backfill', `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.apply ? 'apply' : 'dry-run'}.json`);
    return options;
}

function configuration(env) {
    for (const key of ['DATABASE_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL']) {
        if (!env[key]?.trim()) throw new Error(`Missing configuration: ${key}`);
    }
    const base = new URL(env.R2_PUBLIC_URL.trim());
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new Error('R2_PUBLIC_URL must be an HTTPS origin');
    }
    const db = new URL(env.DATABASE_URL);
    db.searchParams.set('connection_limit', '1');
    db.searchParams.set('pool_timeout', '15');
    db.searchParams.set('connect_timeout', '10');
    return { databaseUrl: db.toString(), publicBase: base.origin, bucket: env.R2_BUCKET_NAME.trim() };
}

function safeError(error) {
    return { name: error?.name || 'Error', code: String(error?.code || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40),
        databaseCode: String(error?.meta?.code || '').replace(/[^a-z0-9_]/gi, '').slice(0, 12) };
}

function saveReport(file, report) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
}

async function schemaColumns(prisma) {
    const rows = await prisma.$queryRawUnsafe(`SELECT column_name, udt_name, is_nullable, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'labeled_warehouse_images'`);
    const columns = new Map(rows.map(row => [row.column_name, row]));
    if (!columns.has('imageUrl') || columns.get('classification')?.is_nullable !== 'NO') throw new Error('Expected existing label table with a required classification');
    const missing = [];
    for (const [name, type] of Object.entries(COLUMN_TYPES)) {
        const column = columns.get(name);
        if (!column) missing.push(name);
        else if (column.udt_name !== type || (name === 'compressionStatus'
            && (column.is_nullable !== 'NO' || column.character_maximum_length !== 16))) {
            throw new Error(`Existing column has an incompatible definition: ${name}`);
        }
    }
    return missing;
}

async function readRows(prisma) {
    const rows = await prisma.$queryRawUnsafe('SELECT to_jsonb(l) AS data FROM public.labeled_warehouse_images l ORDER BY l.id');
    return rows.map(row => row.data);
}

async function setupSchema(prisma) {
    const sql = fs.readFileSync(path.join(__dirname, 'sql', 'imageCompressionMetadata.sql'), 'utf8');
    await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
        for (const statement of sql.split('-- statement-breakpoint')) await tx.$executeRawUnsafe(statement.trim());
    }, { maxWait: 15000, timeout: 25000 });
}

async function writeBatch(prisma, changes, checkedAt) {
    return prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
        return tx.$queryRawUnsafe(UPDATE_SQL, JSON.stringify(changes), checkedAt);
    }, { maxWait: 15000, timeout: 25000 });
}

function legacyDigest(row) {
    return crypto.createHash('sha256').update(JSON.stringify(LEGACY_FIELDS.map(field => row[field] ?? null))).digest('hex');
}

async function run(options, { prisma, s3, ListObjectsV2Command, config, signal, stopping = () => false, log = console.log }) {
    const report = { startedAt: new Date().toISOString(), mode: options.apply ? 'apply' : 'dry-run',
        status: 'RUNNING', schema: {}, updated: 0, concurrentChangesSkipped: 0, lastProcessedId: null };
    const persist = () => saveReport(options.report, report);
    persist();
    try {
        // Finish the complete bucket inventory before any DDL or data updates.
        // A listing/network failure cannot mark valid variants as missing.
        const [rows, inventory, missingColumns, warehouses] = await Promise.all([
            readRows(prisma), readInventory(s3, ListObjectsV2Command, config.bucket, signal),
            schemaColumns(prisma), prisma.$queryRawUnsafe('SELECT id, photos, media FROM "Warehouse"'),
        ]);
        if (signal?.aborted || stopping()) throw new Error('Interrupted before writes');
        const sourceUrls = warehouseImageUrls(warehouses, config.publicBase);
        const labelUrls = new Set(rows.map(row => row.imageUrl));
        const missingLabels = [...sourceUrls].filter(url => !labelUrls.has(url)).length;
        const planConfig = { ...config, additionalOriginalUrls: sourceUrls };
        const plan = buildPlan(rows, inventory, planConfig);
        const checkedAt = new Date().toISOString();
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const change of plan.changes) change.beforeCheckedAt = byId.get(change.id).compressionCheckedAt || null;
        report.inventoryCompletedAt = checkedAt;
        report.nonemptyWebpObjects = inventory.size;
        report.schema.missingColumns = missingColumns;
        report.originalImageUrls = sourceUrls.size;
        report.unlabelledImageUrls = missingLabels;
        report.plan = plan.summary;
        persist();
        log(JSON.stringify({ event: 'plan', ...plan.summary, unlabelledImageUrls: missingLabels, missingColumns }));
        if (!options.apply) {
            report.status = 'DRY_RUN';
            return report;
        }

        await setupSchema(prisma);
        const stillMissing = await schemaColumns(prisma);
        if (stillMissing.length) throw new Error('Schema verification failed');
        report.schema.applied = true;
        persist();
        for (let offset = 0; offset < plan.changes.length; offset += options.batchSize) {
            if (stopping() || signal?.aborted) break;
            const batch = plan.changes.slice(offset, offset + options.batchSize);
            const written = await writeBatch(prisma, batch, checkedAt);
            report.updated += written.length;
            report.concurrentChangesSkipped += batch.length - written.length;
            report.lastProcessedId = batch.at(-1).id;
            persist();
            log(JSON.stringify({ event: 'progress', updated: report.updated, planned: plan.changes.length,
                concurrentChangesSkipped: report.concurrentChangesSkipped, lastProcessedId: report.lastProcessedId }));
        }

        const currentRows = await readRows(prisma);
        const remaining = buildPlan(currentRows, inventory, planConfig);
        const current = new Map(currentRows.map(row => [row.id, row]));
        report.verification = {
            ...remaining.summary,
            legacyRowsCompared: rows.filter(row => current.has(row.id)).length,
            legacyRowsChanged: rows.filter(row => current.has(row.id) && legacyDigest(row) !== legacyDigest(current.get(row.id))).length,
            labelRowsAddedDuringRun: currentRows.filter(row => !byId.has(row.id)).length,
            labelRowsRemovedDuringRun: rows.filter(row => !current.has(row.id)).length,
        };
        report.status = stopping() || signal?.aborted ? 'INTERRUPTED'
            : remaining.changes.length || report.concurrentChangesSkipped ? 'PARTIAL' : 'COMPLETE';
        return report;
    } catch (error) {
        report.status = 'FAILED';
        report.error = safeError(error);
        throw error;
    } finally {
        report.finishedAt = new Date().toISOString();
        persist();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    require('dotenv').config({ path: options.envFile, quiet: true });
    const config = configuration(process.env);
    const { PrismaClient } = require('@prisma/client');
    const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } }, log: [] });
    const [pipeline] = await prisma.$queryRawUnsafe(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'labeled_warehouse_images' AND column_name = 'webpUrl') AS enabled`);
    if (pipeline.enabled) {
        await prisma.$disconnect();
        throw new Error('Image pipeline schema is installed; use the table-driven WebP worker instead of the legacy metadata backfill.');
    }
    const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }, maxAttempts: 2 });
    const controller = new AbortController();
    let interrupted = false;
    const stop = () => { interrupted = true; controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        const report = await run(options, { prisma, s3, ListObjectsV2Command, config,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]), stopping: () => interrupted });
        console.log(JSON.stringify({ event: 'finished', status: report.status, report: options.report,
            updated: report.updated, verification: report.verification || report.plan, unlabelledImageUrls: report.unlabelledImageUrls }));
        if (report.status !== 'COMPLETE' && report.status !== 'DRY_RUN') process.exitCode = 2;
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        s3.destroy();
        await prisma.$disconnect();
    }
}

module.exports = { parseArgs, configuration, run, writeBatch, UPDATE_SQL, legacyDigest };
if (require.main === module) main().catch(error => {
    console.error(JSON.stringify({ event: 'failed', ...safeError(error) }));
    process.exitCode = 1;
});

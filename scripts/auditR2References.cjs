// Read-only reference audit. Never changes database records or storage objects.
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { configurations, fileType } = require('./auditR2Storage.cjs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const workspace = path.resolve(__dirname, '../../..');
const qi = value => '"' + value.replace(/"/g, '""') + '"';
const ql = value => "'" + value.replace(/'/g, "''") + "'";
const urlPattern = String.raw`https?://[a-zA-Z0-9.-]+[.]r2[.](?:dev|cloudflarestorage[.]com)/[^[:space:]"'<>\\,(){}]+`;
const jsUrls = /https?:\/\/[a-zA-Z0-9.-]+\.r2\.(?:dev|cloudflarestorage\.com)\/[^\s"'<>\\,(){}]+/g;

function connections() {
    const configs = configurations();
    return [
        { name: 'warehouse', config: configs.find(row => row.file === 'WAG_Dashboard/Backend_Repository/.env') },
        { name: 'calls', config: configs.find(row => row.file === 'exotel_experiments/exotel-call-service/.env') },
    ].map(({ name, config }) => {
        const url = new URL(config.env.DATABASE_URL);
        url.searchParams.set('connection_limit', '1');
        url.searchParams.set('pool_timeout', '30');
        return { name, db: new PrismaClient({ datasources: { db: { url: url.href } }, log: [] }) };
    });
}
async function read(db, sql, ...args) {
    return db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return tx.$queryRawUnsafe(sql, ...args);
    }, { timeout: 120000, maxWait: 30000 });
}
async function schema(db) {
    return read(db, `SELECT c.table_schema AS schema, c.table_name AS table,
        jsonb_agg(jsonb_build_object('name', c.column_name, 'type', c.data_type, 'udt', c.udt_name)
            ORDER BY c.ordinal_position) AS columns,
        max(s.n_live_tup)::text AS estimated_rows
        FROM information_schema.columns c
        JOIN information_schema.tables t ON c.table_schema=t.table_schema AND c.table_name=t.table_name
        LEFT JOIN pg_stat_user_tables s ON s.schemaname=c.table_schema AND s.relname=c.table_name
        WHERE t.table_type='BASE TABLE' AND c.table_schema NOT IN
          ('pg_catalog','information_schema','auth','storage','realtime','extensions','vault',
           'graphql','graphql_public','supabase_functions','supabase_migrations','cron','net','pgbouncer')
        AND c.table_schema NOT LIKE 'pg_%'
        GROUP BY c.table_schema,c.table_name ORDER BY c.table_schema,c.table_name`);
}
async function main() {
    const directory = path.resolve(process.argv[2]);
    const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'inventory-summary.json')));
    const report = { startedAt: new Date().toISOString(), readOnly: true, tables: [], skipped: [], errors: [], buckets: [], unknownOrigins: {}, missingReferences: [] };
    const objects = new Map(), origins = new Map();
    for (const bucket of inventory.buckets) {
        for (const base of bucket.publicBases) origins.set(new URL(base).origin, bucket.name);
        for (const line of fs.readFileSync(path.join(directory, `${bucket.name}.objects.ndjson`), 'utf8').trim().split('\n')) {
            if (!line) continue;
            const object = JSON.parse(line);
            objects.set(`${bucket.name}/${object.key}`, { bucket: bucket.name, ...object, references: {}, derived: [] });
        }
    }
    const missing = new Map();
    function reference(bucket, key, category, source) {
        const full = `${bucket}/${key}`;
        const object = objects.get(full);
        const target = object || missing.get(full) || { bucket, key, references: {} };
        const sources = target.references[category] ||= new Set(); sources.add(source);
        if (!object) missing.set(full, target);
    }
    function fromUrl(raw, category, source) {
        try {
            const url = new URL(raw.replace(/[.;:!\]]+$/, ''));
            let bucket = origins.get(url.origin);
            let key = url.pathname.replace(/^\/+/, '');
            try { key = decodeURIComponent(key); } catch { /* Preserve invalidly encoded literal keys. */ }
            if (!bucket && url.hostname.endsWith('.r2.cloudflarestorage.com')) {
                bucket = key.split('/')[0]; key = key.slice(bucket.length + 1);
            }
            if (!bucket) { report.unknownOrigins[url.origin] = (report.unknownOrigins[url.origin] || 0) + 1; return; }
            if (key) reference(bucket, key, category, source);
        } catch { /* Not a complete asset URL, e.g. a source-code template. */ }
    }
    function classify(table, status) {
        if (table === 'StagedWarehouse') return /PENDING|NEEDS/i.test(status || '') ? 'staging' : 'staging_history';
        if (['audit_logs','MessageLog','CronRunLog','bolna_webhook_events'].includes(table)) return 'history';
        return 'active';
    }
    const databaseSchema = {};
    const registry = [];
    for (const { name, db } of connections()) {
        try {
            const tables = databaseSchema[name] = await schema(db);
            for (const table of tables) {
                const source = `${name}.${table.schema}.${table.table}`;
                if (/^osm_|^spatial_ref_sys$|^_prisma_migrations$|^ReimbursementSession$/.test(table.table)) {
                    report.skipped.push({ source, reason: 'Geospatial reference data, migration metadata, or login sessions; no application media ownership.' }); continue;
                }
                if (table.table === 'labeled_warehouse_images') {
                    const columns = ['imageUrl','storageBucket','originalObjectKey','compressedImageUrl','compressedObjectKey','webpUrl','webpObjectKey','jpegUrl'];
                    const rows = await read(db, `SELECT ${columns.map(qi).join(',')} FROM ${qi(table.schema)}.${qi(table.table)}`);
                    registry.push(...rows); report.tables.push({ source, registryRows: rows.length });
                    console.log(JSON.stringify({ phase: 'table', source, registryRows: rows.length })); continue;
                }
                const columns = table.columns.filter(c => /^(text|character varying|character|json|jsonb)$/.test(c.type) || c.udt === '_text');
                if (!columns.length) continue;
                const tableReport = { source, scannedColumns: columns.map(c => c.name), matches: 0, bareKeys: 0 };
                report.tables.push(tableReport);
                try {
                    const statusExpr = table.table === 'StagedWarehouse' ? 't."reviewStatus"::text' : 'NULL::text';
                    const values = columns.map(c => `(${ql(c.name)}, t.${qi(c.name)}::text)`).join(',');
                    const rows = await read(db, `SELECT DISTINCT v.column_name, ${statusExpr} AS status, m.match[1] AS url
                        FROM ${qi(table.schema)}.${qi(table.table)} t
                        CROSS JOIN LATERAL (VALUES ${values}) v(column_name, body)
                        CROSS JOIN LATERAL regexp_matches(replace(v.body, chr(92)||'/', '/'), $1, 'g') m(match)`, urlPattern);
                    tableReport.matches = rows.length;
                    for (const row of rows) fromUrl(row.url, classify(table.table, row.status), `${source}.${row.column_name}${row.status ? ':' + row.status : ''}`);
                    const keyColumns = columns.filter(c => /^(r2Key|recording_r2_key|output_key)$/i.test(c.name));
                    for (const column of keyColumns) {
                        const keys = await read(db, `SELECT DISTINCT ${qi(column.name)}::text AS key FROM ${qi(table.schema)}.${qi(table.table)} WHERE ${qi(column.name)} IS NOT NULL`);
                        tableReport.bareKeys += keys.length;
                        for (const row of keys) {
                            if (!row.key) continue;
                            if (row.key.startsWith('http')) fromUrl(row.key, 'active', `${source}.${column.name}`);
                            else reference(table.table === 'calls' ? 'exotel-calls' : 'whatsapp-bot-media', row.key, 'active', `${source}.${column.name}`);
                        }
                    }
                } catch (error) { tableReport.error = { name: error.name, code: error.code, message: String(error.message).slice(-1200) }; report.errors.push({ source, ...tableReport.error }); }
                console.log(JSON.stringify({ phase: 'table', source, matches: tableReport.matches, bareKeys: tableReport.bareKeys, error: tableReport.error }));
            }
            if (name === 'warehouse') {
                report.warehouseCount = Number((await read(db, 'SELECT count(*)::text AS n FROM public."Warehouse"'))[0].n);
                report.stagedStatuses = await read(db, 'SELECT "reviewStatus"::text AS status, count(*)::text AS rows FROM public."StagedWarehouse" GROUP BY 1');
                report.compositionIds = (await read(db, 'SELECT id::text FROM public."VideoComposition"')).map(row => row.id);
            } else report.callRows = Number((await read(db, 'SELECT count(*)::text AS n FROM public.calls'))[0].n);
        } finally { await db.$disconnect(); }
    }
    // Include generated website content and application source, but not test snapshots,
    // audit artifacts, caches, historical backups, or credential files.
    const sourceRoots = [
        'website_combined/wareongo-website/src','website_combined/wareongo-website/public',
        'website_combined/wareongo-cms/app','website_combined/wareongo-cms/lib',
        'WAG_Dashboard/Backend_Repository/src','WAG_Dashboard/Frontend_Repository/src',
        'whatsapp-logistics-bot/src','Autoware/apps/backend/src','Autoware/apps/frontend/src',
        'panoramic_mvp_viewer/src','panoramic_mvp_viewer/app','panoramic_mvp_viewer/lib',
        'EmployeeReimbursementPortal/app','EmployeeReimbursementPortal/lib',
    ].map(root => path.join(workspace, root)).filter(root => fs.existsSync(root));
    const files = spawnSync('rg', ['--files', ...sourceRoots, '-g', '*.{js,ts,jsx,tsx,mjs,cjs,json,astro,md,mdx,html}', '-g', '!**/tests/**', '-g', '!**/*.test.*', '-g', '!**/node_modules/**', '-g', '!**/fixtures/**'], { encoding: 'utf8', maxBuffer: 5e6 });
    report.staticSource = { roots: sourceRoots.map(root => path.relative(workspace, root)), files: 0, matches: 0 };
    if (files.status !== 0) report.errors.push({ source: 'staticSource', error: files.error?.code || files.status });
    for (const file of (files.stdout || '').trim().split('\n').filter(Boolean)) {
        const content = fs.readFileSync(file, 'utf8'); report.staticSource.files++;
        for (const match of content.matchAll(jsUrls)) {
            // Ignore interpolated templates / bare origins that are not real object keys.
            if (/[${}]/.test(match[0]) || match[0].endsWith('/')) continue;
            fromUrl(match[0], 'static_source', path.relative(workspace, file)); report.staticSource.matches++;
        }
    }
    // Retain image registry references separately. A registry row alone does not
    // establish that an image is still attached to a warehouse.
    for (const row of registry) {
        const bucket = row.storageBucket || 'whatsapp-bot-media';
        const keys = [];
        for (const column of ['imageUrl','compressedImageUrl','webpUrl','jpegUrl']) if (row[column]) {
            fromUrl(row[column], 'registry', `labeled_warehouse_images.${column}`);
            try { const url = new URL(row[column]); keys.push(`${origins.get(url.origin) || bucket}/${decodeURIComponent(url.pathname).replace(/^\/+/, '')}`); } catch {}
        }
        for (const column of ['originalObjectKey','compressedObjectKey','webpObjectKey']) if (row[column]) {
            reference(bucket, row[column], 'registry', `labeled_warehouse_images.${column}`); keys.push(`${bucket}/${row[column]}`);
        }
        const linked = keys.some(key => Object.keys(objects.get(key)?.references || {}).some(category => ['active','staging','static_source'].includes(category)));
        if (linked) for (const key of keys) {
            const object = objects.get(key);
            if (object) reference(object.bucket, object.key, 'derived_active', 'Image variant of a referenced registry asset');
        }
    }
    // Legacy compression derives WebP keys from the original filename. Protect
    // these possible fallbacks but label them separately from explicit references.
    for (const object of objects.values()) {
        if (object.bucket !== 'whatsapp-bot-media' || object.key.startsWith('webp/') || !/\.(jpe?g|png|webp|avif|gif|tiff?|bmp)$/i.test(object.key)) continue;
        const derivedKey = 'webp/' + object.key.replace(/\.(jpe?g|png|webp|avif|gif|tiff?|bmp)$/i, '') + '.webp';
        const derived = objects.get(`${object.bucket}/${derivedKey}`);
        if (derived) {
            derived.derived.push(object.key);
            if (Object.keys(object.references).length) reference(derived.bucket, derived.key, 'derived_fallback', 'Filename-derived WebP of a referenced original');
        }
    }
    const categories = ['active','staging','static_source','derived_active','staging_history','history','registry','derived_fallback'];
    const add = (map, key, bytes) => { const item = map[key] ||= { objects: 0, bytes: 0 }; item.objects++; item.bytes += bytes; };
    const groups = new Map();
    for (const object of objects.values()) {
        object.classification = categories.find(category => object.references[category]?.size) || 'unreferenced';
        object.references = Object.fromEntries(Object.entries(object.references).map(([key, value]) => [key, [...value]]));
        let bucket = report.buckets.find(item => item.bucket === object.bucket);
        if (!bucket) { bucket = { bucket: object.bucket, byClassification: {}, unreferencedByType: {}, unreferencedByPrefix: {}, unreferencedByAge: {}, largestUnreferenced: [] }; report.buckets.push(bucket); }
        add(bucket.byClassification, object.classification, object.bytes);
        if (object.classification === 'unreferenced') {
            add(bucket.unreferencedByType, fileType(object.key), object.bytes);
            add(bucket.unreferencedByPrefix, object.key.includes('/') ? object.key.split('/')[0] + '/' : '(root)', object.bytes);
            const ageDays = (new Date(inventory.finishedAt) - new Date(object.modifiedAt)) / 864e5;
            add(bucket.unreferencedByAge, ageDays < 7 ? '<7 days' : ageDays < 30 ? '7–30 days' : ageDays < 90 ? '30–90 days' : '>90 days', object.bytes);
            bucket.largestUnreferenced.push({ key: object.key, bytes: object.bytes, modifiedAt: object.modifiedAt });
            bucket.largestUnreferenced.sort((a, b) => b.bytes - a.bytes); bucket.largestUnreferenced.length = Math.min(20, bucket.largestUnreferenced.length);
        }
        if (/^[a-f0-9]{32}$/i.test(object.etag || '')) {
            const id = `${object.bytes}:${object.etag}`;
            const group = groups.get(id) || []; group.push(object); groups.set(id, group);
        }
    }
    const duplicates = [...groups.values()].filter(group => group.length > 1).map(group => ({
        bytesEach: group[0].bytes, etag: group[0].etag, copies: group.length, potentialExtraBytes: group[0].bytes * (group.length - 1),
        objects: group.map(object => ({ bucket: object.bucket, key: object.key, classification: object.classification })),
    })).sort((a,b) => b.potentialExtraBytes - a.potentialExtraBytes);
    report.duplicateEtags = { groups: duplicates.length, potentialExtraBytes: duplicates.reduce((n,g) => n + g.potentialExtraBytes, 0), note: 'Matching single-part ETag and size; no full-content verification. Referenced duplicates require URL migration before deletion. Overlaps orphan candidates.' };
    report.missingReferences = [...missing.values()].map(row => ({ ...row, references: Object.fromEntries(Object.entries(row.references).map(([key,value]) => [key,[...value]])) }));
    report.finishedAt = new Date().toISOString();
    const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    save('database-schema.json', databaseSchema); save('reference-summary.json', report); save('duplicate-etags.json', duplicates);
    fs.writeFileSync(path.join(directory, 'object-references.ndjson'), [...objects.values()].map(object => JSON.stringify(object)).join('\n') + '\n', { mode: 0o600 });
    const csv = value => '"' + String(value).replace(/"/g, '""') + '"';
    fs.writeFileSync(path.join(directory, 'orphan-candidates.csv'), 'bucket,key,bytes,last_modified,age_days\n' + [...objects.values()].filter(object => object.classification === 'unreferenced').sort((a,b) => b.bytes-a.bytes).map(object => [object.bucket, object.key, object.bytes, object.modifiedAt, Math.floor((new Date(inventory.finishedAt)-new Date(object.modifiedAt))/864e5)].map(csv).join(',')).join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'complete', directory, buckets: report.buckets, errors: report.errors, duplicates: report.duplicateEtags, missingReferences: report.missingReferences.length, unknownOrigins: report.unknownOrigins, callRows: report.callRows }));
}
module.exports = { connections, read, schema };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ name: error.name, code: error.code, message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL]') })); process.exitCode = 1; });

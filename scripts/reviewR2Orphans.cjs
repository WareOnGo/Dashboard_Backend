// Second, independent read-only audit of orphan candidates. Does not delete files.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { connections, read } = require('./auditR2References.cjs');
const directory = path.resolve(process.argv[2]);
const workspace = path.resolve(__dirname, '../../..');
const objects = fs.readFileSync(path.join(directory, 'object-references.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const candidates = objects.filter(object => object.classification === 'unreferenced');
const schema = JSON.parse(fs.readFileSync(path.join(directory, 'database-schema.json')));
const save = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const qi = value => '"' + value.replace(/"/g, '""') + '"';
const ql = value => "'" + value.replace(/'/g, "''") + "'";
const basenamePattern = String.raw`[a-zA-Z0-9_%+-][a-zA-Z0-9_.%+-]{5,}[.](?:jpe?g|png|gif|webp|avif|heic|pdf|mp[34]|mov|m4a|wav|pptx?|presentation|vcard)`;

async function databaseReview() {
    const result = { startedAt: new Date().toISOString(), method: 'Independent filename scan across text, JSON, and text-array columns, without requiring an R2 URL hostname.', tables: [], matches: {}, errors: [], parentChecks: {} };
    const byBasename = new Map();
    for (const object of candidates) {
        const basename = path.posix.basename(object.key);
        const group = byBasename.get(basename) || []; group.push(object); byBasename.set(basename, group);
    }
    for (const { name, db } of connections()) {
        try {
            for (const table of schema[name]) {
                if (/^osm_|^spatial_ref_sys$|^_prisma_migrations$|^ReimbursementSession$/.test(table.table)) continue;
                const columns = table.columns.filter(c => /^(text|character varying|character|json|jsonb)$/.test(c.type) || c.udt === '_text');
                if (!columns.length) continue;
                const source = `${name}.${table.schema}.${table.table}`;
                try {
                    const values = columns.map(c => `(${ql(c.name)}, t.${qi(c.name)}::text)`).join(',');
                    const statusExpr = table.table === 'StagedWarehouse' ? 't."reviewStatus"::text' : 'NULL::text';
                    const rows = await read(db, `SELECT DISTINCT v.column_name, ${statusExpr} AS status, m.match[1] AS filename
                        FROM ${qi(table.schema)}.${qi(table.table)} t
                        CROSS JOIN LATERAL (VALUES ${values}) v(column_name, body)
                        CROSS JOIN LATERAL regexp_matches(v.body, $1, 'gi') m(match)`, basenamePattern);
                    let hits = 0;
                    for (const row of rows) {
                        let basename = row.filename;
                        try { basename = decodeURIComponent(basename); } catch {}
                        for (const object of byBasename.get(basename) || []) {
                            const matches = result.matches[`${object.bucket}/${object.key}`] ||= [];
                            matches.push({ source, column: row.column_name, status: row.status }); hits++;
                        }
                    }
                    result.tables.push({ source, filenames: rows.length, candidateMatches: hits });
                    console.log(JSON.stringify({ phase: 'filename_scan', source, candidateMatches: hits }));
                } catch (error) { result.errors.push({ source, name: error.name, code: error.code }); }
            }
            if (name === 'warehouse') {
                result.parentChecks.ticketIds = (await read(db, 'SELECT id, "shortCode" FROM public."Ticket"')).map(row => ({ id: row.id, shortCode: row.shortCode }));
                result.parentChecks.compositionIds = (await read(db, 'SELECT id::text FROM public."VideoComposition"')).map(row => row.id);
                result.parentChecks.panorama = await read(db, 'SELECT t.id, t.slug, count(s.id)::text AS scenes FROM panos."Tour" t LEFT JOIN panos."Scene" s ON s."tourId"=t.id GROUP BY t.id,t.slug');
            }
        } finally { await db.$disconnect(); }
    }
    result.finishedAt = new Date().toISOString(); save('orphan-database-review.json', result);
    console.log(JSON.stringify({ phase: 'database_review_complete', candidatesWithFilenameReferences: Object.keys(result.matches).length, errors: result.errors }));
}

async function localReview() {
    const patternFile = path.join(directory, 'candidate-keys.txt');
    // Include basenames as well as full keys to catch proxy URLs and relative paths.
    const patterns = [...new Set(candidates.flatMap(object => [object.key, path.posix.basename(object.key)]))];
    fs.writeFileSync(patternFile, patterns.join('\n') + '\n', { mode: 0o600 });
    const result = { startedAt: new Date().toISOString(), method: 'Exact object keys and filenames across application code, local exports, snapshots and backups; excludes credentials, dependencies and the current audit outputs.', matches: {}, files: {}, errors: [] };
    const byPattern = new Map();
    for (const object of candidates) for (const pattern of new Set([object.key, path.posix.basename(object.key)])) {
        const group = byPattern.get(pattern) || []; group.push(`${object.bucket}/${object.key}`); byPattern.set(pattern, group);
    }
    const args = ['--hidden', '--no-ignore', '--with-filename', '--line-number', '--only-matching', '--fixed-strings', '--file', patternFile,
        '--glob', '*.{js,ts,jsx,tsx,mjs,cjs,json,ndjson,jsonl,sql,csv,txt,md,mdx,html,astro,yaml,yml,log}',
        ...['**/.git/**','**/node_modules/**','**/.next/**','**/dist/**','**/.venv/**','**/venv/**','**/env-backups/**','**/.env*',
            '**/tools/r2-audit/**','**/tools/image-pipeline/**','**/tools/image-compression-backfill/**','**/tools/ppt-preview/**',
            '**/test-results/**','**/playwright-report/**','**/coverage/**'].flatMap(glob => ['--glob', '!' + glob]), workspace];
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { if (stderr.length < 2000) stderr += data; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const lines = readline.createInterface({ input: child.stdout });
    for await (const line of lines) {
        const match = line.match(/^(.*?):([0-9]+):(.*)$/);
        if (!match) continue;
        const relative = path.relative(workspace, match[1]);
        const lineNumber = Number(match[2]);
        for (const key of byPattern.get(match[3]) || []) {
            const refs = result.matches[key] ||= {};
            const item = refs[relative] ||= { occurrences: 0, sampleLines: [] };
            item.occurrences++;
            if (item.sampleLines.length < 3 && !item.sampleLines.includes(lineNumber)) item.sampleLines.push(lineNumber);
            result.files[relative] = (result.files[relative] || 0) + 1;
        }
    }
    const code = await done;
    if (code > 1 || stderr) result.errors.push({ code, message: stderr });
    result.finishedAt = new Date().toISOString(); save('orphan-local-review.json', result);
    console.log(JSON.stringify({ phase: 'local_review_complete', candidatesWithLocalReferences: Object.keys(result.matches).length, files: Object.keys(result.files).length, errors: result.errors }));
}

async function traceReview() {
    const local = JSON.parse(fs.readFileSync(path.join(directory, 'orphan-local-review.json')));
    const catalogue = JSON.parse(fs.readFileSync(path.join(workspace, 'website_combined/geo-audit-revalidation-2026-09-13/captures/catalogue.json')));
    const historical = [];
    function walk(value) {
        if (!value || typeof value !== 'object') return;
        if (!Array.isArray(value) && Number.isInteger(value.id)) {
            const text = JSON.stringify(value);
            const keys = Object.keys(local.matches).filter(key => text.includes(key.slice(key.indexOf('/') + 1)));
            if (keys.length) historical.push({ warehouseId: value.id, keys });
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
    }
    walk(catalogue);
    const result = { startedAt: new Date().toISOString(), historical, auditEvents: [], currentHistoricalWarehouses: [] };
    const { db } = connections().find(row => row.name === 'warehouse');
    try {
        result.databaseAccess = await read(db, `SELECT current_user AS role, rolsuper AS superuser,
            rolbypassrls AS bypasses_row_security, current_setting('transaction_read_only') AS transaction_read_only
            FROM pg_roles WHERE rolname=current_user`);
        result.auditEvents = await read(db, `WITH keys AS (SELECT jsonb_array_elements_text($1::jsonb) AS key)
            SELECT a."entityId" AS key, a.action, a.entity, a.context,
                count(*)::text AS events, min(a."createdAt") AS first, max(a."createdAt") AS last
            FROM public.audit_logs a JOIN keys ON keys.key=a."entityId"
            GROUP BY a."entityId",a.action,a.entity,a.context`, JSON.stringify([...new Set(candidates.map(object => path.posix.basename(object.key)))]));
        result.currentHistoricalWarehouses = await read(db, `SELECT id, visibility,
            (media IS NOT NULL) AS has_media, (photos IS NOT NULL) AS has_photos
            FROM public."Warehouse" WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::integer)`, JSON.stringify([...new Set(historical.map(row => row.warehouseId))]));
    } finally { await db.$disconnect(); }
    result.finishedAt = new Date().toISOString(); save('orphan-trace-review.json', result);
    const summary = {};
    for (const row of result.auditEvents) {
        const key = `${row.action}/${row.entity}/${row.context}`;
        summary[key] = (summary[key] || 0) + 1;
    }
    console.log(JSON.stringify({ phase: 'trace_review_complete', auditKinds: summary, historical, currentHistoricalWarehouses: result.currentHistoricalWarehouses }));
}

async function main() {
    if (process.argv[3] === 'local') await localReview();
    else if (process.argv[3] === 'database') await databaseReview();
    else if (process.argv[3] === 'trace') await traceReview();
    else throw new Error('Choose local, database, or trace mode');
}
main().catch(error => { console.error(JSON.stringify({ name: error.name, code: error.code, message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL]') })); process.exitCode = 1; });

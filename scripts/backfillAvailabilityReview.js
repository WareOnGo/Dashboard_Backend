// One-off, evidence-based backfill. Default: write a dry-run plan; --apply <plan>
// updates only still-empty, unchanged rows and records the source in audit_logs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { todayInIndia } = require('../src/utils/availabilityReview');

const entities = { warehouse: 'Warehouse', staged_warehouse: 'StagedWarehouse' };
const normalized = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const instant = value => value == null ? NaN : new Date(value).getTime();
const countBy = (rows, key) => rows.reduce((out, row) => {
    const value = typeof key === 'function' ? key(row) : row[key];
    out[value] = (out[value] || 0) + 1;
    return out;
}, {});

function history(audits) {
    const events = [];
    let reviewed = false;
    for (const audit of audits) {
        reviewed ||= Boolean(audit.reviewMentioned);
        const changes = (audit.changes || []).filter(change => change.field === 'availability');
        for (const change of changes) {
            if (!Object.hasOwn(change, 'from') || !Object.hasOwn(change, 'to')) {
                events.push({ kind: 'uncertain_legacy_update', at: audit.createdAt, auditId: audit.id });
            } else if (normalized(change.from) !== normalized(change.to)) {
                events.push({ kind: 'audit_change', value: change.to, at: audit.createdAt, auditId: audit.id });
            }
        }
        if (audit.action === 'UPDATE' && !audit.hasChanges && audit.availabilityMentioned) {
            events.push({ kind: 'uncertain_legacy_update', at: audit.createdAt, auditId: audit.id });
        }
        if (audit.action === 'CREATE' && normalized(audit.initialAvailability)) {
            events.push({ kind: 'audit_creation', value: audit.initialAvailability, at: audit.createdAt, auditId: audit.id });
        }
    }
    return { events, reviewed };
}

function choose(events, availability, now) {
    if (!events.length) return { reason: 'no_creation_or_change_evidence' };
    if (events.some(event => !Number.isFinite(instant(event.at)) || instant(event.at) > instant(now))) {
        return { reason: 'invalid_or_future_history' };
    }
    const latestAt = Math.max(...events.map(event => instant(event.at)));
    const latest = events.filter(event => instant(event.at) === latestAt);
    if (latest.some(event => event.kind === 'uncertain_legacy_update')) return { reason: 'uncertain_legacy_update' };
    if (new Set(latest.map(event => normalized(event.value))).size !== 1) return { reason: 'ambiguous_history' };
    if (normalized(latest[0].value) !== normalized(availability)) return { reason: 'current_value_mismatch' };
    const event = latest[0];
    return { date: todayInIndia(new Date(event.at)), evidence: event };
}

function buildPlan(snapshot, now = new Date()) {
    const byEntity = new Map();
    for (const audit of snapshot.audits) {
        const key = `${audit.entity}:${audit.entityId}`;
        if (!byEntity.has(key)) byEntity.set(key, []);
        byEntity.get(key).push(audit);
    }
    const stagedEvidence = new Map();
    const linked = new Map();
    const candidates = [];
    const skipped = [];
    const reviewHistory = row => row.availabilityLastReviewedOn != null;
    const record = (entity, row, result) => {
        if (result.date) {
            candidates.push({ entity, id: String(row.id), version: row.version, availability: row.availability,
                date: result.date, evidence: result.evidence,
                sourceId: result.evidence.sourceId || null, sourceVersion: result.evidence.sourceVersion || null });
        } else skipped.push({ entity, id: String(row.id), reason: result.reason });
    };

    for (const row of snapshot.staged) {
        const { events, reviewed } = history(byEntity.get(`staged_warehouse:${row.id}`) || []);
        if (normalized(row.initialAvailability)) events.push({ kind: 'submission_creation', value: row.initialAvailability,
            at: row.submittedAt, sourceId: row.id, sourceVersion: row.version });
        const result = reviewHistory(row) ? { reason: 'already_recorded' }
            : !normalized(row.availability) ? { reason: 'no_availability' }
                : reviewed || row.initialReviewDate != null ? { reason: 'explicit_review_history' }
                    : choose(events, row.availability, now);
        stagedEvidence.set(row.id, result);
        record('staged_warehouse', row, result);
        if (row.reviewStatus === 'APPROVED' && row.warehouseId != null) {
            const key = String(row.warehouseId);
            if (!linked.has(key)) linked.set(key, []);
            linked.get(key).push(row);
        }
    }
    for (const row of snapshot.warehouses) {
        const { events, reviewed } = history(byEntity.get(`warehouse:${row.id}`) || []);
        const origins = linked.get(String(row.id)) || [];
        if (origins.length === 1) {
            const origin = origins[0];
            const source = stagedEvidence.get(origin.id);
            if (source.date && instant(source.evidence.at) <= instant(row.createdAt)) {
                // Keep the date the availability was recorded, not the approval date.
                events.push({ ...source.evidence, kind: `staged_${source.evidence.kind}`,
                    sourceId: origin.id, sourceVersion: origin.version });
            }
        }
        const result = reviewHistory(row) ? { reason: 'already_recorded' }
            : !normalized(row.availability) ? { reason: 'no_availability' }
                : reviewed ? { reason: 'explicit_review_history' }
                    : choose(events, row.availability, now);
        record('warehouse', row, result);
    }
    return { version: 1, runId: randomUUID(), preparedAt: new Date(now).toISOString(),
        policy: 'Actual availability changes or evidenced initial availability; calendar dates in Asia/Kolkata; never generic update/approval timestamps.',
        candidates, skipped,
        summary: { scanned: snapshot.warehouses.length + snapshot.staged.length,
            candidates: candidates.length, byEntity: countBy(candidates, 'entity'),
            byEvidence: countBy(candidates, row => row.evidence.kind),
            skipped: countBy(skipped, row => `${row.entity}:${row.reason}`) } };
}

async function readSnapshot(prisma) {
    const [warehouses, staged, audits] = await prisma.$transaction([
        prisma.$queryRawUnsafe(`SELECT id, availability, "availabilityLastReviewedOn", "createdAt", xmin::text version
            FROM public."Warehouse" ORDER BY id`),
        prisma.$queryRawUnsafe(`SELECT id, availability, "availabilityLastReviewedOn", "submittedAt", "reviewStatus", "warehouseId",
            "rawPayload"->>'availability' AS "initialAvailability",
            "rawPayload"->>'availabilityLastReviewedOn' AS "initialReviewDate", xmin::text version
            FROM public."StagedWarehouse" ORDER BY id`),
        prisma.$queryRawUnsafe(`SELECT id, entity, "entityId", action, "createdAt",
            COALESCE(jsonb_typeof(metadata->'changes')='array',false) AS "hasChanges",
            COALESCE(metadata->'updatedFields' ? 'availability',false) AS "availabilityMentioned",
            COALESCE(metadata->'changes' @> '[{"field":"availabilityLastReviewedOn"}]'::jsonb
                OR metadata->'updatedFields' ? 'availabilityLastReviewedOn'
                OR metadata->'requestedFields' ? 'availabilityLastReviewedOn',false) AS "reviewMentioned",
            metadata->>'availability' AS "initialAvailability",
            COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'changes')='array'
                THEN metadata->'changes' ELSE '[]'::jsonb END) c WHERE c->>'field'='availability'),'[]'::jsonb) AS changes
            FROM public.audit_logs WHERE entity IN ('warehouse','staged_warehouse') AND action IN ('CREATE','UPDATE')
            ORDER BY "createdAt", id`),
    ], { isolationLevel: 'RepeatableRead' });
    return { warehouses, staged, audits };
}

function applySql(entity) {
    const table = entities[entity];
    if (!table) throw new Error('Unknown backfill entity');
    return `WITH proposed AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text,version text,availability text,date date,
            evidence jsonb,"sourceId" text,"sourceVersion" text)
      ), sources AS MATERIALIZED (
        SELECT s.id,s.xmin::text version FROM public."StagedWarehouse" s
        WHERE s.id IN (SELECT "sourceId" FROM proposed WHERE "sourceId" IS NOT NULL) FOR SHARE
      ), updated AS (
        UPDATE public."${table}" t SET "availabilityLastReviewedOn"=p.date FROM proposed p
        WHERE t.id::text=p.id AND t.xmin::text=p.version AND t."availabilityLastReviewedOn" IS NULL
          AND t.availability IS NOT DISTINCT FROM p.availability AND p.date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
          AND (p."sourceId" IS NULL OR EXISTS(SELECT 1 FROM sources s WHERE s.id=p."sourceId" AND s.version=p."sourceVersion"))
        RETURNING t.id::text id,t.availability,t."availabilityLastReviewedOn"::text date,t.xmin::text version
      ), logged AS (
        INSERT INTO public.audit_logs (id,action,entity,"entityId",context,metadata,"userEmail","createdAt")
        SELECT gen_random_uuid()::text,'UPDATE',$2,u.id,'Backfilled availability review date from historical evidence',
          jsonb_build_object('source','AVAILABILITY_REVIEW_BACKFILL','backfillRunId',$3::text,'evidence',p.evidence,
            'updatedFields',jsonb_build_array('availabilityLastReviewedOn'),'changeCount',1,
            'changes',jsonb_build_array(jsonb_build_object('field','availabilityLastReviewedOn','from',NULL,'to',u.date))),
          'system:availability-review-backfill',CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        FROM updated u JOIN proposed p ON p.id=u.id RETURNING "entityId"
      ) SELECT u.*,$2::text entity FROM updated u JOIN logged l ON l."entityId"=u.id`;
}

async function applyPlan(prisma, plan) {
    if (plan.version !== 1 || !plan.runId || !Array.isArray(plan.candidates)) throw new Error('Invalid backfill plan');
    const seen = new Set();
    for (const row of plan.candidates) {
        const key = `${row.entity}:${row.id}`;
        if (!entities[row.entity] || !/^\d+$/.test(row.version) || !normalized(row.availability)
            || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !row.evidence || seen.has(key)) throw new Error('Invalid backfill candidate');
        seen.add(key);
    }
    // Master first: its evidence checks the staging version before this same
    // transaction backfills staging. No @updatedAt or review-status fields change.
    const results = await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'"),
        ...Object.keys(entities).map(entity => prisma.$queryRawUnsafe(applySql(entity),
            JSON.stringify(plan.candidates.filter(row => row.entity === entity)), entity, plan.runId)),
    ]);
    const written = results.slice(2).flat();
    const applied = new Set(written.map(row => `${row.entity}:${row.id}`));
    return { runId: plan.runId, appliedAt: new Date().toISOString(), written,
        skippedSincePlan: plan.candidates.filter(row => !applied.has(`${row.entity}:${row.id}`)).map(({ entity, id }) => ({ entity, id })),
        summary: { written: written.length, byEntity: countBy(written, 'entity'), skippedSincePlan: plan.candidates.length - written.length } };
}

function rollbackSql(receipt) {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    return '-- Restore only rows still at the exact version written by this backfill.\nBEGIN;\n'
        + receipt.written.map(row => `UPDATE public."${entities[row.entity]}" SET "availabilityLastReviewedOn"=NULL WHERE id::text=${quote(row.id)} AND xmin::text=${quote(row.version)} AND "availabilityLastReviewedOn"=${quote(row.date)}::date;`).join('\n')
        + '\nCOMMIT;\n';
}

async function verifyPlan(prisma, receipt) {
    for (const [entity, table] of Object.entries(entities)) {
        const rows = receipt.written.filter(row => row.entity === entity);
        const mismatches = await prisma.$queryRawUnsafe(`SELECT p.id FROM jsonb_to_recordset($1::jsonb) AS p(id text,date date)
            LEFT JOIN public."${table}" t ON t.id::text=p.id WHERE t.id IS NULL OR t."availabilityLastReviewedOn" IS DISTINCT FROM p.date`, JSON.stringify(rows));
        if (mismatches.length) throw new Error(`Post-backfill verification found ${mismatches.length} changed or missing ${entity} rows`);
    }
    const [audit] = await prisma.$queryRawUnsafe(`SELECT count(*)::int total FROM public.audit_logs WHERE metadata->>'backfillRunId'=$1`, receipt.runId);
    if (audit.total !== receipt.written.length) throw new Error('Backfill audit count mismatch');
    return { rows: receipt.written.length, auditRows: audit.total };
}

module.exports = { buildPlan, readSnapshot, applyPlan, verifyPlan, rollbackSql };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--apply')) throw new Error('Usage: node scripts/backfillAvailabilityReview.js [--apply <plan.json>]');
    const { PrismaClient } = require('@prisma/client');
    const url = new URL(process.env.DATABASE_URL);
    const fingerprint = createHash('sha256').update(`${url.host}${url.pathname}:${url.username}`).digest('hex');
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('connect_timeout', '20');
    const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const save = (filename, data) => fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    (async () => {
        if (!args.length) {
            const plan = { ...buildPlan(await readSnapshot(prisma)), databaseFingerprint: fingerprint };
            const filename = path.resolve(__dirname, `../tools/availability-review-${plan.runId}.plan.json`);
            save(filename, plan);
            console.log(JSON.stringify({ mode: 'dry-run', ...plan.summary, plan: filename }, null, 2));
        } else {
            const filename = path.resolve(args[1]);
            const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (plan.databaseFingerprint !== fingerprint) throw new Error('Plan targets a different database');
            const receiptPath = filename.replace(/\.json$/, '') + '.applied.json';
            if (fs.existsSync(receiptPath)) throw new Error('This plan already has an apply receipt');
            const receipt = await applyPlan(prisma, plan);
            save(receiptPath, receipt);
            fs.writeFileSync(receiptPath + '.rollback.sql', rollbackSql(receipt), { mode: 0o600, flag: 'wx' });
            const verification = await verifyPlan(prisma, receipt);
            console.log(JSON.stringify({ mode: 'apply', ...receipt.summary, verification, receipt: receiptPath }, null, 2));
        }
    })().catch(error => {
        console.error(JSON.stringify({ error: error.name, code: error.code,
            message: error.name === 'Error' ? error.message : 'Availability backfill database operation failed' }));
        process.exitCode = 1;
    }).finally(() => prisma.$disconnect());
}

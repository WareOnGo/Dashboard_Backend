// Dry-run by default. Apply an inspected plan to blank, unchanged rows only.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { IGNORED_FIELDS } = require('../src/utils/auditDiff');

const tables = { warehouse: 'Warehouse', staged_warehouse: 'StagedWarehouse' };
const text = value => value == null ? '' : String(value).trim();
const time = value => new Date(value).getTime();
const countBy = (rows, key) => rows.reduce((out, row) => {
    const value = typeof key === 'function' ? key(row) : row[key];
    out[value] = (out[value] || 0) + 1;
    return out;
}, {});
const historySignature = rows => createHash('md5').update(rows.map(row => `${row.id}:${row.version}`).sort().join(',')).digest('hex');

function contentEvent(audit) {
    if (!['CREATE', 'UPDATE'].includes(audit.action)) return null;
    // Automated bookkeeping is not a human editor. In particular, do not let
    // the previous availability-date backfill replace the actual person's name.
    if (/^(system:|webhook:)/i.test(text(audit.userEmail)) || audit.backfillRunId) return null;
    if (audit.action === 'UPDATE') {
        if (audit.changeCount === 0) return null;
        const fields = audit.hasChanges ? audit.changedFields : audit.updatedFields;
        if (Array.isArray(fields) && !fields.some(field => !IGNORED_FIELDS.has(field))) return null;
    }
    const email = text(audit.userEmail);
    const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    // Older Scout audit entries stored a display name in userEmail. The
    // server-recorded scoutId, not that name, is the authenticated ID fallback.
    const scoutId = ['SCOUT', 'SCOUT_FORM'].includes(audit.source) && /^\d+$/.test(text(audit.scoutId))
        ? text(audit.scoutId) : null;
    const userId = text(audit.actorUserId) || scoutId;
    return {
        value: hasEmail ? email : userId,
        at: audit.createdAt,
        evidence: {
            auditId: audit.id, entity: audit.entity, entityId: audit.entityId,
            action: audit.action, createdAt: audit.createdAt,
            identitySource: hasEmail ? 'email' : text(audit.actorUserId) ? 'actorUserId' : scoutId ? 'scoutId' : 'unavailable',
            kind: audit.action === 'CREATE' ? 'creation' : audit.hasChanges ? 'edit' : 'legacy_edit',
        },
    };
}

function choose(events, now) {
    if (!events.length) return { reason: 'no_audit_evidence' };
    if (events.some(event => !Number.isFinite(time(event.at)) || time(event.at) > time(now))) {
        return { reason: 'invalid_or_future_history' };
    }
    const latestAt = Math.max(...events.map(event => time(event.at)));
    const latest = events.filter(event => time(event.at) === latestAt);
    if (latest.some(event => !event.value)) return { reason: 'latest_actor_unavailable' };
    if (new Set(latest.map(event => event.value.toLowerCase())).size !== 1) return { reason: 'ambiguous_latest_actor' };
    return latest[0];
}

function buildPlan(snapshot, now = new Date()) {
    const histories = new Map();
    for (const audit of snapshot.audits) {
        const key = `${audit.entity}:${audit.entityId}`;
        if (!histories.has(key)) histories.set(key, []);
        histories.get(key).push(audit);
    }
    const history = (entity, id) => histories.get(`${entity}:${id}`) || [];
    const events = (entity, id) => history(entity, id).map(contentEvent).filter(Boolean);
    const staged = new Map(snapshot.staged.map(row => [row.id, row]));
    const origins = new Map();
    const link = (warehouseId, sourceId, at, auditId = null) => {
        const key = String(warehouseId);
        if (!origins.has(key)) origins.set(key, new Map());
        const prior = origins.get(key).get(sourceId);
        if (!prior || time(at) > time(prior.at)) origins.get(key).set(sourceId, { sourceId, at, auditId });
    };
    for (const audit of snapshot.audits) {
        if (audit.entity === 'staged_warehouse' && audit.action === 'APPROVE' && /^\d+$/.test(text(audit.warehouseId))) {
            link(audit.warehouseId, audit.entityId, audit.createdAt, audit.id);
        }
    }
    // A surviving publication link also covers a missing approval log. The
    // actor still comes exclusively from a CREATE/UPDATE audit entry.
    for (const row of snapshot.staged) {
        if (row.reviewStatus === 'APPROVED' && row.warehouseId != null && row.reviewedAt) {
            link(row.warehouseId, row.id, row.reviewedAt);
        }
    }
    const candidates = [], skipped = [];
    const record = (entity, row, choices) => {
        const result = text(row.lastEditedBy) ? { reason: 'already_recorded' } : choose(choices, now);
        if (result.reason) skipped.push({ entity, id: String(row.id), reason: result.reason });
        else candidates.push({
            entity, id: String(row.id), version: row.version,
            previousLastEditedBy: row.lastEditedBy ?? null, value: result.value,
            historySignature: historySignature(history(entity, row.id)), evidence: result.evidence,
            sourceId: result.sourceId || null, sourceVersion: result.sourceVersion || null,
            sourceHistorySignature: result.sourceId ? historySignature(history('staged_warehouse', result.sourceId)) : null,
        });
    };
    for (const row of snapshot.staged) record('staged_warehouse', row, events('staged_warehouse', row.id));
    for (const row of snapshot.warehouses) {
        const choices = events('warehouse', row.id);
        const links = [...(origins.get(String(row.id))?.values() || [])];
        if (links.length > 1 && !text(row.lastEditedBy)) {
            skipped.push({ entity: 'warehouse', id: String(row.id), reason: 'ambiguous_publication' });
            continue;
        }
        for (const origin of links) {
            const source = staged.get(origin.sourceId);
            for (const event of events('staged_warehouse', origin.sourceId)) {
                // CREATE is logged after an auto-promotion finishes, but is
                // logically before publication. Later staged edits cannot be
                // attributed to an earlier published warehouse.
                if (event.evidence.action !== 'CREATE' && time(event.at) > time(origin.at)) continue;
                choices.push({ ...event, at: new Date(Math.min(time(event.at), time(origin.at))).toISOString(),
                    sourceId: origin.sourceId, sourceVersion: source?.version,
                    evidence: { ...event.evidence, kind: `staged_${event.evidence.kind}`, approvalAuditId: origin.auditId } });
            }
        }
        record('warehouse', row, choices);
    }
    return { version: 1, runId: randomUUID(), preparedAt: new Date(now).toISOString(),
        policy: 'Latest recorded human edit or creation; email then recorded Scout user ID. Exclude no-op saves, reads, approvals and system bookkeeping; retain existing attribution.',
        candidates, skipped,
        summary: { scanned: snapshot.warehouses.length + snapshot.staged.length,
            candidates: candidates.length, byEntity: countBy(candidates, 'entity'),
            byEvidence: countBy(candidates, row => row.evidence.kind),
            byIdentity: countBy(candidates, row => row.evidence.identitySource),
            skipped: countBy(skipped, row => `${row.entity}:${row.reason}`) } };
}

async function readSnapshot(prisma) {
    const [, warehouses, staged, audits] = await prisma.$transaction([
        prisma.$executeRawUnsafe('SET TRANSACTION READ ONLY'),
        // JSON lookup permits a dry run before the additive column migration.
        prisma.$queryRawUnsafe(`SELECT id,to_jsonb(w)->>'lastEditedBy' AS "lastEditedBy",xmin::text version FROM "Warehouse" w ORDER BY id`),
        prisma.$queryRawUnsafe(`SELECT id,to_jsonb(s)->>'lastEditedBy' AS "lastEditedBy","reviewStatus"::text,"warehouseId","reviewedAt",xmin::text version FROM "StagedWarehouse" s ORDER BY id`),
        prisma.$queryRawUnsafe(`SELECT id,entity,"entityId",action,"userEmail","createdAt",xmin::text version,
            metadata->>'source' source,metadata->>'scoutId' AS "scoutId",metadata->>'warehouseId' AS "warehouseId",
            metadata->>'actorUserId' AS "actorUserId",
            metadata->>'backfillRunId' AS "backfillRunId",metadata->'changeCount' AS "changeCount",
            COALESCE(jsonb_typeof(metadata->'changes')='array',false) AS "hasChanges",
            (SELECT jsonb_agg(c->>'field') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'changes')='array' THEN metadata->'changes' ELSE '[]'::jsonb END) c) AS "changedFields",
            metadata->'updatedFields' AS "updatedFields"
            FROM audit_logs WHERE entity IN ('warehouse','staged_warehouse') AND action IN ('CREATE','UPDATE','APPROVE') ORDER BY "createdAt",id`),
    ], { isolationLevel: 'RepeatableRead' });
    // An empty changed-fields array is distinct from legacy logs without diffs.
    for (const audit of audits) if (audit.hasChanges && audit.changedFields === null) audit.changedFields = [];
    return { warehouses, staged, audits };
}

const signatureSql = (entity, id) => `(SELECT md5(COALESCE(string_agg(a.id||':'||a.xmin::text,',' ORDER BY (a.id||':'||a.xmin::text) COLLATE "C"),'')) FROM audit_logs a WHERE a.entity=${entity} AND a."entityId"=${id} AND a.action IN ('CREATE','UPDATE','APPROVE'))`;
function applySql(entity) {
    return `WITH proposed AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id text,version text,value text,"previousLastEditedBy" text,
            "historySignature" text,evidence jsonb,"sourceId" text,"sourceVersion" text,"sourceHistorySignature" text)
      ), sources AS MATERIALIZED (
        SELECT s.id,s.xmin::text version FROM "StagedWarehouse" s WHERE s.id IN
          (SELECT "sourceId" FROM proposed WHERE "sourceVersion" IS NOT NULL) FOR SHARE
      ), updated AS (
        UPDATE "${tables[entity]}" t SET "lastEditedBy"=p.value FROM proposed p
        WHERE t.id::text=p.id AND t.xmin::text=p.version AND NULLIF(btrim(t."lastEditedBy"),'') IS NULL
          AND t."lastEditedBy" IS NOT DISTINCT FROM p."previousLastEditedBy"
          AND ${signatureSql('$2', 'p.id')}=p."historySignature"
          AND (p."sourceId" IS NULL OR ${signatureSql("'staged_warehouse'", 'p."sourceId"')}=p."sourceHistorySignature")
          AND (p."sourceVersion" IS NULL OR EXISTS(SELECT 1 FROM sources s WHERE s.id=p."sourceId" AND s.version=p."sourceVersion"))
        RETURNING t.id::text id,t."lastEditedBy" value,t.xmin::text version
      ), logged AS (
        INSERT INTO audit_logs (id,action,entity,"entityId",context,metadata,"userEmail","createdAt")
        SELECT gen_random_uuid()::text,'UPDATE',$2,u.id,'Backfilled last editor from audit history',
          jsonb_build_object('source','LAST_EDITED_BY_BACKFILL','backfillRunId',$3::text,'evidence',p.evidence,'writtenVersion',u.version,
            'updatedFields',jsonb_build_array('lastEditedBy'),'changeCount',1,
            'changes',jsonb_build_array(jsonb_build_object('field','lastEditedBy','from',p."previousLastEditedBy",'to',u.value))),
          'system:last-edited-by-backfill',CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        FROM updated u JOIN proposed p ON p.id=u.id RETURNING "entityId"
      ) SELECT u.*,$2::text entity,p."previousLastEditedBy" FROM updated u JOIN logged l ON l."entityId"=u.id JOIN proposed p ON p.id=u.id`;
}

async function applyPlan(prisma, plan) {
    if (plan.version !== 1 || !plan.runId || !Array.isArray(plan.candidates)) throw new Error('Invalid backfill plan');
    const seen = new Set();
    for (const row of plan.candidates) {
        const key = `${row.entity}:${row.id}`;
        if (!tables[row.entity] || !text(row.id) || !/^\d+$/.test(row.version) || !text(row.value)
            || text(row.previousLastEditedBy) || !/^[a-f0-9]{32}$/.test(row.historySignature)
            || !row.evidence?.auditId || seen.has(key)) throw new Error('Invalid backfill candidate');
        seen.add(key);
    }
    const recovered = await recoverReceipt(prisma, plan);
    if (recovered) return recovered;

    // A plan is reviewable input, not authority to invent a value. Re-derive
    // attribution from the database before accepting the proposed value/proof.
    // SQL guards still handle races after this check.
    const fresh = new Map(buildPlan(await readSnapshot(prisma)).candidates.map(row => [`${row.entity}:${row.id}`, row]));
    const eligible = plan.candidates.filter(row => {
        const current = fresh.get(`${row.entity}:${row.id}`);
        if (!current || current.version !== row.version || current.historySignature !== row.historySignature) return false;
        if (current.sourceVersion !== row.sourceVersion || current.sourceHistorySignature !== row.sourceHistorySignature) return false;
        const proof = candidate => JSON.parse(JSON.stringify({ value: candidate.value, evidence: candidate.evidence,
            sourceId: candidate.sourceId, previousLastEditedBy: candidate.previousLastEditedBy }));
        if (!isDeepStrictEqual(proof(row), proof(current))) throw new Error('Backfill plan does not match the recorded audit evidence');
        return true;
    });
    // Master first: its source guards see staging before this transaction fills it.
    const results = await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '45s'"),
        ...Object.keys(tables).map(entity => prisma.$queryRawUnsafe(applySql(entity),
            JSON.stringify(eligible.filter(row => row.entity === entity)), entity, plan.runId)),
    ]);
    const written = results.slice(2).flat();
    // Recover from the committed database ledger even if another process won
    // the same plan's race or the caller lost its connection after COMMIT.
    if (!written.length) {
        const concurrent = await recoverReceipt(prisma, plan);
        if (concurrent) return concurrent;
    }
    written.sort((a, b) => `${a.entity}:${a.id}`.localeCompare(`${b.entity}:${b.id}`));
    return receiptFor(plan, written);
}

function receiptFor(plan, written, recovered = false) {
    const applied = new Set(written.map(row => `${row.entity}:${row.id}`));
    return { runId: plan.runId, appliedAt: new Date().toISOString(), written,
        ...(recovered ? { recovered: true } : {}),
        skippedSincePlan: plan.candidates.filter(row => !applied.has(`${row.entity}:${row.id}`)).map(({ entity, id }) => ({ entity, id })),
        summary: { written: written.length, byEntity: countBy(written, 'entity'), skippedSincePlan: plan.candidates.length - written.length } };
}

async function recoverReceipt(prisma, plan) {
    const rows = await prisma.$queryRawUnsafe(`SELECT entity,"entityId" AS id,
        metadata->>'writtenVersion' AS version,
        metadata->'changes'->0->>'from' AS "previousLastEditedBy",
        metadata->'changes'->0->>'to' AS value
        FROM audit_logs WHERE metadata->>'backfillRunId'=$1
          AND metadata->>'source'='LAST_EDITED_BY_BACKFILL' AND "userEmail"='system:last-edited-by-backfill'`, plan.runId);
    if (!rows.length) return null;
    if (rows.some(row => !tables[row.entity] || !/^\d+$/.test(row.version || ''))) {
        throw new Error('This older backfill has no database recovery revisions; use its saved apply receipt');
    }
    rows.sort((a, b) => `${a.entity}:${a.id}`.localeCompare(`${b.entity}:${b.id}`));
    return receiptFor(plan, rows, true);
}

function rollbackSql(receipt) {
    const quote = value => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
    return '-- Restore only rows untouched since this backfill; retain the audit trail.\nBEGIN;\n'
        + receipt.written.map(row => `UPDATE "${tables[row.entity]}" SET "lastEditedBy"=${quote(row.previousLastEditedBy)} WHERE id::text=${quote(row.id)} AND xmin::text=${quote(row.version)} AND "lastEditedBy"=${quote(row.value)};`).join('\n')
        + '\nCOMMIT;\n';
}

async function verifyPlan(prisma, receipt) {
    for (const [entity, table] of Object.entries(tables)) {
        const rows = receipt.written.filter(row => row.entity === entity);
        const mismatches = await prisma.$queryRawUnsafe(`SELECT p.id FROM jsonb_to_recordset($1::jsonb) AS p(id text,value text)
            LEFT JOIN "${table}" t ON t.id::text=p.id WHERE t.id IS NULL OR t."lastEditedBy" IS DISTINCT FROM p.value`, JSON.stringify(rows));
        if (mismatches.length) throw new Error(`Verification found ${mismatches.length} changed or missing ${entity} rows`);
    }
    const [audit] = await prisma.$queryRawUnsafe(`SELECT count(*)::int total FROM audit_logs WHERE metadata->>'backfillRunId'=$1`, receipt.runId);
    if (audit.total !== receipt.written.length) throw new Error('Backfill audit count mismatch');
    return { rows: receipt.written.length, auditRows: audit.total };
}

module.exports = { buildPlan, readSnapshot, applyPlan, verifyPlan, rollbackSql, recoverReceipt };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--apply')) throw new Error('Usage: node scripts/backfillWarehouseLastEditedBy.js [--apply <plan.json>]');
    const { PrismaClient } = require('@prisma/client');
    const url = new URL(process.env.DATABASE_URL);
    const fingerprint = createHash('sha256').update(`${url.host}${url.pathname}:${url.username}:${url.searchParams.get('schema') || 'public'}`).digest('hex');
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('connect_timeout', '20');
    const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const save = (filename, data) => fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    (async () => {
        if (!args.length) {
            const plan = { ...buildPlan(await readSnapshot(prisma)), databaseFingerprint: fingerprint };
            const filename = path.resolve(__dirname, `../tools/last-edited-by-${plan.runId}.plan.json`);
            save(filename, plan);
            console.log(JSON.stringify({ mode: 'dry-run', ...plan.summary, plan: filename }, null, 2));
        } else {
            const filename = path.resolve(args[1]);
            const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (plan.databaseFingerprint !== fingerprint) throw new Error('Plan targets a different database');
            const receiptPath = filename.replace(/\.json$/, '') + '.applied.json';
            const receipt = fs.existsSync(receiptPath)
                ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                : await applyPlan(prisma, plan);
            if (receipt.runId !== plan.runId) throw new Error('Apply receipt belongs to a different plan');
            // Atomic replacement avoids leaving a partial JSON/SQL artifact if
            // the process stops during a local write. Database audits are the
            // recovery source if it stops before either artifact is saved.
            for (const [target, contents] of [[receiptPath, JSON.stringify(receipt, null, 2) + '\n'],
                [receiptPath + '.rollback.sql', rollbackSql(receipt)]]) {
                const temporary = `${target}.${randomUUID()}.tmp`;
                fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
                fs.renameSync(temporary, target);
            }
            const verification = await verifyPlan(prisma, receipt);
            console.log(JSON.stringify({ mode: 'apply', ...receipt.summary, verification, receipt: receiptPath }, null, 2));
        }
    })().catch(error => {
        console.error(JSON.stringify({ error: error.name, code: error.code,
            message: error.name === 'Error' ? error.message : 'Last editor backfill database operation failed' }));
        process.exitCode = 1;
    }).finally(() => prisma.$disconnect());
}

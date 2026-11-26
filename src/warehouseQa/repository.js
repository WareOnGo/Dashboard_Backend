const { randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { fail } = require('./common');
const { scope, allowedTypes, trimCharacters } = require('./eligibility');
const json = JSON.stringify;
const REVIEW_ACTIONS = ['DECISION', 'ADMIN_FLAGS', 'REMOVE_ADMIN_FLAG', 'REVIEW_CLEAN', 'CONFIRM'];
function eligibleSnapshot(snapshot = Prisma.sql`snapshot`) {
  const text = (field) =>
    Prisma.sql`coalesce(lower(btrim(${snapshot}->'fields'->>${field}, ${trimCharacters})), '')`;
  return Prisma.sql`(${text(scope.type_field)} IN (${Prisma.join(allowedTypes)})
    AND ${text('isBroker')} <> 'yes' AND ${text('warehouseOwnerType')} <> 'broker')`;
}
class QaRepository {
  constructor(db, { maxConcurrency = 2 } = {}) {
    this.db = db;
    this.maxConcurrency = maxConcurrency;
  }
  transaction(fn) {
    return this.db.$transaction((tx) => fn(new QaRepository(tx, { maxConcurrency: this.maxConcurrency })), {
      isolationLevel: 'ReadCommitted',
      timeout: 20000
    });
  }
  async lock(key) {
    await this.db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
  }
  async run(id) {
    const [r] = await this.db.$queryRaw`SELECT * FROM "WarehouseQaRun" WHERE "id"=${id}`;
    return r;
  }
  async runs() {
    return this.db.$queryRaw`SELECT r.*,count(i."warehouseId")::int AS warehouse_count,
    count(*) FILTER (WHERE ${eligibleSnapshot(Prisma.sql`i.snapshot`)})::int AS eligible_warehouse_count,
    count(*) FILTER (WHERE i.status IN ('QUEUED','RUNNING'))::int AS pending,
    count(*) FILTER (WHERE i.status='FAILED')::int AS failed
    FROM "WarehouseQaRun" r LEFT JOIN "WarehouseQaItem" i ON i."runId"=r.id GROUP BY r.id
    ORDER BY (count(*) FILTER (WHERE i.status IN ('QUEUED','RUNNING'))>0) DESC,r."createdAt" DESC LIMIT 100`;
  }
  async items(runId) {
    return this.db.$queryRaw`SELECT * FROM "WarehouseQaItem" WHERE "runId"=${runId} ORDER BY "warehouseId"`;
  }
  async activeItems(warehouseIds, executionHash, { nativeHandoff = false } = {}) {
    if (!warehouseIds.length) return [];
    // An assigned QA item remains history after its ordinary employee review
    // closes. Missing handoff records fail closed rather than admitting a copy.
    const assignmentOpen = nativeHandoff
      ? Prisma.sql`NOT EXISTS (SELECT 1 FROM "WarehouseFieldReview" review
          WHERE review.id=i.result->'handoff'->>'review_id' AND review."closedAt" IS NOT NULL)`
      : Prisma.sql`TRUE`;
    const queued = await this.db.$queryRaw(Prisma.sql`SELECT DISTINCT ON (i."warehouseId")
      i."warehouseId",i."runId",i.status,i.result->>'stage' AS stage
      FROM "WarehouseQaItem" i JOIN "WarehouseQaRun" r ON r.id=i."runId"
      WHERE i."warehouseId" IN (${Prisma.join(warehouseIds)}) AND (
        i.status IN ('QUEUED','RUNNING') OR
        (${eligibleSnapshot(Prisma.sql`i.snapshot`)} AND (
          (i.result->>'stage'='AI_REVIEW' AND r.metadata->>'execution_hash'=${executionHash}) OR
          i.result->>'stage'='ASSIGNED_LOCAL' OR
          (i.result->>'stage'='ASSIGNED' AND ${assignmentOpen})
        ))
      ) ORDER BY i."warehouseId",i."createdAt" DESC,i."runId" DESC`);
    const reviews = nativeHandoff
      ? await this.db.warehouseFieldReview.findMany({
          where: { warehouseId: { in: warehouseIds }, closedAt: null },
          select: { warehouseId: true }
        })
      : [];
    return [...new Map([...reviews, ...queued].map((item) => [item.warehouseId, item])).values()].sort(
      (a, b) => a.warehouseId - b.warehouseId
    );
  }
  async inbox() {
    // Keep unresolved adjudications visible across batches. The run ID remains
    // attached to each row, so concurrent rechecks cannot overwrite decisions.
    return this.db.$queryRaw`SELECT * FROM "WarehouseQaItem" WHERE result IS NOT NULL
      AND ${eligibleSnapshot()} AND result->>'stage'='AI_REVIEW' ORDER BY "createdAt" DESC,"warehouseId" LIMIT 1000`;
  }
  reviewWhere({ runId = 'inbox', stage = 'AI_REVIEW', search = '', scopeOnly = true, reviewerEmail } = {}) {
    const conditions = [Prisma.sql`result IS NOT NULL`];
    if (scopeOnly) conditions.push(eligibleSnapshot());
    if (runId !== 'inbox') conditions.push(Prisma.sql`"runId"=${runId}`);
    if (stage !== 'all') conditions.push(Prisma.sql`result->>'stage'=${stage}`);
    if (reviewerEmail) {
      const confirmedStage = ['ASSIGNED_LOCAL', 'ASSIGNED', 'DISMISSED', 'STALE'].includes(stage);
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "WarehouseQaEvent" e
        WHERE e."runId" = "WarehouseQaItem"."runId" AND e."warehouseId" = "WarehouseQaItem"."warehouseId"
          AND lower(btrim(e.actor->>'email')) = ${reviewerEmail.trim().toLowerCase()}
          AND ${confirmedStage
            ? Prisma.sql`e.action = 'CONFIRM' AND e.response->>'stage' = ${stage}`
            : Prisma.sql`e.action IN (${Prisma.join(REVIEW_ACTIONS)})`}
      )`);
    }
    if (search) {
      const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
      conditions.push(
        Prisma.sql`("warehouseId"::text ILIKE ${pattern} OR result->>'city' ILIKE ${pattern} OR result->>'warehouse_type' ILIKE ${pattern})`
      );
    }
    return Prisma.join(conditions, ' AND ');
  }
  async reviewers({ runId = 'inbox' } = {}) {
    return this.db.$queryRaw(Prisma.sql`
      SELECT email, name FROM (
        SELECT DISTINCT ON (lower(btrim(e.actor->>'email')))
          lower(btrim(e.actor->>'email')) AS email,
          coalesce(nullif(e.actor->>'name', ''), e.actor->>'email') AS name
        FROM "WarehouseQaEvent" e
        JOIN "WarehouseQaItem" i ON i."runId" = e."runId" AND i."warehouseId" = e."warehouseId"
        WHERE i.result IS NOT NULL AND ${eligibleSnapshot(Prisma.sql`i.snapshot`)}
          AND e.action IN (${Prisma.join(REVIEW_ACTIONS)}) AND coalesce(btrim(e.actor->>'email'), '') <> ''
          ${runId !== 'inbox' ? Prisma.sql`AND i."runId" = ${runId}` : Prisma.empty}
        ORDER BY lower(btrim(e.actor->>'email')), e."createdAt" DESC, e.id DESC
      ) people ORDER BY name, email`);
  }
  async reviewPage(options = {}) {
    const { page = 1, limit = 20 } = options;
    const where = this.reviewWhere(options);
    return this.db.$queryRaw(Prisma.sql`SELECT * FROM "WarehouseQaItem" WHERE ${where}
      ORDER BY "createdAt" DESC,"runId","warehouseId" LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
  }
  async reviewStats(options = {}) {
    const where = this.reviewWhere(options);
    const [stats] = await this.db.$queryRaw(Prisma.sql`WITH selected AS (
      SELECT "warehouseId",result FROM "WarehouseQaItem" WHERE ${where}
    ), candidates AS (SELECT c FROM selected CROSS JOIN LATERAL jsonb_array_elements(result->'candidates') c),
    clean AS (SELECT c.value FROM selected CROSS JOIN LATERAL jsonb_each(coalesce(result->'clean_reviews','{}'::jsonb)) c)
    SELECT (SELECT count(*)::int FROM selected) AS total,
      (SELECT count(DISTINCT "warehouseId")::int FROM selected) AS warehouses,
      (SELECT count(*)::int FROM candidates) AS flagged_columns,
      (SELECT count(*)::int FROM clean WHERE value->>'covered'='true') AS reviewed_clean_columns,
      (SELECT jsonb_build_object(
        'machine_columns',count(*) FILTER (WHERE c->>'source'='MACHINE'),
        'pending',count(*) FILTER (WHERE c->>'source'='MACHINE' AND c->>'decision'='PENDING'),
        'accepted',count(*) FILTER (WHERE c->>'source'='MACHINE' AND c->>'decision'='APPROVED'),
        'rejected_incorrect',count(*) FILTER (WHERE c->>'source'='MACHINE' AND c->>'decision'='REJECTED' AND c->>'decision_reason'='INCORRECT'),
        'rejected_other',count(*) FILTER (WHERE c->>'source'='MACHINE' AND c->>'decision'='REJECTED' AND c->>'decision_reason'<>'INCORRECT'),
        'admin_found_misses',count(*) FILTER (WHERE c->>'source'='ADMIN' AND c->>'evaluation_label'='ADMIN_FOUND_MISS'),
        'coverage_gaps',count(*) FILTER (WHERE c->>'source'='ADMIN' AND c->>'evaluation_label'='COVERAGE_GAP')
      ) FROM candidates) AS metrics`);
    return stats;
  }
  async item(runId, whid, lock = false) {
    const rows = lock
      ? await this.db
          .$queryRaw`SELECT * FROM "WarehouseQaItem" WHERE "runId"=${runId} AND "warehouseId"=${whid} FOR UPDATE`
      : await this.db
          .$queryRaw`SELECT * FROM "WarehouseQaItem" WHERE "runId"=${runId} AND "warehouseId"=${whid}`;
    if (!rows.length) fail(404, 'QA_ITEM_NOT_FOUND', 'Warehouse is not in this QA run.');
    return rows[0];
  }
  async insertRun(id, requestHash, actor, metadata) {
    await this.db
      .$executeRaw`INSERT INTO "WarehouseQaRun" (id,"requestHash",actor,metadata) VALUES (${id},${requestHash},${json(actor)}::jsonb,${json(metadata)}::jsonb)`;
  }
  async insertItem(runId, row, { dedupKey = null, result = null, status = 'QUEUED', artifact = null } = {}) {
    return this.db
      .$executeRaw`INSERT INTO "WarehouseQaItem" ("runId","warehouseId",status,snapshot,result,artifact,"dedupKey")
      VALUES (${runId},${row.warehouse_id},${status},${json(row)}::jsonb,${result ? json(result) : null}::jsonb,${artifact ? json(artifact) : null}::jsonb,${dedupKey})
      ON CONFLICT ("dedupKey") DO NOTHING`;
  }
  async saveResult(runId, whid, result) {
    await this.db
      .$executeRaw`UPDATE "WarehouseQaItem" SET result=${json(result)}::jsonb,"updatedAt"=now() WHERE "runId"=${runId} AND "warehouseId"=${whid}`;
  }
  async supersedeUntouchedReviews(warehouseId, runBy) {
    // Caller holds the per-warehouse transaction lock. Keep the newest successful
    // evaluation active even when two workers finish in the opposite order.
    const [latest] = await this.db.$queryRaw`SELECT "runId","createdAt",snapshot FROM "WarehouseQaItem"
      WHERE "warehouseId"=${warehouseId} AND status='COMPLETED' AND ${eligibleSnapshot()}
      AND result->'coverage'->>'ai_status'='COMPLETED'
      AND result->>'stage' IN ('AI_REVIEW','ASSIGNED_LOCAL','ASSIGNED','DISMISSED')
      ORDER BY "createdAt" DESC,"runId" DESC LIMIT 1`;
    if (!latest) return;
    const older = await this.db.$queryRaw`SELECT "runId",result FROM "WarehouseQaItem"
      WHERE "warehouseId"=${warehouseId} AND ("createdAt","runId") < (${latest.createdAt},${latest.runId})
      AND status IN ('COMPLETED','FAILED') AND result->>'stage'='AI_REVIEW' AND result->>'version'='0'
      AND ${eligibleSnapshot()}
      AND coalesce(result->'clean_reviews','{}'::jsonb)='{}'::jsonb
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result->'candidates') c
        WHERE c->>'source' IS DISTINCT FROM 'MACHINE' OR c->>'decision' IS DISTINCT FROM 'PENDING'
        OR coalesce(c->>'admin_note','')<>'' OR coalesce(c->>'adjudicated_by','')<>'')
      ORDER BY "createdAt","runId" FOR UPDATE`;
    for (const previous of older) {
      const at = new Date().toISOString();
      const updated = {
        ...previous.result,
        stage: 'SUPERSEDED',
        version: previous.result.version + 1,
        last_modified_at: at,
        superseded_by: { run_id: latest.runId, snapshot_id: latest.snapshot.snapshot_id, at }
      };
      await this.saveResult(previous.runId, warehouseId, updated);
      await this.event({
        runId: previous.runId,
        warehouseId,
        actor: { id: 'qa-engine', name: 'Warehouse QA engine' },
        action: 'QA_REVIEW_SUPERSEDED',
        payload: {
          scope: 'PER_WHID',
          runBy,
          replacement_run_id: latest.runId,
          version_before: previous.result.version,
          version_after: updated.version,
          warehouse_writes: 0
        }
      });
    }
  }
  async requeue(runId, whid, result) {
    await this.db.$executeRaw`UPDATE "WarehouseQaItem" SET status='QUEUED',attempts=0,
      "leaseToken"=NULL,"leaseUntil"=NULL,error=NULL,"availableAt"=now(),"updatedAt"=now(),
      result=${json(result)}::jsonb WHERE "runId"=${runId} AND "warehouseId"=${whid}`;
  }
  async events(runId, whid) {
    return this.db
      .$queryRaw`SELECT id,"runId","warehouseId",actor,action,payload,"createdAt" FROM "WarehouseQaEvent" WHERE "runId"=${runId} AND "warehouseId"=${whid} ORDER BY "createdAt" DESC,id`;
  }
  async request(id) {
    const [r] = await this.db
      .$queryRaw`SELECT "requestHash",response FROM "WarehouseQaEvent" WHERE "requestId"=${id}`;
    return r;
  }
  async event({
    runId,
    warehouseId = null,
    actor,
    action,
    requestId = null,
    requestHash = null,
    payload,
    response = null
  }) {
    await this.db
      .$executeRaw`INSERT INTO "WarehouseQaEvent" (id,"runId","warehouseId",actor,action,"requestId","requestHash",payload,response)
      VALUES (${randomUUID()},${runId},${warehouseId},${json(actor)}::jsonb,${action},${requestId},${requestHash},${json(payload)}::jsonb,${response ? json(response) : null}::jsonb)`;
  }
  async cache(key) {
    const [r] = await this.db.$queryRaw`SELECT data FROM "WarehouseQaCache" WHERE key=${key}`;
    return r?.data;
  }
  async caches(keys) {
    if (!keys.length) return new Map();
    const rows = await this.db.$queryRaw(
      Prisma.sql`SELECT key,data FROM "WarehouseQaCache" WHERE key IN (${Prisma.join(keys)})`
    );
    return new Map(rows.map((row) => [row.key, row.data]));
  }
  async eventsForRuns(ids) {
    if (!ids.length) return [];
    return this.db
      .$queryRaw(Prisma.sql`SELECT id,"runId","warehouseId",actor,action,payload,"createdAt" FROM "WarehouseQaEvent"
      WHERE "runId" IN (${Prisma.join(ids)}) AND "warehouseId" IS NOT NULL ORDER BY "createdAt" DESC,id`);
  }
  async putCache(key, data) {
    await this.db
      .$executeRaw`INSERT INTO "WarehouseQaCache" (key,data) VALUES (${key},${json(data)}::jsonb) ON CONFLICT (key) DO NOTHING`;
  }
  async cursor(id) {
    const [r] = await this.db.$queryRaw`SELECT data FROM "WarehouseQaCursor" WHERE id=${id}`;
    return r?.data;
  }
  async setCursor(id, data) {
    await this.db
      .$executeRaw`INSERT INTO "WarehouseQaCursor" (id,data) VALUES (${id},${json(data)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=excluded.data,"updatedAt"=now()`;
  }
  async claim() {
    // Serialize admission across replicas. Use a second statement after the lock
    // so READ COMMITTED observes claims made by the previous lock holder.
    return this.transaction(async (repo) => {
      await repo.lock('qa-inference-capacity');
      const [running] = await repo.db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaItem"
        WHERE status='RUNNING' AND "leaseUntil">=now()`;
      if (running.count >= this.maxConcurrency) return undefined;
      return repo.claimAvailable();
    });
  }
  async claimAvailable() {
    const token = randomUUID();
    const [r] = await this.db.$queryRaw`WITH next AS (
      SELECT "runId","warehouseId" FROM "WarehouseQaItem"
      WHERE (status='QUEUED' AND "availableAt"<=now()) OR (status='RUNNING' AND "leaseUntil"<now())
      ORDER BY "availableAt","createdAt","warehouseId" FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE "WarehouseQaItem" i SET status='RUNNING',attempts=attempts+1,"leaseToken"=${token},
      "leaseUntil"=now()+interval '2 minutes',"updatedAt"=now()
      FROM next WHERE i."runId"=next."runId" AND i."warehouseId"=next."warehouseId" RETURNING i.*`;
    return r;
  }
  async finish(item, { result, artifact, error = null, retry = false }) {
    // The token fences a worker that returns after its lease was reclaimed.
    const count = await this.db
      .$executeRaw`UPDATE "WarehouseQaItem" SET status=${retry ? 'QUEUED' : error ? 'FAILED' : 'COMPLETED'},
      result=coalesce(${result ? json(result) : null}::jsonb,result),artifact=${artifact ? json(artifact) : null}::jsonb,error=${error},
      "leaseToken"=NULL,"leaseUntil"=NULL,"availableAt"=now()+interval '10 seconds',"updatedAt"=now()
      WHERE "runId"=${item.runId} AND "warehouseId"=${item.warehouseId} AND "leaseToken"=${item.leaseToken}`;
    return count === 1;
  }
  async skip(item) {
    // Scope changes can exclude work queued by an older policy. Preserve any
    // historical result/artifact, and fence this update with the worker lease.
    const count = await this.db.$executeRaw`UPDATE "WarehouseQaItem" SET status='SKIPPED',error=NULL,
      "leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
      WHERE "runId"=${item.runId} AND "warehouseId"=${item.warehouseId} AND "leaseToken"=${item.leaseToken}`;
    return count === 1;
  }
  async queueHealth() {
    const [state] = await this.db.$queryRaw`SELECT
      count(*) FILTER (WHERE status='QUEUED')::int AS queued,
      count(*) FILTER (WHERE status='RUNNING')::int AS running,
      count(*) FILTER (WHERE status='FAILED' AND result->>'stage'='AI_REVIEW' AND ${eligibleSnapshot()})::int AS failed,
      count(*) FILTER (WHERE status='RUNNING' AND "leaseUntil"<now())::int AS expired_leases,
      coalesce(extract(epoch FROM now()-min("createdAt") FILTER (WHERE status IN ('QUEUED','RUNNING'))),0)::float8 AS oldest_pending_seconds,
      count(*) FILTER (WHERE error='QA_EXECUTION_CHANGED' AND result->>'stage'='AI_REVIEW' AND ${eligibleSnapshot()})::int AS policy_mismatches
      FROM "WarehouseQaItem"`;
    return { ...state, max_concurrency: this.maxConcurrency };
  }
}
module.exports = { QaRepository };

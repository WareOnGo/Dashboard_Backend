const engine = require('./engine');
const { randomUUID } = require('node:crypto');
const { MODEL } = require('./inference');
const { hash, clone, fail } = require('./common');
const { exclusion, forwardKey } = require('./source');
const { applyDecision, metrics } = require('./workflow');
const { candidateComment } = require('./reviewComments');
const { requireEligible } = require('./eligibility');
const { execution, executionHash } = require('./execution');
const { freshness, changedFields } = require('./freshness');

const actorFor = (user) => ({
  id: String(user.id || user.email),
  name: user.name || user.email || String(user.id),
  email: user.email || null
});
const describe = (run) => ({
  ...run.metadata,
  id: run.id,
  warehouse_count: run.warehouse_count,
  eligible_warehouse_count: run.eligible_warehouse_count ?? run.warehouse_count,
  generated_at_utc: run.metadata.generated_at_utc || run.createdAt.toISOString(),
  status: run.pending ? 'RUNNING' : run.failed ? 'PARTIAL' : 'COMPLETED'
});
const resultFor = (item) => ({
  ...item.result,
  eligible_for_review: !exclusion(item.snapshot),
  scope_exclusion: exclusion(item.snapshot),
  candidates: item.result.candidates.map((candidate) => ({
    ...candidate,
    suggested_note: candidateComment(candidate, item.result.fields)
  })),
  coverage: {
    ...item.result.coverage,
    evaluation_status:
      item.result.coverage.ai_status === 'POLICY_CHANGED'
        ? 'NOT_EVALUATED'
        : item.result.checks.some((check) => check.verdict === 'NOT_EVALUATED' || check.missing_inputs.length)
          ? 'PARTIAL'
          : 'COMPLETE'
  },
  run_id: item.runId,
  source_captured_at_utc: item.snapshot.source_captured_at_utc || null,
  run_created_at: item.createdAt.toISOString()
});

class QaService {
  constructor({
    repository,
    source,
    worker,
    runBy = 'Raghav',
    forwardStart,
    localStorage = source?.mode === 'pilot',
    fieldReviews = null,
    handoffMode = 'staged',
    pilotAssignees = []
  }) {
    this.repository = repository;
    this.source = source;
    this.worker = worker;
    this.runBy = runBy;
    this.forwardStart = forwardStart;
    this.localStorage = localStorage;
    this.fieldReviews = fieldReviews;
    this.handoffMode = handoffMode;
    this.pilotAssignees = pilotAssignees;
    if (
      handoffMode === 'field-review' &&
      (source?.mode !== 'warehouse' || !fieldReviews || repository.db !== fieldReviews.db)
    )
      fail(503, 'QA_CONFIGURATION', 'Employee handoff must share the field-review database transaction.');
  }

  config() {
    return {
      profile: engine.profile,
      profile_hash: engine.profileHash,
      registry: Object.values(engine.registry),
      assignees: this.source.mode === 'pilot' ? this.pilotAssignees : [],
      environment: this.localStorage ? 'LOCAL_SANDBOX' : 'STAGED_REVIEW',
      source: this.source.mode,
      handoff_mode: this.handoffMode === 'field-review' ? 'FIELD_REVIEW' : 'STAGED_ONLY',
      execution_hash: executionHash,
      warehouse_writes: 0,
      model: MODEL
    };
  }

  async runs() {
    const runs = (await this.repository.runs()).filter((run) => run.warehouse_count > 0).map(describe);
    const stats = await this.repository.reviewStats();
    return [
      {
        id: 'inbox',
        status: 'INBOX',
        warehouse_count: stats.total,
        model: MODEL,
        generated_at_utc: new Date().toISOString()
      },
      ...runs
    ];
  }

  async summary() {
    const stats = await this.repository.reviewStats();
    return {
      run_id: 'inbox',
      pending_warehouses: stats.warehouses,
      pending_reviews: stats.total,
      flagged_columns: stats.flagged_columns
    };
  }

  async health() {
    const queue = await this.repository.queueHealth();
    const configured = !!this.worker.inference?.apiKey?.();
    return {
      ready:
        configured &&
        !this.worker.stopping &&
        queue.failed === 0 &&
        queue.expired_leases === 0 &&
        queue.oldest_pending_seconds < 3600,
      model_configured: configured,
      worker_stopping: !!this.worker.stopping,
      handoff_mode: this.handoffMode,
      execution_hash: executionHash,
      queue
    };
  }

  async drain() {
    await this.worker.drain();
    return this.health();
  }

  async status(id) {
    const run = await this.repository.run(id);
    if (!run) fail(404, 'QA_RUN_NOT_FOUND', 'QA run not found.');
    const items = await this.repository.items(id);
    const counts = Object.fromEntries(
      ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'].map((status) => [
        status,
        items.filter((item) => item.status === status).length
      ])
    );
    return {
      ...describe({
        ...run,
        warehouse_count: items.length,
        eligible_warehouse_count: items.filter((item) => !exclusion(item.snapshot)).length,
        pending: counts.QUEUED + counts.RUNNING,
        failed: counts.FAILED
      }),
      counts
    };
  }

  async processRun(id) {
    const current = await this.status(id);
    if (current.counts.QUEUED || current.counts.RUNNING) {
      // Keep processing inside an authenticated HTTP request. Manual QA must
      // also work on hosts that suspend background CPU between requests.
      await this.worker.drain();
      return this.status(id);
    }
    return current;
  }

  async list(id, query = {}) {
    if (id !== 'inbox' && !(await this.repository.run(id)))
      fail(404, 'QA_RUN_NOT_FOUND', 'QA run not found.');
    const options = { page: 1, limit: 20, stage: 'AI_REVIEW', search: '', ...query, runId: id };
    const [items, stats] = await Promise.all([
      this.repository.reviewPage(options),
      this.repository.reviewStats(options)
    ]);
    const counts = { ...stats.metrics, reviewed_clean_columns: stats.reviewed_clean_columns };
    const { accepted, rejected_incorrect: incorrect, admin_found_misses: missed } = counts;
    return {
      warehouses: items.map(resultFor),
      total: stats.total,
      flagged_columns: stats.flagged_columns,
      page: options.page,
      limit: options.limit,
      metrics: {
        ...counts,
        reviewed_precision: accepted + incorrect ? accepted / (accepted + incorrect) : null,
        reviewed_recall: accepted + missed ? accepted / (accepted + missed) : null,
        limitations: metrics([]).limitations
      }
    };
  }

  async reviewSetup(item, user, tx = null) {
    if (this.source?.mode === 'pilot') return { assignees: this.pilotAssignees, activeFields: [] };
    if (!this.fieldReviews) return { assignees: [], activeFields: [], unavailable: true };
    try {
      return tx
        ? await this.fieldReviews.setupTx(tx, item.warehouseId, user)
        : await this.source.read((client) => this.fieldReviews.setupTx(client, item.warehouseId, user));
    } catch (error) {
      if (error.code === 'WAREHOUSE_NOT_FOUND') return { assignees: [], activeFields: [], unavailable: true };
      throw error;
    }
  }

  async detail(id, whid, user) {
    const item = await this.repository.item(id, whid);
    if (!item.result) fail(409, 'QA_EVALUATION_PENDING', 'Evaluation has not finished.');
    const events = (await this.repository.events(id, whid)).map((event) => ({
      ...event,
      actor: event.actor.name,
      created_at: event.createdAt
    }));
    const assignment = await this.reviewSetup(item, user);
    const run = await this.repository.run(id);
    return {
      ...resultFor(item),
      events,
      assignment,
      execution_current: run?.metadata.execution_hash === executionHash
    };
  }

  async export(id) {
    const stats = await this.repository.reviewStats({ runId: id, stage: 'all', scopeOnly: false });
    if (stats.total > 1000)
      fail(413, 'QA_EXPORT_TOO_LARGE', 'Export an individual QA run to keep the download bounded.');
    const data = await this.list(id, { stage: 'all', limit: 1000, scopeOnly: false });
    const events = await this.repository.eventsForRuns([
      ...new Set(data.warehouses.map((row) => row.run_id))
    ]);
    const byItem = new Map();
    for (const event of events) {
      const key = event.runId + ':' + event.warehouseId;
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key).push({ ...event, actor: event.actor.name, created_at: event.createdAt });
    }
    return {
      ...data,
      exported_at: new Date().toISOString(),
      profile: engine.profile,
      warehouses: data.warehouses.map((row) => ({
        ...row,
        events: byItem.get(row.run_id + ':' + row.warehouse_id) || []
      }))
    };
  }

  async enqueue(repo, body, actor, rows, { forward = false, window = null, hasMore = false } = {}) {
    const requestHash = hash({ body, actor });
    const metadata = {
      model: MODEL,
      mode: forward ? 'NEW_SUBMISSION' : body.mode || 'BACKFILL',
      profile: engine.profile,
      profile_hash: engine.profileHash,
      execution,
      execution_hash: executionHash,
      source: this.source.mode,
      source_captured_at_utc: rows[0]?.source_captured_at_utc || null,
      runBy: this.runBy,
      executedBy: actor,
      warehouse_writes: 0,
      forward_window: window,
      forward_has_more: hasMore
    };
    await repo.insertRun(body.request_id, requestHash, actor, metadata);
    let queued = 0,
      skipped = 0;
    for (const row of rows) {
      const reason = exclusion(row);
      const inserted = await repo.insertItem(body.request_id, row, {
        status: reason ? 'SKIPPED' : 'QUEUED',
        dedupKey: forward ? forwardKey(row) : null
      });
      if (!inserted) continue;
      if (reason) skipped++;
      else queued++;
      await repo.event({
        runId: body.request_id,
        warehouseId: row.warehouse_id,
        actor,
        action: reason ? 'QA_SKIPPED' : 'QA_QUEUED',
        payload: {
          scope: 'PER_WHID',
          reason,
          runBy: this.runBy,
          executedBy: actor,
          snapshot_id: row.snapshot_id,
          warehouse_writes: 0
        }
      });
    }
    return { id: body.request_id, status: queued ? 'QUEUED' : 'COMPLETED', queued, skipped };
  }

  async create(body, user) {
    const actor = actorFor(user);
    const result = await this.repository.transaction(async (repo) => {
      await repo.lock('qa-request:' + body.request_id);
      const prior = await repo.run(body.request_id);
      if (prior) {
        if (prior.requestHash !== hash({ body, actor }))
          fail(409, 'QA_IDEMPOTENCY_CONFLICT', 'Request ID was already used for a different operation.');
        return { id: prior.id, status: 'QUEUED', replayed: true };
      }
      const rows = await this.source.load(body.warehouse_ids, body.mode);
      return this.enqueue(repo, body, actor, rows);
    });
    void this.worker.drain();
    return result;
  }

  async cron(body) {
    const actor = { id: 'warehouse-qa-cron', name: 'Warehouse QA cron', email: null };
    if (body.warehouse_ids) {
      const result = await this.create(
        { request_id: body.request_id, warehouse_ids: body.warehouse_ids, mode: 'BACKFILL', model: MODEL },
        actor
      );
      await this.worker.drain();
      return this.status(result.id);
    }
    const result = await this.repository.transaction(async (repo) => {
      await repo.lock('qa-request:' + body.request_id);
      await repo.lock('qa-forward-scan');
      const previous = await repo.run(body.request_id);
      if (previous) {
        if (previous.requestHash !== hash({ body, actor }))
          fail(409, 'QA_IDEMPOTENCY_CONFLICT', 'Request ID was already used for a different operation.');
        // Page outcome belongs to this invocation, not to a cursor that another
        // caller may have advanced after a lost response.
        const hasMore = previous.metadata.forward_has_more;
        if (typeof hasMore !== 'boolean')
          fail(
            409,
            'QA_LEGACY_CRON_REPLAY',
            'This older cron run has no saved page outcome. Continue with a new request ID.'
          );
        return { id: previous.id, has_more: hasMore };
      }
      const key = 'forward:' + engine.profileHash;
      const cursor = await repo.cursor(key);
      const start = cursor?.initial_start || body.since || this.forwardStart;
      if (!start || !Number.isFinite(Date.parse(start)))
        fail(
          400,
          'QA_FORWARD_START_REQUIRED',
          'Set since for the first forward scan or configure AI_QA_FORWARD_START_AT.'
        );
      if (cursor && body.since && new Date(body.since).toISOString() !== cursor.initial_start)
        fail(
          409,
          'QA_CURSOR_ALREADY_STARTED',
          'The forward cursor is already established. Use explicit warehouse IDs for backfill.'
        );
      const end = new Date(Date.now() - 120000).toISOString();
      if (Date.parse(start) >= Date.parse(end))
        fail(
          400,
          'QA_INVALID_FORWARD_START',
          'Forward scan start must precede the two-minute settling window.'
        );
      const window = cursor?.window || {
        start: cursor?.completed_until
          ? new Date(Math.max(Date.parse(start), Date.parse(cursor.completed_until) - 3600000)).toISOString()
          : start,
        end,
        after: null
      };
      const selected = await this.source.scan(window, body.limit);
      const rows = selected.length
        ? await this.source.load(
            selected.map((row) => row.id),
            'NEW_SUBMISSION'
          )
        : [];
      const last = selected.at(-1);
      const hasMore = selected.length === body.limit;
      const run = await this.enqueue(repo, body, actor, rows, { forward: true, window, hasMore });
      await repo.setCursor(key, {
        initial_start: new Date(start).toISOString(),
        completed_until: hasMore ? cursor?.completed_until || null : window.end,
        window: hasMore
          ? { ...window, after: { createdAt: last.createdAt.toISOString(), id: last.id } }
          : null
      });
      return { ...run, has_more: hasMore };
    });
    await this.worker.drain();
    return { ...(await this.status(result.id)), has_more: result.has_more ?? false };
  }

  async confirm(repo, item, body, user, actor) {
    const { runId, warehouseId: whid } = item;
    if ((await repo.run(runId)).metadata.execution_hash !== executionHash)
      fail(409, 'QA_EXECUTION_CHANGED', 'The QA policy or engine changed. Run a new batch before assigning.');
    // Live approval reads evidence and creates the ordinary review under the
    // same warehouse locks. Staged mode only reads its separate source.
    const live = this.handoffMode === 'field-review';
    let current = null;
    if (live) {
      const reviewer = await this.fieldReviews.actor(repo.db, user, true);
      if (!reviewer.isAdmin)
        fail(403, 'QA_ADMIN_REQUIRED', 'Admin access is required to approve AI reviews.');
      try {
        await this.fieldReviews.warehouse(repo.db, whid, true);
        [current] = await this.source.loadTx(repo.db, [whid], item.snapshot.mode);
      } catch (error) {
        if (!['WAREHOUSE_NOT_FOUND', 'QA_WAREHOUSE_NOT_FOUND'].includes(error.code)) throw error;
      }
    } else {
      try {
        [current] = await this.source.load([whid], item.snapshot.mode);
      } catch (error) {
        if (error.code !== 'QA_WAREHOUSE_NOT_FOUND') throw error;
      }
    }
    const setup = await this.reviewSetup(item, user, live ? repo.db : null);
    const updated = !current
      ? {
          ...clone(item.result),
          version: item.result.version + 1,
          last_modified_at: new Date().toISOString()
        }
      : applyDecision(clone(item.result), 'confirm', body, actor, { assignees: setup.assignees || [] });
    const state = freshness(item.snapshot, current, updated);
    if (!state.current) {
      updated.stage = 'STALE';
      updated.handoff = null;
      updated.staleness = state;
      if (current) {
        const changed = new Set(changedFields(item.snapshot, current));
        const recheck = {
          ...current,
          mode: 'RECHECK',
          field_provenance: Object.fromEntries(
            Object.keys(current.fields).map((key) => [
              key,
              changed.has(key) ? 'NEW_VALUE' : 'UNCHANGED_LEGACY'
            ])
          )
        };
        const next = { request_id: randomUUID(), warehouse_ids: [whid], mode: 'RECHECK', model: MODEL };
        await this.enqueue(repo, next, actor, [recheck]);
        updated.recheck_run_id = next.request_id;
      }
    } else if (live && updated.handoff) {
      const created = await this.fieldReviews.createInTransaction(repo.db, updated.handoff.payload, user, {
        sources: Object.fromEntries(
          updated.candidates
            .filter((candidate) => candidate.decision === 'APPROVED')
            .map((candidate) => [candidate.field_key, candidate.source === 'MACHINE' ? 'AI' : 'HUMAN'])
        ),
        evaluation: {
          run_id: runId,
          snapshot_id: item.snapshot.snapshot_id,
          execution_hash: executionHash,
          runBy: this.runBy,
          executedBy: actor
        }
      });
      updated.stage = 'ASSIGNED';
      updated.handoff = {
        ...updated.handoff,
        status: 'CREATED',
        review_id: created.id,
        field_review_created: true
      };
      delete updated.handoff.production_request_sent;
    }
    return updated;
  }

  async mutate(runId, whid, operation, body, user) {
    const actor = actorFor(user);
    const requestHash = hash({ runId, whid, operation, body, actor });
    const result = await this.repository.transaction(async (repo) => {
      await repo.lock('qa-review-request:' + body.request_id);
      const prior = await repo.request(body.request_id);
      if (prior) {
        if (prior.requestHash !== requestHash)
          fail(409, 'QA_IDEMPOTENCY_CONFLICT', 'Request ID was already used for a different operation.');
        return prior.response;
      }
      const item = await repo.item(runId, whid, true);
      requireEligible(item.snapshot);
      if (!item.result || ['QUEUED', 'RUNNING'].includes(item.status))
        fail(409, 'QA_EVALUATION_PENDING', 'Wait for evaluation to finish before reviewing.');
      if (item.result.stage !== 'AI_REVIEW')
        fail(
          409,
          'QA_REVIEW_CONFLICT',
          'This review is no longer awaiting a decision. Refresh before continuing.'
        );
      if (item.result.version !== body.expected_version)
        fail(409, 'QA_REVIEW_CONFLICT', 'Review changed. Refresh before deciding.');
      let updated;
      if (operation === 'retry') {
        if ((await repo.run(runId)).metadata.execution_hash !== executionHash)
          fail(
            409,
            'QA_EXECUTION_CHANGED',
            'The QA policy or engine changed. Run a new batch for this warehouse.'
          );
        if (item.status !== 'FAILED' || item.result.version !== body.expected_version)
          fail(409, 'QA_REVIEW_CONFLICT', 'Only the current failed evaluation can be retried.');
        if (
          item.result.candidates.some((c) => c.source === 'ADMIN' || c.decision !== 'PENDING') ||
          Object.keys(item.result.clean_reviews || {}).length
        )
          fail(
            409,
            'QA_REVIEW_CONFLICT',
            'This older failed evaluation already has decisions. Run a new batch to preserve them.'
          );
        updated = clone(item.result);
        updated.version++;
        updated.coverage.ai_status = 'RETRYING';
        await repo.requeue(runId, whid, updated);
      } else {
        if (item.status === 'FAILED')
          fail(409, 'QA_EVALUATION_FAILED', 'Retry the failed evaluation before reviewing its columns.');
        updated =
          operation === 'confirm'
            ? await this.confirm(repo, item, body, user, actor)
            : applyDecision(clone(item.result), operation, body, actor);
        await repo.saveResult(runId, whid, updated);
      }
      await repo.event({
        runId,
        warehouseId: whid,
        actor,
        action: operation.toUpperCase().replaceAll('-', '_'),
        requestId: body.request_id,
        requestHash,
        payload: {
          scope: 'PER_WHID',
          runBy: this.runBy,
          executedBy: actor,
          version_before: item.result.version,
          version_after: updated.version,
          operation: body,
          warehouse_writes: 0
        },
        response: updated
      });
      return updated;
    });
    if (operation === 'retry' || result.recheck_run_id) void this.worker.drain();
    if (result.stage === 'STALE')
      fail(
        409,
        'QA_SOURCE_CHANGED',
        result.recheck_run_id
          ? 'Warehouse evidence changed. Your review was preserved and a fresh evaluation was queued.'
          : 'This warehouse no longer exists. Its review history was preserved; no assignment was created.'
      );
    return result;
  }
}
module.exports = { QaService, actorFor };

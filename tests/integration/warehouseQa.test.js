const { randomUUID, randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrate } = require('../../scripts/migrateWarehouseQa');
const { QaRepository } = require('../../src/warehouseQa/repository');
const { QaService } = require('../../src/warehouseQa/service');
const { QaWorker } = require('../../src/warehouseQa/worker');
const { QaSource } = require('../../src/warehouseQa/source');
const { QaError } = require('../../src/warehouseQa/common');
const { row, result } = require('../fixtures/warehouseQa');
const { archiveOutOfScopeReviews } = require('../../scripts/archiveOutOfScopeQaReviews');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const db = new PrismaClient({ datasources: { db: { url: baseUrl + '?schema=' + schema } } });
const repository = new QaRepository(db);
const actor = { id: 'admin-fixture', name: 'Admin fixture', email: 'fixture@wareongo.com' };
const idleWorker = { drain: jest.fn().mockResolvedValue() };
let source, service;
beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await migrate(db, true);
});
afterAll(async () => {
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.$disconnect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "WarehouseQaEvent", "WarehouseQaItem", "WarehouseQaRun", "WarehouseQaCache", "WarehouseQaCursor"'
  );
  source = {
    mode: 'pilot',
    load: jest.fn(async (ids, mode) => ids.map((id) => ({ ...row(id), mode }))),
    scan: jest.fn()
  };
  service = new QaService({
    repository,
    source,
    worker: idleWorker,
    pilotAssignees: [{ id: 1, name: 'Fixture assignee' }]
  });
});
const batch = (ids = [1]) => ({
  request_id: randomUUID(),
  warehouse_ids: ids,
  mode: 'BACKFILL',
  model: 'gpt-6.2-sol'
});
async function seedCompleted() {
  const run = await service.create(batch(), actor);
  const item = await repository.claim();
  await repository.finish(item, { result: result(item.snapshot) });
  return run;
}
async function seedLegacyDuplicate() {
  // Older releases admitted duplicate batches. Keep exercising their retained
  // evidence without bypassing the new admission rule through the public API.
  const body = batch();
  return repository.transaction((repo) => service.enqueue(repo, body, actor, [row(1)]));
}

test('batch retries and concurrent callers enqueue exactly once', async () => {
  const body = batch([1, 2]);
  await Promise.all([service.create(body, actor), service.create(body, actor)]);
  expect(await repository.items(body.request_id)).toHaveLength(2);
  expect(source.load).toHaveBeenCalledTimes(1);
  await expect(service.create({ ...body, warehouse_ids: [3] }, actor)).rejects.toMatchObject({
    code: 'QA_IDEMPOTENCY_CONFLICT'
  });
});

test('a new request containing an already queued WHID rejects the whole batch without writing', async () => {
  const first = await service.create(batch([1]), actor);
  const body = batch([2, 1]);
  const events = await repository.events(first.id, 1);
  const drainCalls = idleWorker.drain.mock.calls.length;
  await expect(service.create(body, actor)).rejects.toMatchObject({
    status: 409,
    code: 'QA_WAREHOUSE_IN_PIPELINE',
    message: expect.stringContaining('WH1 is already')
  });
  expect(await repository.run(body.request_id)).toBeUndefined();
  expect(await repository.items(body.request_id)).toEqual([]);
  expect(await repository.events(first.id, 1)).toEqual(events);
  expect(idleWorker.drain).toHaveBeenCalledTimes(drainCalls);
});

test('different request IDs with overlapping WHIDs admit only one concurrent batch', async () => {
  const requests = [batch([2, 1]), batch([1, 2])];
  const results = await Promise.allSettled(requests.map((body) => service.create(body, actor)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({
    code: 'QA_WAREHOUSE_IN_PIPELINE'
  });
  expect(await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaRun"`).toEqual([{ count: 1 }]);
  expect(await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaItem"`).toEqual([{ count: 2 }]);
  expect(await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaEvent"`).toEqual([{ count: 2 }]);
});

test.each(['BACKFILL', 'NEW_SUBMISSION', 'RECHECK'])(
  'a new %s request cannot duplicate a reviewed warehouse or overwrite saved admin work',
  async (mode) => {
    const first = await seedCompleted();
    const original = await repository.item(first.id, 1);
    await service.mutate(
      first.id,
      1,
      'decision',
      {
        request_id: randomUUID(),
        expected_version: 0,
        field_key: original.result.candidates[0].field_key,
        decision: 'APPROVED',
        note: 'Preserve this admin decision.'
      },
      actor
    );
    const saved = await repository.item(first.id, 1);
    await expect(service.create({ ...batch(), mode }, actor)).rejects.toMatchObject({
      code: 'QA_WAREHOUSE_IN_PIPELINE'
    });
    expect(await repository.item(first.id, 1)).toEqual(saved);
    expect((await service.list('inbox')).warehouses).toHaveLength(1);
  }
);

test.each(['RUNNING', 'FAILED', 'ASSIGNED_LOCAL'])(
  '%s work blocks resubmission while the original request remains replayable',
  async (state) => {
    const body = batch();
    const first = await service.create(body, actor);
    const claimed = await repository.claim();
    if (state !== 'RUNNING') {
      const evaluated = result(claimed.snapshot);
      if (state === 'ASSIGNED_LOCAL') evaluated.stage = state;
      await repository.finish(claimed, {
        result: evaluated,
        error: state === 'FAILED' ? 'QA_OPENAI_HTTP_401' : null
      });
    }
    await expect(service.create(batch(), actor)).rejects.toMatchObject({ code: 'QA_WAREHOUSE_IN_PIPELINE' });
    await expect(service.create(body, actor)).resolves.toMatchObject({ id: first.id, replayed: true });
    expect(await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaItem"`).toEqual([{ count: 1 }]);
  }
);

test.each(['DISMISSED', 'STALE', 'SUPERSEDED'])(
  '%s history without another active item permits a new manual evaluation',
  async (stage) => {
    const first = await seedCompleted();
    const saved = await repository.item(first.id, 1);
    await repository.saveResult(first.id, 1, { ...saved.result, stage });
    await expect(service.create(batch(), actor)).resolves.toMatchObject({ queued: 1 });
    expect((await repository.item(first.id, 1)).result.stage).toBe(stage);
  }
);

test('a changed execution contract can be evaluated again, but cannot admit two replacements', async () => {
  const first = await seedCompleted();
  await db.$executeRaw`UPDATE "WarehouseQaRun" SET metadata=jsonb_set(metadata,'{execution_hash}','"previous-engine"'::jsonb) WHERE id=${first.id}`;
  await expect(service.create(batch(), actor)).resolves.toMatchObject({ queued: 1 });
  await expect(service.create(batch(), actor)).rejects.toMatchObject({ code: 'QA_WAREHOUSE_IN_PIPELINE' });
});

test('manual requests resume persisted batches without a background timer or a cron token', async () => {
  const run = await service.create(batch([1, 2, 3]), actor);
  const inference = { evaluate: jest.fn(async (snapshot) => ({ result: result(snapshot) })) };
  // Simulate a new backend instance discovering queued work after a restart.
  const resumed = new QaService({ repository, source, worker: new QaWorker({ repository, inference }) });
  expect((await resumed.processRun(run.id)).counts).toMatchObject({ COMPLETED: 3, QUEUED: 0, RUNNING: 0 });
  expect((await resumed.processRun(run.id)).status).toBe('COMPLETED');
  expect(inference.evaluate).toHaveBeenCalledTimes(3);
  expect(await repository.items(run.id)).toHaveLength(3);
  expect(
    (await repository.events(run.id, 1)).filter((event) => event.action === 'QA_EVALUATED')
  ).toHaveLength(1);
  await expect(resumed.processRun('missing-run')).rejects.toMatchObject({ code: 'QA_RUN_NOT_FOUND' });
  expect(inference.evaluate).toHaveBeenCalledTimes(3);
});

test('unfinished batches remain discoverable ahead of newer completed history', async () => {
  const older = await service.create(batch([1]), actor);
  const olderClaim = await repository.claim();
  const newer = await service.create(batch([2]), actor);
  const newerClaim = await repository.claim();
  await repository.finish(newerClaim, { result: result(newerClaim.snapshot) });
  await db.$executeRaw`UPDATE "WarehouseQaRun" SET "createdAt"=now()-interval '1 day' WHERE id=${older.id}`;
  expect((await service.runs())[1]).toMatchObject({ id: older.id, status: 'RUNNING' });
  await repository.finish(olderClaim, { result: result(olderClaim.snapshot) });
  expect((await service.runs())[1]).toMatchObject({ id: newer.id, status: 'COMPLETED' });
});

test('warehouse-source transactions enforce read-only access in PostgreSQL', async () => {
  const liveSource = new QaSource({ sourceDb: () => db, mode: 'warehouse' });
  expect(await liveSource.read((tx) => tx.$queryRaw`SHOW transaction_read_only`)).toEqual([
    { transaction_read_only: 'on' }
  ]);
  await expect(liveSource.read((tx) => tx.$executeRaw`DELETE FROM "WarehouseQaRun"`)).rejects.toMatchObject({
    code: 'P2010',
    meta: { code: '25006' }
  });
});

test.each(['older-first', 'newer-first', 'concurrent'])(
  'legacy duplicate reviews keep one untouched evaluation active with %s completion',
  async (order) => {
    const first = await service.create(batch(), actor);
    const older = await repository.claim();
    const second = await seedLegacyDuplicate();
    const newer = await repository.claim();
    const worker = new QaWorker({
      repository,
      inference: {
        evaluate: async (snapshot) => ({ result: result(snapshot), artifact: { evidence: 'retained' } })
      }
    });
    if (order === 'concurrent') await Promise.all([worker.process(older), worker.process(newer)]);
    else
      for (const item of order === 'older-first' ? [older, newer] : [newer, older])
        await worker.process(item);
    const archived = await repository.item(first.id, 1);
    expect(archived.result).toMatchObject({
      stage: 'SUPERSEDED',
      version: 1,
      superseded_by: { run_id: second.id }
    });
    expect(archived.snapshot).toEqual(older.snapshot);
    expect(archived.artifact).toEqual({ evidence: 'retained' });
    expect(archived.result.candidates).toEqual(result(older.snapshot).candidates);
    expect(archived.result.checks).toEqual(result(older.snapshot).checks);
    expect((await service.list('inbox')).warehouses.map((item) => item.run_id)).toEqual([second.id]);
    expect(
      (await service.list('inbox', { stage: 'SUPERSEDED' })).warehouses.map((item) => item.run_id)
    ).toEqual([first.id]);
    await worker.process(older); // an expired/replayed worker cannot duplicate the archive event
    const events = (await repository.events(first.id, 1)).filter(
      (event) => event.action === 'QA_REVIEW_SUPERSEDED'
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      scope: 'PER_WHID',
      runBy: 'Raghav',
      warehouse_writes: 0,
      replacement_run_id: second.id
    });
    await expect(
      service.mutate(first.id, 1, 'retry', { request_id: randomUUID(), expected_version: 1 }, actor)
    ).rejects.toMatchObject({ code: 'QA_REVIEW_CONFLICT' });
  }
);

test('legacy replacement failures retain the older review and saved admin work survives later completion', async () => {
  const first = await seedCompleted();
  const original = await repository.item(first.id, 1);
  const failedRun = await seedLegacyDuplicate();
  const failedWorker = new QaWorker({
    repository,
    inference: {
      evaluate: async () => {
        throw new QaError(502, 'QA_OPENAI_HTTP_401', 'Unavailable');
      }
    }
  });
  await failedWorker.process(await repository.claim());
  expect((await repository.item(first.id, 1)).result).toEqual(original.result);
  const reviewed = await service.mutate(
    first.id,
    1,
    'decision',
    {
      request_id: randomUUID(),
      expected_version: 0,
      field_key: original.result.candidates[0].field_key,
      decision: 'APPROVED',
      note: 'Keep this saved human decision.'
    },
    actor
  );
  const replacement = await seedLegacyDuplicate();
  const worker = new QaWorker({
    repository,
    inference: { evaluate: async (snapshot) => ({ result: result(snapshot) }) }
  });
  await worker.process(await repository.claim());
  expect((await repository.item(first.id, 1)).result).toEqual(reviewed);
  expect((await repository.item(failedRun.id, 1)).result.stage).toBe('SUPERSEDED');
  const pending = await service.list('inbox');
  expect(new Set(pending.warehouses.map((item) => item.run_id))).toEqual(new Set([first.id, replacement.id]));
  expect((await service.export(first.id)).warehouses[0].candidates[0].admin_note).toBe(
    'Keep this saved human decision.'
  );
});

test('mixed batches queue only PEB and audit each skipped warehouse without evaluating it', async () => {
  const types = ['PEB', 'RCC', 'BTS', 'Shed', null, '\u00a0peB\u00a0'];
  source.load.mockImplementation(async (ids) => ids.map((id) => row(id, { warehouseType: types[id - 1] })));
  const run = await service.create(batch([1, 2, 3, 4, 5, 6]), actor);
  expect(run).toMatchObject({ queued: 2, skipped: 4 });
  const items = await repository.items(run.id);
  for (const item of items.filter((item) => [2, 3, 4, 5].includes(item.warehouseId))) {
    expect(item.status).toBe('SKIPPED');
    expect(item.result).toBeNull();
    const events = await repository.events(run.id, item.warehouseId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'QA_SKIPPED',
      payload: {
        reason: 'SKIPPED_WAREHOUSE_TYPE',
        scope: 'PER_WHID',
        runBy: 'Raghav',
        warehouse_writes: 0
      }
    });
  }
  const claims = [await repository.claim(), await repository.claim(), await repository.claim()];
  expect(
    claims
      .filter(Boolean)
      .map((item) => item.warehouseId)
      .sort()
  ).toEqual([1, 6]);
});

test('a worker skips non-PEB work queued by an older policy and preserves historical evidence', async () => {
  const id = randomUUID();
  await repository.insertRun(id, 'old-policy', actor, {});
  const snapshot = row(2, { warehouseType: 'RCC' });
  const priorResult = { ...result(row(2)), fields: snapshot.fields };
  const artifact = { historical: true };
  await repository.insertItem(id, snapshot, { result: priorResult, artifact });
  const claimed = await repository.claim();
  const inference = { evaluate: jest.fn() };
  const worker = new QaWorker({ repository, inference });
  await worker.process(claimed);
  await worker.process(claimed); // a stale lease cannot emit a second event
  expect(inference.evaluate).not.toHaveBeenCalled();
  const stored = await repository.item(id, 2);
  expect(stored.status).toBe('SKIPPED');
  expect(stored.result).toEqual(priorResult);
  expect(stored.artifact).toEqual(artifact);
  const events = await repository.events(id, 2);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: 'QA_SKIPPED',
    payload: {
      reason: 'SKIPPED_WAREHOUSE_TYPE',
      runBy: 'Raghav',
      warehouse_writes: 0
    }
  });
});

test('old non-PEB reviews leave the active queue and metrics but remain readable and exportable', async () => {
  const id = randomUUID();
  await repository.insertRun(id, 'historical-policy', actor, {});
  const types = ['PEB', 'RCC', 'BTS', 'Shed', null, '\tpeB\n', '\u00a0PEB\u00a0'];
  for (let i = 0; i < types.length; i++) {
    const snapshot = row(i + 1, { warehouseType: types[i] });
    const historical = { ...result(row(i + 1)), fields: snapshot.fields, warehouse_type: types[i] };
    await repository.insertItem(id, snapshot, { status: 'COMPLETED', result: historical });
  }
  const page = await service.list('inbox');
  expect(page.total).toBe(3);
  expect(page.warehouses.map((item) => item.warehouse_id).sort((a, b) => a - b)).toEqual([1, 6, 7]);
  expect(page.metrics.pending).toBe(page.warehouses.reduce((n, item) => n + item.candidates.length, 0));
  expect((await service.summary()).pending_warehouses).toBe(3);
  expect(await repository.inbox()).toHaveLength(3);
  const runs = await service.runs();
  expect(runs.find((run) => run.id === id)).toMatchObject({
    warehouse_count: 7,
    eligible_warehouse_count: 3
  });
  const before = await repository.item(id, 2);
  expect(await service.detail(id, 2)).toMatchObject({
    eligible_for_review: false,
    scope_exclusion: 'SKIPPED_WAREHOUSE_TYPE'
  });
  await expect(
    service.mutate(
      id,
      2,
      'confirm',
      {
        request_id: randomUUID(),
        expected_version: 0,
        assignee_id: 1
      },
      actor
    )
  ).rejects.toMatchObject({ code: 'QA_OUT_OF_SCOPE' });
  await expect(
    service.mutate(
      id,
      2,
      'retry',
      {
        request_id: randomUUID(),
        expected_version: 0
      },
      actor
    )
  ).rejects.toMatchObject({ code: 'QA_OUT_OF_SCOPE' });
  expect(await repository.item(id, 2)).toEqual(before);
  expect(await repository.events(id, 2)).toHaveLength(0);
  const exported = await service.export(id);
  expect(exported.warehouses).toHaveLength(7);
  expect(exported.warehouses.find((item) => item.warehouse_id === 2).eligible_for_review).toBe(false);
});

test('scope removal archives existing excluded reviews once per WHID without losing notes or evidence', async () => {
  const id = randomUUID();
  await repository.insertRun(id, 'archive-fixture', actor, {});
  for (const [index, type] of ['PEB', 'RCC', 'BTS', 'Shed'].entries()) {
    const snapshot = row(index + 1, { warehouseType: type });
    const historical = { ...result(row(index + 1)), fields: snapshot.fields };
    historical.candidates[0].admin_note = 'Preserve this existing admin note.';
    historical.candidates[0].decision = 'APPROVED';
    await repository.insertItem(id, snapshot, {
      status: 'COMPLETED',
      result: historical,
      artifact: { original_response: 'retained' }
    });
  }
  const before = await repository.items(id);
  const preview = await archiveOutOfScopeReviews(repository, id);
  expect(preview.reviews.map((item) => item.warehouse_id)).toEqual([2, 3, 4]);
  expect(await repository.items(id)).toEqual(before);
  const applied = await archiveOutOfScopeReviews(repository, id, { apply: true });
  expect(applied.reviews).toHaveLength(3);
  const after = await repository.items(id);
  expect(after[0]).toEqual(before[0]);
  for (let i = 1; i < after.length; i++) {
    expect(after[i].result.stage).toBe('OUT_OF_SCOPE');
    expect(after[i].result.version).toBe(before[i].result.version + 1);
    const restored = { ...after[i].result, stage: before[i].result.stage, version: before[i].result.version };
    delete restored.scope_archive;
    delete restored.last_modified_at;
    expect(restored).toEqual(before[i].result);
    expect(after[i].snapshot).toEqual(before[i].snapshot);
    expect(after[i].artifact).toEqual(before[i].artifact);
    const events = await repository.events(id, i + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'QA_REVIEW_REMOVED_FROM_SCOPE',
      payload: {
        scope: 'PER_WHID',
        runBy: 'Raghav',
        stage_after: 'OUT_OF_SCOPE',
        warehouse_writes: 0
      }
    });
  }
  expect(
    (await repository.reviewPage({ runId: id, scopeOnly: false })).map((item) => item.warehouseId)
  ).toEqual([1]);
  expect((await archiveOutOfScopeReviews(repository, id, { apply: true })).reviews).toHaveLength(0);
  for (const whid of [2, 3, 4]) expect(await repository.events(id, whid)).toHaveLength(1);
});

test('scope removal rolls back if its warehouse audit event cannot be saved', async () => {
  const id = randomUUID();
  await repository.insertRun(id, 'archive-rollback-fixture', actor, {});
  const snapshot = row(2, { warehouseType: 'RCC' });
  await repository.insertItem(id, snapshot, {
    status: 'COMPLETED',
    result: { ...result(row(2)), fields: snapshot.fields }
  });
  const before = await repository.item(id, 2);
  const failing = {
    transaction: (fn) =>
      repository.transaction(async (repo) => {
        repo.event = async () => {
          throw new Error('Synthetic audit failure');
        };
        return fn(repo);
      })
  };
  await expect(archiveOutOfScopeReviews(failing, id, { apply: true })).rejects.toThrow(
    'Synthetic audit failure'
  );
  expect(await repository.item(id, 2)).toEqual(before);
  expect(await repository.events(id, 2)).toHaveLength(0);
});

test('concurrent claims are exclusive and an expired worker cannot overwrite its replacement', async () => {
  await service.create(batch([1, 2]), actor);
  const claims = await Promise.all([repository.claim(), repository.claim(), repository.claim()]);
  expect(claims.filter(Boolean)).toHaveLength(2);
  expect(new Set(claims.filter(Boolean).map((item) => item.warehouseId)).size).toBe(2);
  const old = claims.find(Boolean);
  await db.$executeRaw`UPDATE "WarehouseQaItem" SET "leaseUntil"=now()-interval '1 second' WHERE "runId"=${old.runId} AND "warehouseId"=${old.warehouseId}`;
  const recovered = await new QaRepository(db).claim();
  expect(recovered.warehouseId).toBe(old.warehouseId);
  expect(recovered.attempts).toBe(2);
  expect(await repository.finish(old, { result: result(old.snapshot) })).toBe(false);
  expect(await repository.finish(recovered, { result: result(recovered.snapshot) })).toBe(true);
});

test('adjudication is atomic, idempotent, and rejects stale concurrent versions', async () => {
  const run = await seedCompleted();
  const current = await service.detail(run.id, 1);
  const body = {
    request_id: randomUUID(),
    expected_version: 0,
    field_key: current.candidates[0].field_key,
    decision: 'APPROVED',
    note: 'Checked by admin.'
  };
  const competing = await Promise.allSettled([
    service.mutate(run.id, 1, 'decision', body, actor),
    service.mutate(run.id, 1, 'decision', { ...body, request_id: randomUUID() }, actor)
  ]);
  expect(competing.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find((outcome) => outcome.status === 'rejected').reason.code).toBe('QA_REVIEW_CONFLICT');
  const saved = await service.detail(run.id, 1);
  expect(saved.version).toBe(1);
  const events = await repository.events(run.id, 1);
  expect(events.filter((event) => event.action === 'DECISION')).toHaveLength(1);
  expect(events.find((event) => event.action === 'DECISION').payload).toMatchObject({
    runBy: 'Raghav',
    scope: 'PER_WHID',
    warehouse_writes: 0
  });
  // Replay the successful request, whichever parallel operation won.
  const winning = events.find((event) => event.action === 'DECISION').payload.operation;
  expect((await service.mutate(run.id, 1, 'decision', winning, actor)).version).toBe(1);
});

test('failed audit insertion rolls back the admin decision', async () => {
  const run = await seedCompleted();
  const current = await service.detail(run.id, 1);
  await db.$executeRawUnsafe(
    `CREATE FUNCTION reject_qa_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DECISION' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER reject_qa_event BEFORE INSERT ON "WarehouseQaEvent" FOR EACH ROW EXECUTE FUNCTION reject_qa_event()'
  );
  try {
    await expect(
      service.mutate(
        run.id,
        1,
        'decision',
        {
          request_id: randomUUID(),
          expected_version: 0,
          field_key: current.candidates[0].field_key,
          decision: 'APPROVED',
          note: ''
        },
        actor
      )
    ).rejects.toThrow();
    expect((await service.detail(run.id, 1)).version).toBe(0);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER reject_qa_event ON "WarehouseQaEvent"');
    await db.$executeRawUnsafe('DROP FUNCTION reject_qa_event()');
  }
});

test('prefilled form confirmation saves all field decisions with one warehouse audit and retry-safe handoff', async () => {
  const run = await seedCompleted();
  const initial = await service.detail(run.id, 1);
  const body = {
    request_id: randomUUID(),
    expected_version: initial.version,
    assignee_id: 1,
    review: {
      machine: initial.candidates.map((candidate, index) => ({
        field_key: candidate.field_key,
        decision: index ? 'APPROVED' : 'REJECTED',
        note: index ? 'Confirm the stored value.' : 'Admin confirmed this value is correct.',
        reason: index ? null : 'INCORRECT'
      })),
      human: [
        {
          field_key: 'clearHeightFt',
          note: 'Owner provided a different height.',
          missed_rule_id: 'F.CLEAR_HEIGHT'
        }
      ]
    }
  };
  // Invalid supplemental feedback cannot partially approve the machine fields.
  await expect(
    service.mutate(
      run.id,
      1,
      'confirm',
      {
        ...body,
        request_id: randomUUID(),
        review: { ...body.review, human: [{ ...body.review.human[0], missed_rule_id: 'F.POWER' }] }
      },
      actor
    )
  ).rejects.toThrow();
  expect(
    (await service.detail(run.id, 1)).candidates.every((candidate) => candidate.decision === 'PENDING')
  ).toBe(true);
  const saved = await service.mutate(run.id, 1, 'confirm', body, actor);
  expect(saved).toMatchObject({ version: initial.version + 1, stage: 'ASSIGNED_LOCAL' });
  expect(saved.handoff.production_request_sent).toBe(false);
  expect(saved.handoff.payload.fields).toHaveLength(initial.candidates.length);
  expect(saved.candidates.find((candidate) => candidate.field_key === 'clearHeightFt')).toMatchObject({
    source: 'ADMIN',
    evaluation_label: 'ADMIN_FOUND_MISS'
  });
  const replay = await service.mutate(run.id, 1, 'confirm', body, actor);
  expect(replay.handoff.payload.requestId).toBe(saved.handoff.payload.requestId);
  const confirmations = (await repository.events(run.id, 1)).filter((event) => event.action === 'CONFIRM');
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0].payload).toMatchObject({ scope: 'PER_WHID', runBy: 'Raghav', warehouse_writes: 0 });
  await expect(
    service.mutate(run.id, 1, 'confirm', { ...body, request_id: randomUUID() }, actor)
  ).rejects.toMatchObject({ code: 'QA_REVIEW_CONFLICT' });
});

test('exhausted inference retains deterministic candidates and records missing AI coverage', async () => {
  const run = await service.create(batch(), actor);
  const inference = {
    evaluate: jest.fn().mockRejectedValue(new QaError(502, 'QA_INVALID_EVIDENCE', 'Invalid quote.'))
  };
  const worker = new QaWorker({ repository, inference });
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await repository.claim();
    await worker.process(item);
    await db.$executeRaw`UPDATE "WarehouseQaItem" SET "availableAt"=now() WHERE "runId"=${run.id}`;
  }
  const final = await service.detail(run.id, 1);
  expect(final.coverage.ai_status).toBe('FAILED');
  expect(final.candidates.length).toBeGreaterThan(0);
  expect(
    final.checks
      .filter((check) => check.executor === 'AI_TEXT')
      .every((check) => check.verdict === 'NOT_EVALUATED')
  ).toBe(true);
  expect(await repository.claim()).toBeUndefined();
  expect((await service.status(run.id)).status).toBe('PARTIAL');
});

test('forward scan persists tuple pagination and deduplicates overlapping windows', async () => {
  source.mode = 'warehouse';
  const createdAt = new Date('2026-11-23T12:00:00Z');
  source.scan.mockImplementation(async (window, limit) =>
    [1, 2, 3]
      .filter((id) => !window.after || id > window.after.id)
      .slice(0, limit)
      .map((id) => ({ id, createdAt }))
  );
  const first = await service.cron({ request_id: randomUUID(), since: '2026-11-23T00:00:00Z', limit: 2 });
  expect(first.warehouse_count).toBe(2);
  expect(first.has_more).toBe(true);
  const second = await service.cron({ request_id: randomUUID(), limit: 2 });
  expect(second.warehouse_count).toBe(1);
  expect(second.has_more).toBe(false);
  expect(source.scan.mock.calls[1][0].after).toEqual({ createdAt: createdAt.toISOString(), id: 2 });
  const third = await service.cron({ request_id: randomUUID(), limit: 100 });
  expect(third.warehouse_count).toBe(0);
  expect((await repository.inbox()).length).toBe(0); // no worker has evaluated yet
  const counts = await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaItem"`;
  expect(counts[0].count).toBe(3);
});

test('forward scans skip open manual QA without stalling the scan cursor', async () => {
  await service.create(batch([1]), actor);
  source.mode = 'warehouse';
  source.scan.mockResolvedValue([1, 2].map((id) => ({ id, createdAt: new Date('2026-11-23T12:00:00Z') })));
  const run = await service.cron({ request_id: randomUUID(), since: '2026-11-23T00:00:00Z', limit: 100 });
  expect(run).toMatchObject({ warehouse_count: 1, duplicate_warehouse_ids: [1], has_more: false });
  expect((await repository.items(run.id)).map((item) => item.warehouseId)).toEqual([2]);
  expect(
    (await repository.cursor('forward:' + require('../../src/warehouseQa/engine').profileHash)).window
  ).toBeNull();
});

test('manual and forward submissions share admission locks', async () => {
  source.mode = 'warehouse';
  source.scan.mockResolvedValue([{ id: 1, createdAt: new Date('2026-11-23T12:00:00Z') }]);
  const outcomes = await Promise.allSettled([
    service.create(batch(), actor),
    service.cron({ request_id: randomUUID(), since: '2026-11-23T00:00:00Z', limit: 100 })
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') expect(outcome.reason.code).toBe('QA_WAREHOUSE_IN_PIPELINE');
  }
  expect(
    await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaItem" WHERE "warehouseId"=1`
  ).toEqual([{ count: 1 }]);
});

test('retrying a failed evaluation preserves its audit trail and increments review versions', async () => {
  const run = await service.create(batch(), actor);
  let item = await repository.claim();
  const engine = require('../../src/warehouseQa/engine');
  await repository.finish(item, {
    result: engine.failed(item.snapshot, item.snapshot.as_of_date, 'gpt-6.2-sol', 'QA_OPENAI_HTTP_401'),
    error: 'QA_OPENAI_HTTP_401'
  });
  const failed = await service.detail(run.id, 1);
  await expect(
    service.mutate(
      run.id,
      1,
      'decision',
      {
        request_id: randomUUID(),
        expected_version: 0,
        field_key: failed.candidates[0].field_key,
        decision: 'APPROVED',
        note: ''
      },
      actor
    )
  ).rejects.toMatchObject({ code: 'QA_EVALUATION_FAILED' });
  const retry = { request_id: randomUUID(), expected_version: 0 };
  expect((await service.mutate(run.id, 1, 'retry', retry, actor)).version).toBe(1);
  expect((await service.mutate(run.id, 1, 'retry', retry, actor)).version).toBe(1);
  item = await repository.claim();
  const worker = new QaWorker({
    repository,
    inference: { evaluate: async (snapshot) => ({ result: result(snapshot) }) }
  });
  await worker.process(item);
  expect((await service.detail(run.id, 1)).version).toBe(2);
  expect((await service.detail(run.id, 1)).coverage.ai_status).toBe('COMPLETED');
  expect((await repository.events(run.id, 1)).filter((event) => event.action === 'RETRY')).toHaveLength(1);
});

test('pagination and filters keep complete aggregate counts without loading the whole inbox', async () => {
  const run = await service.create(batch([1, 2, 3]), actor);
  for (let index = 0; index < 3; index++) {
    const item = await repository.claim();
    await repository.finish(item, { result: result(item.snapshot) });
  }
  const first = await service.list('inbox', { page: 1, limit: 2 });
  const second = await service.list('inbox', { page: 2, limit: 2 });
  expect(first.total).toBe(3);
  expect(first.warehouses).toHaveLength(2);
  expect(second.warehouses).toHaveLength(1);
  expect(first.metrics.machine_columns).toBe(result(row()).candidates.length * 3);
  expect((await service.list(run.id, { search: '2' })).warehouses.map((row) => row.warehouse_id)).toEqual([
    2
  ]);
  expect((await service.list(run.id, { search: '%' })).total).toBe(0);
});

test('a failed forward enqueue rolls back both the run and the cursor', async () => {
  source.mode = 'warehouse';
  source.scan.mockResolvedValue([{ id: 1, createdAt: new Date('2026-11-23T12:00:00Z') }]);
  source.load.mockRejectedValue(new Error('source unavailable'));
  const id = randomUUID();
  await expect(service.cron({ request_id: id, since: '2026-11-23T00:00:00Z', limit: 100 })).rejects.toThrow();
  expect(await repository.run(id)).toBeUndefined();
  expect(
    await repository.cursor('forward:' + require('../../src/warehouseQa/engine').profileHash)
  ).toBeUndefined();
});

test('cron retries preserve the original continuation after another caller advances the cursor', async () => {
  source.mode = 'warehouse';
  source.scan.mockImplementation(async (window, limit) =>
    [1, 2]
      .filter((id) => !window.after || id > window.after.id)
      .slice(0, limit)
      .map((id) => ({ id, createdAt: new Date('2026-11-23T12:00:00Z') }))
  );
  const request = { request_id: randomUUID(), since: '2026-11-23T00:00:00Z', limit: 1 };
  const first = await service.cron(request);
  await service.cron({ request_id: randomUUID(), limit: 100 });
  const replay = await service.cron(request);
  expect(first.has_more).toBe(true);
  expect(replay.has_more).toBe(true);
  expect(source.scan).toHaveBeenCalledTimes(2);
  expect(await repository.items(first.id)).toHaveLength(1);
});

test('rolling deployments never evaluate a queued job under a different execution identity', async () => {
  const run = await service.create(batch(), actor);
  await db.$executeRaw`UPDATE "WarehouseQaRun" SET metadata=jsonb_set(metadata,'{execution_hash}','"previous-engine"'::jsonb) WHERE id=${run.id}`;
  const inference = { evaluate: jest.fn() };
  const worker = new QaWorker({ repository, inference });
  await worker.process(await repository.claim());
  expect(inference.evaluate).not.toHaveBeenCalled();
  const item = await repository.item(run.id, 1);
  expect(item.status).toBe('FAILED');
  expect(item.result.coverage.ai_status).toBe('POLICY_CHANGED');
  expect(item.result.checks).toEqual([]);
  expect(item.result.candidates).toEqual([]);
  await expect(
    service.mutate(run.id, 1, 'retry', { request_id: randomUUID(), expected_version: 0 }, actor)
  ).rejects.toMatchObject({ code: 'QA_EXECUTION_CHANGED' });
});

test('replicas share the concurrency limit and release capacity after a job finishes', async () => {
  await service.create(batch([1, 2, 3, 4]), actor);
  const claims = await Promise.all(Array.from({ length: 4 }, () => new QaRepository(db).claim()));
  expect(claims.filter(Boolean)).toHaveLength(2);
  expect((await repository.queueHealth()).running).toBe(2);
  await repository.finish(claims.find(Boolean), { result: result(row()) });
  expect(await repository.claim()).toBeDefined();
  expect((await repository.queueHealth()).running).toBe(2);
});

const { randomBytes, randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createSchema } = require('../helpers/fieldReviewDatabase');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrate: migrateReviews } = require('../../scripts/migrateFieldReview');
const { migrate: migrateQa } = require('../../scripts/migrateWarehouseQa');
const { FieldReviewService } = require('../../src/fieldReview/service');
const { QaRepository } = require('../../src/warehouseQa/repository');
const { QaSource } = require('../../src/warehouseQa/source');
const { QaService } = require('../../src/warehouseQa/service');
const { result } = require('../fixtures/warehouseQa');
const { completePptForm } = require('../fixtures/pptForm');

const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const root = new PrismaClient({ datasources: { db: { url: base } } });
const db = new PrismaClient({ datasources: { db: { url: base + '?schema=' + schema } } });
const repository = new QaRepository(db);
const fieldReviews = new FieldReviewService(db);
const source = new QaSource({ repository, sourceDb: () => db, mode: 'warehouse' });
const idle = { drain: jest.fn().mockResolvedValue() };
const service = new QaService({
  repository,
  source,
  worker: idle,
  fieldReviews,
  handoffMode: 'field-review',
  runBy: 'Raghav'
});
const admin = { id: 1, name: 'Admin fixture', email: 'qa-admin@wareongo.com' };
const employee = { email: 'qa-employee@wareongo.com' };
const whid = 4821;
const power = 'warehouseData.powerKva';
let created = false;

beforeAll(async () => {
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  await createSchema(db);
  await migrateReviews(db, true);
  await migrateQa(db, true);
});
afterAll(async () => {
  await db.$disconnect();
  if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await root.$disconnect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "WarehouseQaEvent","WarehouseQaItem","WarehouseQaRun","WarehouseQaCache","WarehouseQaCursor","WarehouseFieldReviewEvent","WarehouseFieldFlag","WarehouseFieldReview","WarehouseFieldVersion","WarehouseFieldEdit","WarehouseData","Warehouse","VerifiedNumber",audit_logs CASCADE'
  );
  await db.verifiedNumber.createMany({
    data: [
      {
        id: 1,
        name: 'Admin fixture',
        email: admin.email,
        phone_number: 'qa-admin',
        is_active: true,
        adminAccess: true
      },
      {
        id: 2,
        name: 'Employee fixture',
        email: employee.email,
        phone_number: 'qa-employee',
        is_active: true,
        dashboardAccess: true,
        viewOwnWarehouseEntries: true,
        viewAllWarehouseEntries: true
      },
      {
        id: 3,
        name: 'Other employee',
        email: 'other@wareongo.com',
        phone_number: 'qa-other',
        is_active: true,
        dashboardAccess: true,
        viewOwnWarehouseEntries: true,
        viewAllWarehouseEntries: true
      }
    ]
  });
  const { warehouseData, ...form } = completePptForm();
  await db.warehouse.create({
    data: {
      ...form,
      id: whid,
      uploadedBy: 'Employee fixture',
      zone: 'North',
      handoverDate: new Date(form.handoverDate),
      builtup_area: '10000 sq ft',
      carpet_area: '9000 sq ft',
      WarehouseData: { create: { ...warehouseData, powerKva: '5' } }
    }
  });
});

async function evaluated() {
  const run = await service.create(
    { request_id: randomUUID(), warehouse_ids: [whid], mode: 'BACKFILL', model: 'gpt-6.2-sol' },
    admin
  );
  const item = await repository.claim();
  await repository.finish(item, { result: result(item.snapshot) });
  return { run, review: await service.detail(run.id, whid, admin) };
}
function approval(review, { human = [], approve = [power], assigneeId = 2 } = {}) {
  return {
    request_id: randomUUID(),
    expected_version: review.version,
    assignee_id: assigneeId,
    review: {
      machine: review.candidates.map((candidate) => ({
        field_key: candidate.field_key,
        decision: approve.includes(candidate.field_key) ? 'APPROVED' : 'REJECTED',
        note: 'Reviewed against the source record.',
        reason: approve.includes(candidate.field_key) ? null : 'NOT_ACTIONABLE'
      })),
      human
    }
  };
}
const confirm = (run, body, actor = admin) => service.mutate(run.id, whid, 'confirm', body, actor);

test('approved AI/human flags enter the ordinary employee workflow atomically and retain origin after response/verification', async () => {
  const { run, review } = await evaluated();
  expect(review.assignment.assignees.some((person) => person.id === 2)).toBe(true);
  expect(review.assignment.defaultAssigneeId).toBe(2);
  const body = approval(review, {
    human: [{ field_key: 'clearHeightFt', note: 'Confirm the clear height with the owner.' }]
  });
  const saved = await confirm(run, body);
  expect(saved.stage).toBe('ASSIGNED');
  expect(saved.handoff.review_id).toBeTruthy();
  const assigned = await fieldReviews.detail(saved.handoff.review_id, employee);
  expect(assigned.canRespond).toBe(true);
  expect(assigned.flags).toHaveLength(2);
  expect(assigned.flags.find((flag) => flag.fieldKey === power).origin).toBe('AI');
  expect(assigned.flags.find((flag) => flag.fieldKey === 'clearHeightFt').origin).toBe('HUMAN');
  expect(
    assigned.flags.every((flag) => flag.qa.runBy === 'Raghav' && flag.qa.snapshot_id === review.snapshot_id)
  ).toBe(true);
  expect((await confirm(run, body)).handoff.review_id).toBe(assigned.id);
  expect(await db.warehouseFieldReview.count()).toBe(1);
  expect(await db.warehouseFieldReviewEvent.count({ where: { action: 'CREATED' } })).toBe(1);
  expect((await repository.events(run.id, whid)).filter((event) => event.action === 'CONFIRM')).toHaveLength(
    1
  );
  expect((await db.warehouseData.findUnique({ where: { warehouseId: whid } })).powerKva).toBe('5');
  const flag = assigned.flags.find((item) => item.fieldKey === power);
  const submitted = await fieldReviews.respond(
    assigned.id,
    flag.id,
    {
      requestId: randomUUID(),
      version: flag.version,
      baselineVersion: flag.currentVersion,
      resolution: 'CORRECTION',
      proposedValue: '250 kVA',
      explanation: 'Owner supplied the sanctioned power.'
    },
    employee
  );
  const awaiting = submitted.flags.find((item) => item.id === flag.id);
  expect(awaiting.status).toBe('AWAITING_ADMIN');
  const verified = await fieldReviews.decide(
    assigned.id,
    flag.id,
    {
      requestId: randomUUID(),
      version: awaiting.version,
      currentVersion: awaiting.currentVersion,
      choice: 'PROPOSED'
    },
    admin
  );
  expect(verified.flags.find((item) => item.id === flag.id)).toMatchObject({
    status: 'VERIFIED',
    origin: 'AI'
  });
  expect((await db.warehouseData.findUnique({ where: { warehouseId: whid } })).powerKva).toBe('250 kVA');
});

test.each(['power value', 'power revision', 'cross-field dependency', 'RCC', 'BTS', 'broker', 'deleted'])(
  'changed %s blocks assignment and preserves the decision audit',
  async (change) => {
    const { run, review } = await evaluated();
    let options = {};
    if (change === 'power value')
      await db.warehouseData.update({ where: { warehouseId: whid }, data: { powerKva: '250 kVA' } });
    if (change === 'power revision')
      await db.warehouseFieldVersion.upsert({
        where: { warehouseId_fieldKey: { warehouseId: whid, fieldKey: power } },
        create: { warehouseId: whid, fieldKey: power, version: 8 },
        update: { version: { increment: 1 } }
      });
    if (change === 'cross-field dependency') {
      // Human additions may refer to surrounding evidence; they guard the snapshot.
      options = {
        human: [{ field_key: 'clearHeightFt', note: 'Compare the height with the centre height.' }]
      };
      await db.warehouse.update({ where: { id: whid }, data: { centreHeight: '20 feet' } });
    }
    if (['RCC', 'BTS'].includes(change))
      await db.warehouse.update({ where: { id: whid }, data: { warehouseType: change } });
    if (change === 'broker')
      await db.warehouse.update({ where: { id: whid }, data: { warehouseOwnerType: 'Broker' } });
    if (change === 'deleted') await db.warehouse.delete({ where: { id: whid } });
    const body = approval(review, options);
    await expect(confirm(run, body)).rejects.toMatchObject({ code: 'QA_SOURCE_CHANGED' });
    await expect(confirm(run, body)).rejects.toMatchObject({ code: 'QA_SOURCE_CHANGED' });
    expect(await db.warehouseFieldReview.count()).toBe(0);
    const saved = await repository.item(run.id, whid);
    expect(saved.result.stage).toBe('STALE');
    expect(saved.result.handoff).toBeNull();
    expect(saved.snapshot).toEqual(expect.objectContaining({ snapshot_id: review.snapshot_id }));
    const events = (await repository.events(run.id, whid)).filter((event) => event.action === 'CONFIRM');
    expect(events).toHaveLength(1);
    expect(events[0].payload.operation.review).toEqual(body.review);
    if (change !== 'deleted') {
      const next = await repository.items(saved.result.recheck_run_id);
      expect(next).toHaveLength(1);
      expect(next[0].status).toBe(['RCC', 'BTS', 'broker'].includes(change) ? 'SKIPPED' : 'QUEUED');
    }
  }
);

test('unrelated warehouse edits do not invalidate an approved machine finding', async () => {
  const { run, review } = await evaluated();
  await db.warehouse.update({ where: { id: whid }, data: { city: 'Changed city' } });
  expect((await confirm(run, approval(review))).stage).toBe('ASSIGNED');
});

test('a machine cross-field finding becomes stale when only its supporting field changes', async () => {
  await db.warehouse.update({ where: { id: whid }, data: { centreHeight: '20 feet' } });
  const { run, review } = await evaluated();
  const candidate = review.candidates.find((item) => item.field_key === 'centreHeight');
  expect(candidate.findings.some((finding) => finding.rule_id === 'X.HEIGHT_ORDER')).toBe(true);
  await db.warehouse.update({ where: { id: whid }, data: { clearHeightFt: '15 feet' } });
  await expect(confirm(run, approval(review, { approve: ['centreHeight'] }))).rejects.toMatchObject({
    code: 'QA_SOURCE_CHANGED'
  });
  const saved = await repository.item(run.id, whid);
  expect(saved.result.staleness.changed_fields).toEqual(['clearHeightFt']);
  expect(await db.warehouseFieldReview.count()).toBe(0);
});

test.each([
  'inactive assignee',
  'assignee lost access',
  'admin revoked',
  'duplicate manual flag',
  'existing assignee changed'
])('%s cannot create or overwrite employee tasks', async (change) => {
  const { run, review } = await evaluated();
  if (change === 'inactive assignee')
    await db.verifiedNumber.update({ where: { id: 2 }, data: { is_active: false } });
  if (change === 'assignee lost access')
    await db.verifiedNumber.update({
      where: { id: 2 },
      data: { viewOwnWarehouseEntries: false, viewAllWarehouseEntries: false }
    });
  if (change === 'admin revoked')
    await db.verifiedNumber.update({ where: { id: 1 }, data: { adminAccess: false } });
  if (change === 'duplicate manual flag' || change === 'existing assignee changed') {
    await fieldReviews.create(
      {
        requestId: randomUUID(),
        warehouseId: whid,
        assigneeId: 3,
        fields: [
          {
            key: change === 'duplicate manual flag' ? power : 'clearHeightFt',
            comment: 'Preserve this manual comment.'
          }
        ]
      },
      admin
    );
  }
  const before = await db.warehouseFieldFlag.findMany();
  await expect(confirm(run, approval(review))).rejects.toHaveProperty('status');
  expect(await db.warehouseFieldFlag.findMany()).toEqual(before);
  expect((await repository.item(run.id, whid)).result.stage).toBe('AI_REVIEW');
  expect((await repository.events(run.id, whid)).filter((event) => event.action === 'CONFIRM')).toHaveLength(
    0
  );
});

test('a manual review created after evaluation keeps its assignee and comments during QA handoff', async () => {
  const { run, review } = await evaluated();
  const manual = await fieldReviews.create(
    {
      requestId: randomUUID(),
      warehouseId: whid,
      assigneeId: 2,
      fields: [{ key: 'clearHeightFt', comment: 'Existing manual note.' }]
    },
    admin
  );
  const saved = await confirm(run, approval(review));
  expect(saved.handoff.review_id).toBe(manual.id);
  const joined = await fieldReviews.detail(manual.id, admin);
  expect(joined.assigneeId).toBe(2);
  expect(joined.flags.find((flag) => flag.fieldKey === 'clearHeightFt').comment).toBe(
    'Existing manual note.'
  );
  expect(joined.flags.find((flag) => flag.fieldKey === power).origin).toBe('AI');
});

test('an open manual review rejects a new QA batch without changing its notes or assignee', async () => {
  const manual = await fieldReviews.create(
    {
      requestId: randomUUID(),
      warehouseId: whid,
      assigneeId: 2,
      fields: [{ key: 'clearHeightFt', comment: 'Keep this manual review.' }]
    },
    admin
  );
  const before = await fieldReviews.detail(manual.id, admin);
  await expect(evaluated()).rejects.toMatchObject({ code: 'QA_WAREHOUSE_IN_PIPELINE' });
  expect(await fieldReviews.detail(manual.id, admin)).toEqual(before);
  expect(await db.$queryRaw`SELECT count(*)::int AS count FROM "WarehouseQaRun"`).toEqual([{ count: 0 }]);
});

test('an assigned review blocks resubmission until the employee review is closed', async () => {
  const { run, review } = await evaluated();
  const saved = await confirm(run, approval(review));
  const assigned = await fieldReviews.detail(saved.handoff.review_id, employee);
  await expect(evaluated()).rejects.toMatchObject({ code: 'QA_WAREHOUSE_IN_PIPELINE' });
  const flag = assigned.flags.find((item) => item.fieldKey === power);
  const submitted = await fieldReviews.respond(
    assigned.id,
    flag.id,
    {
      requestId: randomUUID(),
      version: flag.version,
      baselineVersion: flag.currentVersion,
      resolution: 'CORRECTION',
      proposedValue: '250 kVA',
      explanation: 'Confirmed with the owner.'
    },
    employee
  );
  await expect(evaluated()).rejects.toMatchObject({ code: 'QA_WAREHOUSE_IN_PIPELINE' });
  const awaiting = submitted.flags.find((item) => item.id === flag.id);
  await fieldReviews.decide(
    assigned.id,
    flag.id,
    {
      requestId: randomUUID(),
      version: awaiting.version,
      currentVersion: awaiting.currentVersion,
      choice: 'PROPOSED'
    },
    admin
  );
  expect((await db.warehouseFieldReview.findUnique({ where: { id: assigned.id } })).closedAt).not.toBeNull();
  await expect(evaluated()).resolves.toHaveProperty('run');
  expect((await repository.item(run.id, whid)).result).toEqual(saved);
});

test('failure to write the QA audit rolls back real task creation and all employee audit writes', async () => {
  const { run, review } = await evaluated();
  await db.$executeRawUnsafe(
    `ALTER TABLE "WarehouseQaEvent" ADD CONSTRAINT audit_failure CHECK (action <> 'CONFIRM')`
  );
  try {
    await expect(confirm(run, approval(review))).rejects.toHaveProperty('code');
    expect(await db.warehouseFieldReview.count()).toBe(0);
    expect(await db.warehouseFieldFlag.count()).toBe(0);
    expect(await db.warehouseFieldReviewEvent.count()).toBe(0);
    expect((await repository.item(run.id, whid)).result.version).toBe(0);
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "WarehouseQaEvent" DROP CONSTRAINT audit_failure');
  }
});

test('concurrent confirmations create one employee task and reject the stale form', async () => {
  const { run, review } = await evaluated();
  const attempts = await Promise.allSettled([confirm(run, approval(review)), confirm(run, approval(review))]);
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.find((attempt) => attempt.status === 'rejected').reason.code).toBe('QA_REVIEW_CONFLICT');
  expect(await db.warehouseFieldReview.count()).toBe(1);
  expect(await db.warehouseFieldFlag.count()).toBe(1);
});

test('confirmation waits for an in-flight source edit and checks the committed value under its row lock', async () => {
  const { run, review } = await evaluated();
  let unlock, locked;
  const acquired = new Promise((resolve) => {
    locked = resolve;
  });
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const edit = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id=${whid} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "WarehouseData" WHERE "warehouseId"=${whid} FOR UPDATE`;
    await tx.warehouseData.update({ where: { warehouseId: whid }, data: { powerKva: '250 kVA' } });
    locked();
    await gate;
  });
  await acquired;
  const confirmation = confirm(run, approval(review));
  // Attach the rejection observer before releasing the edit to avoid unhandled rejections.
  const rejected = expect(confirmation).rejects.toMatchObject({ code: 'QA_SOURCE_CHANGED' });
  unlock();
  await edit;
  await rejected;
  expect(await db.warehouseFieldReview.count()).toBe(0);
});

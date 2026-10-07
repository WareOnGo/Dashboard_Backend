const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { createSchema, dropSchema } = require('../helpers/availabilityReviewDatabase');
const { migrate } = require('../../scripts/migrateAvailabilityReview');
const { buildPlan, readSnapshot, applyPlan, verifyPlan, rollbackSql } = require('../../scripts/backfillAvailabilityReview');

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl(process.env.TEST_DATABASE_URL) } } });
const now = new Date('2026-10-07T12:00:00Z');
const date = day => new Date(`${day}T00:00:00.000Z`);
let created = false;
beforeAll(async () => { await createSchema(prisma); created = true; await migrate(prisma, true); });
afterAll(async () => { try { if (created) await dropSchema(prisma); } finally { await prisma.$disconnect(); } });
beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "WarehouseData", "Warehouse", "StagedWarehouse", audit_logs');
    await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,availability,"availabilityLastReviewedOn","createdAt",status_updated_at,city)
        VALUES (700,'Yes',NULL,'2026-06-05','2026-08-01','Unchanged'),(701,'No',NULL,'2026-06-05','2026-08-01','Unchanged'),
        (702,'Yes','2026-07-01','2026-06-05','2026-08-01','Unchanged'),(703,'Yes',NULL,'2026-06-05','2026-08-01','Unchanged')`);
    await prisma.$executeRawUnsafe(`INSERT INTO "StagedWarehouse"
        (id,availability,"submittedAt","reviewStatus","warehouseId","rawPayload") VALUES
        ('origin','Yes','2026-06-01','APPROVED',700,'{"availability":"Yes"}'),
        ('blank',NULL,'2026-06-01','PENDING',NULL,'{}')`);
    await prisma.auditLog.createMany({ data: [
        { id: 'availability-edit', entity: 'warehouse', entityId: '701', action: 'UPDATE', userEmail: 'fixture',
            createdAt: new Date('2026-09-01T20:00:00Z'), metadata: { changes: [{ field: 'availability', from: 'Yes', to: 'No' }] } },
        { id: 'cleared-review', entity: 'warehouse', entityId: '703', action: 'UPDATE', userEmail: 'fixture',
            createdAt: new Date('2026-09-01T20:00:00Z'), metadata: { requestedFields: ['availabilityLastReviewedOn'],
                changes: [{ field: 'availabilityLastReviewedOn', from: '2026-07-01', to: null }] } },
    ] });
});

const prepare = async () => buildPlan(await readSnapshot(prisma), now);
const otherData = () => prisma.$queryRawUnsafe(`SELECT 'warehouse' entity,id::text id,to_jsonb(w)-'availabilityLastReviewedOn' data FROM "Warehouse" w
    UNION ALL SELECT 'staged_warehouse',id,to_jsonb(s)-'availabilityLastReviewedOn' FROM "StagedWarehouse" s ORDER BY entity,id`);

test('backfills only supported blanks, preserves every other field, logs evidence, and is idempotent', async () => {
    const before = await otherData();
    const plan = await prepare();
    expect(plan.candidates).toHaveLength(3);
    const receipt = await applyPlan(prisma, plan);
    expect(receipt.summary).toMatchObject({ written: 3, skippedSincePlan: 0 });
    expect(await verifyPlan(prisma, receipt)).toEqual({ rows: 3, auditRows: 3 });
    expect(await otherData()).toEqual(before);
    expect(await prisma.warehouse.findUnique({ where: { id: 700 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-06-01') });
    expect(await prisma.warehouse.findUnique({ where: { id: 701 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-09-02') });
    expect(await prisma.warehouse.findUnique({ where: { id: 702 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-07-01') });
    expect(await prisma.warehouse.findUnique({ where: { id: 703 } })).toMatchObject({ availabilityLastReviewedOn: null });
    const log = await prisma.auditLog.findFirst({ where: { entityId: '700', action: 'UPDATE' } });
    expect(log.metadata).toMatchObject({ source: 'AVAILABILITY_REVIEW_BACKFILL', backfillRunId: plan.runId,
        evidence: { kind: 'staged_submission_creation', sourceId: 'origin' },
        changes: [{ field: 'availabilityLastReviewedOn', from: null, to: '2026-06-01' }] });
    expect((await applyPlan(prisma, plan)).written).toEqual([]);
    expect(await prisma.auditLog.count()).toBe(5);
    expect((await prepare()).candidates).toEqual([]);
});

test('skips a row edited after planning even when availability still says Yes', async () => {
    const plan = await prepare();
    await prisma.warehouse.update({ where: { id: 700 }, data: { city: 'Edited meanwhile' } });
    const receipt = await applyPlan(prisma, plan);
    expect(receipt.skippedSincePlan).toEqual([{ entity: 'warehouse', id: '700' }]);
    expect(await prisma.warehouse.findUnique({ where: { id: 700 } })).toMatchObject({ availabilityLastReviewedOn: null, city: 'Edited meanwhile' });
    expect(await verifyPlan(prisma, receipt)).toEqual({ rows: 2, auditRows: 2 });
});

test('does not overwrite a review entered after the dry run', async () => {
    const plan = await prepare();
    await prisma.warehouse.update({ where: { id: 701 }, data: { availabilityLastReviewedOn: date('2026-09-20') } });
    const receipt = await applyPlan(prisma, plan);
    expect(receipt.skippedSincePlan).toContainEqual({ entity: 'warehouse', id: '701' });
    expect(await prisma.warehouse.findUnique({ where: { id: 701 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-09-20') });
});

test('skips inherited evidence when its source submission changes after planning', async () => {
    const plan = await prepare();
    await prisma.stagedWarehouse.update({ where: { id: 'origin' }, data: { availability: 'No' } });
    const receipt = await applyPlan(prisma, plan);
    expect(receipt.skippedSincePlan).toEqual(expect.arrayContaining([
        { entity: 'warehouse', id: '700' }, { entity: 'staged_warehouse', id: 'origin' },
    ]));
    expect(receipt.written).toHaveLength(1);
    expect(await prisma.warehouse.findUnique({ where: { id: 700 } })).toMatchObject({ availabilityLastReviewedOn: null });
});

test('audit failure rolls back both tables rather than leaving unaudited date writes', async () => {
    const plan = await prepare();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_fixture_backfill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.metadata->>'source'='AVAILABILITY_REVIEW_BACKFILL' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_fixture_backfill_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_fixture_backfill_audit()');
    try {
        await expect(applyPlan(prisma, plan)).rejects.toThrow();
        expect(await prisma.warehouse.findUnique({ where: { id: 700 } })).toMatchObject({ availabilityLastReviewedOn: null });
        expect(await prisma.stagedWarehouse.findUnique({ where: { id: 'origin' } })).toMatchObject({ availabilityLastReviewedOn: null });
        expect(await prisma.auditLog.count()).toBe(2);
    } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER reject_fixture_backfill_audit ON audit_logs');
        await prisma.$executeRawUnsafe('DROP FUNCTION reject_fixture_backfill_audit()');
    }
});

test('generated rollback restores only rows untouched since the backfill', async () => {
    const receipt = await applyPlan(prisma, await prepare());
    await prisma.warehouse.update({ where: { id: 700 }, data: { city: 'Newer edit' } });
    const updates = rollbackSql(receipt).split('\n').filter(line => line.startsWith('UPDATE'));
    await prisma.$transaction(updates.map(sql => prisma.$executeRawUnsafe(sql)));
    expect(await prisma.warehouse.findUnique({ where: { id: 700 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-06-01'), city: 'Newer edit' });
    expect(await prisma.warehouse.findUnique({ where: { id: 701 } })).toMatchObject({ availabilityLastReviewedOn: null });
    expect(await prisma.stagedWarehouse.findUnique({ where: { id: 'origin' } })).toMatchObject({ availabilityLastReviewedOn: null });
    expect(await prisma.warehouse.findUnique({ where: { id: 702 } })).toMatchObject({ availabilityLastReviewedOn: date('2026-07-01') });
});

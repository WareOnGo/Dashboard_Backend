const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrate } = require('../../scripts/migrateWarehouseLastEditedBy');
const { buildPlan, readSnapshot, applyPlan, verifyPlan, rollbackSql } = require('../../scripts/backfillWarehouseLastEditedBy');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const url = new URL(base); url.searchParams.set('schema', schema);
const root = new PrismaClient({ datasources: { db: { url: base } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
let created = false;
beforeAll(async () => {
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true;
    await db.$executeRawUnsafe(`CREATE TABLE "Warehouse" (id integer PRIMARY KEY,city text DEFAULT 'Original',"uploadedBy" text DEFAULT 'uploader@example.test',status_updated_at timestamp DEFAULT '2026-01-01')`);
    await db.$executeRawUnsafe(`CREATE TABLE "StagedWarehouse" (id text PRIMARY KEY,"reviewStatus" text DEFAULT 'PENDING',"warehouseId" integer,"reviewedAt" timestamp,city text DEFAULT 'Original')`);
    await db.$executeRawUnsafe(`CREATE TABLE audit_logs (id text PRIMARY KEY,entity text,"entityId" text,action text,"userEmail" text,context text,metadata jsonb,"createdAt" timestamp)`);
    expect((await readSnapshot(db)).warehouses).toEqual([]); // Dry run before adding the columns.
    await migrate(db, true);
});
afterAll(async () => {
    await db.$disconnect();
    if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await root.$disconnect();
});
const log = async (id, entity, entityId, action, userEmail, date, metadata = {}) => db.$executeRaw`
    INSERT INTO audit_logs (id,entity,"entityId",action,"userEmail","createdAt",metadata)
    VALUES (${id},${entity},${entityId},${action},${userEmail},${new Date(date)},${JSON.stringify(metadata)}::jsonb)`;
beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "Warehouse","StagedWarehouse",audit_logs');
    await db.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,"lastEditedBy") VALUES (1,NULL),(2,NULL),(3,NULL),(4,'existing@example.test'),(5,NULL)`);
    await db.$executeRawUnsafe(`INSERT INTO "StagedWarehouse" (id,"reviewStatus","warehouseId","reviewedAt") VALUES ('origin','APPROVED',2,'2026-10-01'),('idle','PENDING',NULL,NULL),('newer','APPROVED',5,'2026-10-03')`);
    await log('w1', 'warehouse', '1', 'UPDATE', 'editor@example.test', '2026-10-02', { changes: [{ field: 'city', from: 'Old', to: 'Original' }] });
    await log('noop', 'warehouse', '1', 'UPDATE', 'other@example.test', '2026-10-03', { changes: [], changeCount: 0 });
    await log('system', 'warehouse', '1', 'UPDATE', 'system:availability-review-backfill', '2026-10-04', { changes: [{ field: 'availabilityLastReviewedOn' }] });
    await log('origin-create', 'staged_warehouse', 'origin', 'CREATE', 'Scout Name', '2026-10-01T00:00:01Z', { source: 'SCOUT', scoutId: 42 });
    await log('origin-approve', 'staged_warehouse', 'origin', 'APPROVE', 'system:auto-approve', '2026-10-01', { warehouseId: 2 });
    await log('existing', 'warehouse', '4', 'UPDATE', 'old@example.test', '2026-10-01', { updatedFields: ['city'] });
    await log('newer-create', 'staged_warehouse', 'newer', 'CREATE', 'creator@example.test', '2026-10-01');
    await log('newer-edit', 'staged_warehouse', 'newer', 'UPDATE', 'reviewer@example.test', '2026-10-02', { changes: [{ field: 'city' }] });
    await log('newer-approve', 'staged_warehouse', 'newer', 'APPROVE', 'approver@example.test', '2026-10-03', { warehouseId: 5 });
    await log('newer-live-edit', 'warehouse', '5', 'UPDATE', 'live-editor@example.test', '2026-10-04', { changes: [{ field: 'city' }] });
});
const prepare = async () => buildPlan(await readSnapshot(db), new Date('2026-11-17'));
const otherData = () => db.$queryRawUnsafe(`SELECT 'warehouse' entity,id::text id,to_jsonb(w)-'lastEditedBy' data FROM "Warehouse" w UNION ALL SELECT 'staged_warehouse',id,to_jsonb(s)-'lastEditedBy' FROM "StagedWarehouse" s ORDER BY entity,id`);
const values = () => db.$queryRawUnsafe('SELECT id,"lastEditedBy" FROM "Warehouse" ORDER BY id');

test('backfills supported blanks, keeps all other data and timestamps, and writes evidence atomically', async () => {
    const before = await otherData();
    const plan = await prepare();
    expect(plan.candidates).toHaveLength(5);
    const receipt = await applyPlan(db, plan);
    expect(receipt.summary).toMatchObject({ written: 5, skippedSincePlan: 0 });
    expect(await verifyPlan(db, receipt)).toEqual({ rows: 5, auditRows: 5 });
    expect(await otherData()).toEqual(before);
    expect(await values()).toEqual([
        { id: 1, lastEditedBy: 'editor@example.test' }, { id: 2, lastEditedBy: '42' },
        { id: 3, lastEditedBy: null }, { id: 4, lastEditedBy: 'existing@example.test' },
        { id: 5, lastEditedBy: 'live-editor@example.test' },
    ]);
    expect((await applyPlan(db, plan))).toMatchObject({ recovered: true, written: receipt.written });
    expect((await prepare()).candidates).toEqual([]);
});

test.each(['row', 'new-audit', 'changed-audit'])('skips a candidate after concurrent %s changes', async kind => {
    const plan = await prepare();
    if (kind === 'row') await db.$executeRawUnsafe(`UPDATE "Warehouse" SET city='Newer' WHERE id=1`);
    if (kind === 'new-audit') await log('concurrent', 'warehouse', '1', 'UPDATE', 'later@example.test', '2026-10-05', { changes: [{ field: 'city' }] });
    if (kind === 'changed-audit') await db.$executeRawUnsafe(`UPDATE audit_logs SET "userEmail"='corrected@example.test' WHERE id='w1'`);
    const receipt = await applyPlan(db, plan);
    expect(receipt.skippedSincePlan).toEqual([{ entity: 'warehouse', id: '1' }]);
    expect((await values())[0].lastEditedBy).toBeNull();
});

test('source changes invalidate inherited evidence as well as the staged candidate', async () => {
    const plan = await prepare();
    await db.$executeRawUnsafe(`UPDATE "StagedWarehouse" SET city='Changed' WHERE id='origin'`);
    const receipt = await applyPlan(db, plan);
    expect(receipt.skippedSincePlan).toEqual(expect.arrayContaining([
        { entity: 'warehouse', id: '2' }, { entity: 'staged_warehouse', id: 'origin' },
    ]));
    expect(receipt.written).toHaveLength(3);
});

test('an altered plan cannot assign an actor unsupported by its audit evidence', async () => {
    const plan = await prepare();
    plan.candidates.find(row => row.entity === 'warehouse' && row.id === '1').value = 'forged@example.test';
    await expect(applyPlan(db, plan)).rejects.toThrow(/evidence/i);
    expect((await values())[0].lastEditedBy).toBeNull();
});

test('an interrupted caller can recover the original receipt by reapplying the same plan', async () => {
    const plan = await prepare();
    const original = await applyPlan(db, plan);
    // Simulate losing the local receipt after the database commit.
    const recovered = await applyPlan(db, JSON.parse(JSON.stringify(plan)));
    expect(recovered.recovered).toBe(true);
    expect(recovered.written).toEqual(original.written);
    expect(await verifyPlan(db, recovered)).toEqual({ rows: 5, auditRows: 5 });
});

test('audit failure rolls back all attribution writes', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_backfill_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'source'='LAST_EDITED_BY_BACKFILL' THEN RAISE EXCEPTION 'test log failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_backfill_log BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_backfill_log()');
    try {
        const before = await values();
        await expect(applyPlan(db, await prepare())).rejects.toThrow();
        expect(await values()).toEqual(before);
        expect((await prepare()).candidates).toHaveLength(5);
    } finally {
        await db.$executeRawUnsafe('DROP TRIGGER fail_backfill_log ON audit_logs');
        await db.$executeRawUnsafe('DROP FUNCTION fail_backfill_log()');
    }
});

test('rollback preserves rows edited after the backfill', async () => {
    const receipt = await applyPlan(db, await prepare());
    await db.$executeRawUnsafe(`UPDATE "Warehouse" SET city='Newer' WHERE id=1`);
    const updates = rollbackSql(receipt).split('\n').filter(line => line.startsWith('UPDATE'));
    await db.$transaction(updates.map(sql => db.$executeRawUnsafe(sql)));
    expect((await values()).map(row => row.lastEditedBy)).toEqual(['editor@example.test', null, null, 'existing@example.test', null]);
});

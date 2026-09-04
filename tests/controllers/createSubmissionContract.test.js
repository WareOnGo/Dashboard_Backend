/**
 * Contract tests for the create endpoints' 201 body.
 *
 * The unit tests cover `toSubmissionResult` and `maybeAutoApprove` in isolation; these drive
 * the real controller + real StagingService + real StagedWarehouseModel over Express with a
 * stubbed Prisma, and assert on the JSON a client actually receives. They exist because the
 * response shape is the whole point of the staging/autopilot split — the submitter needs the
 * master warehouse id when autopilot published the entry and a staging reference when it
 * didn't — and nothing else asserts the two are never confused.
 */
const express = require('express');
const request = require('supertest');
const WarehouseController = require('../../src/controllers/warehouseController');
const StagingController = require('../../src/controllers/stagingController');
const StagingService = require('../../src/services/stagingService');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');

const SUBMISSION = {
    warehouseType: 'Industrial', address: '1 Test Rd', city: 'Indore', state: 'Madhya Pradesh',
    contactPerson: 'Tester', contactNumber: '9999999999', totalSpaceSqft: [10000],
    compliances: 'CLU', ratePerSqft: '25', uploadedBy: 'EMP7',
    warehouseData: { latitude: 22.7, longitude: 75.8, powerKva: '500' },
};

const SCOUT = { id: 7, empid: 'EMP7', name: 'Scout Seven', email: 'scout7@wareongo.com' };

/**
 * A Prisma double holding staged rows and warehouses in memory, honouring the `where`
 * guards promote()/releaseClaim() rely on so the claim semantics are actually exercised.
 * `linkFails` makes the step-3 link throw, the failure mode that used to strand a live
 * warehouse the staged row could not point at.
 */
function makePrisma({ linkFails = false } = {}) {
    const staged = [];
    const warehouses = new Map();
    let seq = 1700;

    return {
        staged,
        warehouses,
        stagedWarehouse: {
            create: async ({ data }) => {
                // Mirrors the schema defaults Prisma would apply on insert.
                const row = {
                    id: `staged-uuid-${staged.length + 1}`,
                    submittedAt: new Date(),
                    warehouseId: null,
                    ...data,
                };
                staged.push(row);
                return row;
            },
            updateMany: async ({ where, data }) => {
                // The link write carries only `warehouseId`; the claim and release both
                // set `reviewStatus`. That is how the failure injection tells them apart.
                const isLink = data.reviewStatus === undefined;
                if (isLink && linkFails) throw new Error('P1001: cannot reach database server');

                const row = staged.find((r) => r.id === where.id);
                if (!row) return { count: 0 };
                if (where.reviewStatus) {
                    const allowed = where.reviewStatus.in || [where.reviewStatus];
                    if (!allowed.includes(row.reviewStatus)) return { count: 0 };
                }
                if (where.reviewedBy && row.reviewedBy !== where.reviewedBy) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            update: async ({ where, data }) => {
                const row = staged.find((r) => r.id === where.id);
                Object.assign(row, data);
                return row;
            },
            findUnique: async ({ where }) => staged.find((r) => r.id === where.id) || null,
            findMany: async () => [],
        },
        warehouse: {
            create: async ({ data }) => {
                const created = { id: ++seq, ...data };
                warehouses.set(created.id, created);
                return created;
            },
            delete: async ({ where }) => {
                const removed = warehouses.get(where.id);
                warehouses.delete(where.id);
                return removed;
            },
            findMany: async ({ where }) => (where.id.in || [])
                .filter((id) => warehouses.has(id))
                .map((id) => ({ id })),
        },
        auditLog: { create: async () => ({}) },
    };
}

function build({ autopilot = true, linkFails = false } = {}) {
    const prisma = makePrisma({ linkFails });
    const stagingService = new StagingService(
        new StagedWarehouseModel(prisma),
        { applyCreateBusinessRules: (d) => ({ ...d }), applyMicroMarketTags: async () => {} },
        { getAutoApprove: async () => autopilot },
    );

    const warehouseController = new WarehouseController({}, {}, stagingService);
    const stagingController = new StagingController(stagingService, {});

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.scout = SCOUT;
        req.user = { id: 1, email: 'ops@wareongo.com', name: 'Ops' };
        req.audit = () => {};
        next();
    });
    app.post('/api/warehouses/scout', warehouseController.createScoutWarehouse);
    app.post('/api/warehouses', warehouseController.createWarehouse);
    app.post('/api/staging/ingest', stagingController.ingestSubmission);
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));

    return { app, prisma };
}

describe('create endpoints — submission receipt', () => {
    it('hands the submitter the master warehouse id when autopilot promoted the entry', async () => {
        const { app, prisma } = build({ autopilot: true });

        const res = await request(app).post('/api/warehouses/scout').send(SUBMISSION);

        expect(res.status).toBe(201);
        expect(typeof res.body.warehouseId).toBe('number');
        expect(res.body.autoApproved).toBe(true);
        expect(res.body.reviewStatus).toBe('APPROVED');
        // The staging uuid stays available under both names for review/pullback.
        expect(res.body.submissionId).toBe(prisma.staged[0].id);
        expect(res.body.id).toBe(res.body.submissionId);
        // The receipt matches what the database actually holds.
        expect(prisma.staged[0].warehouseId).toBe(res.body.warehouseId);
        expect(prisma.warehouses.has(res.body.warehouseId)).toBe(true);
    });

    it('hands the submitter a staging reference when the entry is queued for review', async () => {
        const { app, prisma } = build({ autopilot: false });

        const res = await request(app).post('/api/warehouses/scout').send(SUBMISSION);

        expect(res.status).toBe(201);
        expect(res.body.warehouseId).toBeNull();
        expect(res.body.autoApproved).toBe(false);
        expect(res.body.reviewStatus).toBe('PENDING');
        expect(typeof res.body.submissionId).toBe('string');
        expect(prisma.staged[0].reviewStatus).toBe('PENDING');
        expect(prisma.warehouses.size).toBe(0);
    });

    it('never echoes the submission snapshot back to the client', async () => {
        const { app } = build({ autopilot: true });

        const res = await request(app).post('/api/warehouses/scout').send(SUBMISSION);

        // rawPayload duplicates the entire submission; warehouseDeleted is a read-time
        // annotation that means nothing on a fresh row.
        expect(res.body).not.toHaveProperty('rawPayload');
        expect(res.body).not.toHaveProperty('warehouseDeleted');
    });

    it('applies the same contract to the dashboard create', async () => {
        const { app } = build({ autopilot: true });

        const res = await request(app).post('/api/warehouses').send(SUBMISSION);

        expect(res.status).toBe(201);
        expect(typeof res.body.warehouseId).toBe('number');
        expect(res.body.autoApproved).toBe(true);
    });

    it('keeps the partner webhook response additive, not narrowed', async () => {
        // External partners may be reading any mirror column off this body, so the receipt
        // fields are layered onto the staged row rather than replacing it.
        const { app } = build({ autopilot: true });

        const res = await request(app).post('/api/staging/ingest').send(SUBMISSION);

        expect(res.status).toBe(201);
        expect(res.body.warehouseId).toEqual(expect.any(Number));
        expect(res.body.autoApproved).toBe(true);
        // Pre-existing fields a partner could already have been reading.
        expect(res.body.source).toBe('PARTNER_API');
        expect(res.body.address).toBe(SUBMISSION.address);
        expect(res.body.submittedBy).toBe('webhook:partner_api');
        expect(res.body).toHaveProperty('submittedAt');
        // ...but still without the heavy snapshot.
        expect(res.body).not.toHaveProperty('rawPayload');
    });

    it('degrades to "queued for review" instead of failing when a promotion breaks', async () => {
        // The row is already durably written by this point, so the submitter must not get an
        // error for work that was saved — and the receipt must agree with the database.
        const { app, prisma } = build({ autopilot: true, linkFails: true });

        const res = await request(app).post('/api/warehouses/scout').send(SUBMISSION);

        expect(res.status).toBe(201);
        expect(res.body.reviewStatus).toBe('PENDING');
        expect(res.body.warehouseId).toBeNull();
        expect(res.body.autoApproved).toBe(false);
        expect(prisma.staged[0].reviewStatus).toBe('PENDING');
        expect(prisma.staged[0].reviewedBy).toBeNull();
        // No warehouse left live that the staged row can no longer point at.
        expect(prisma.warehouses.size).toBe(0);
    });
});

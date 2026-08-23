/**
 * Wiring tests for UPDATE audit diffs.
 *
 * The unit tests in tests/utils/auditDiff.test.js cover the differ itself; these
 * drive the real controller + real service + real audit middleware over Express
 * with a stubbed model, and assert on the entry that would reach `audit_logs`.
 * They exist because the pre-existing route tests use a mock controller and so
 * never touch this path.
 */
const express = require('express');
const request = require('supertest');
const createAuditMiddleware = require('../../src/middleware/auditMiddleware');
const WarehouseController = require('../../src/controllers/warehouseController');
const WarehouseService = require('../../src/services/warehouseService');
const VisitNoteController = require('../../src/controllers/visitNoteController');
const VisitNoteService = require('../../src/services/visitNoteService');
const VisitNoteValidator = require('../../src/validators/visitNoteValidator');
const MicroMarketController = require('../../src/controllers/microMarketController');
const MicroMarketService = require('../../src/services/microMarketService');

/** Build an app around one handler, capturing what the audit service is asked to write. */
function mount(register) {
    const captured = [];
    const app = express();
    app.use(express.json());
    app.use(createAuditMiddleware({ log: async (entry) => { captured.push(entry); } }));
    app.use((req, _res, next) => {
        req.user = { id: 7, email: 'ops@wareongo.com', name: 'Ops' };
        next();
    });
    register(app);
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
    return { app, captured };
}

/** Audit writes are flushed on res.on('finish'), so yield a tick before asserting. */
const flushed = () => new Promise((resolve) => setImmediate(resolve));

const WAREHOUSE = {
    id: 42, city: 'Pune', state: 'Maharashtra', ratePerSqft: '25', availability: 'Immediate',
    contactNumber: '9876543210', contactPerson: 'Asha', warehouseType: 'RCC', address: 'Plot 4',
    zone: 'West', compliances: 'GST', uploadedBy: 'ops@wareongo.com', totalSpaceSqft: [10000],
    visibility: true, WarehouseData: { latitude: 18.5, longitude: 73.8, powerKva: '500' },
};

function warehouseApp(row = WAREHOUSE) {
    const model = {
        findById: async () => (row ? JSON.parse(JSON.stringify(row)) : null),
        update: async (_id, data) => ({
            ...(row || {}), ...data,
            WarehouseData: { ...(row?.WarehouseData || {}), ...(data.warehouseData || {}) },
        }),
    };
    const controller = new WarehouseController(new WarehouseService(model), {});
    return mount((app) => app.put('/api/warehouses/:id', controller.updateWarehouse));
}

describe('warehouse UPDATE audit diff', () => {
    it('records before/after for changed fields and omits untouched ones', async () => {
        const { app, captured } = warehouseApp();
        const res = await request(app).put('/api/warehouses/42').send({
            city: 'Mumbai',
            ratePerSqft: '30',
            totalSpaceSqft: [10000],                              // unchanged
            warehouseData: { latitude: 19.07, powerKva: '500' },  // powerKva unchanged
        });
        await flushed();

        expect(res.status).toBe(200);
        expect(captured).toHaveLength(1);
        expect(captured[0].metadata.changes).toEqual([
            { field: 'city', from: 'Pune', to: 'Mumbai' },
            { field: 'ratePerSqft', from: '25', to: '30' },
            { field: 'warehouseData.latitude', from: 18.5, to: 19.07 },
        ]);
        expect(captured[0].metadata.updatedFields).toEqual(['city', 'ratePerSqft', 'warehouseData.latitude']);
        expect(captured[0].context).toContain('city, ratePerSqft, warehouseData.latitude');
    });

    it('keeps returning the bare warehouse — the diff never reaches the client', async () => {
        const { app } = warehouseApp();
        const res = await request(app).put('/api/warehouses/42').send({ city: 'Mumbai' });

        expect(res.body.id).toBe(42);
        expect(res.body.changes).toBeUndefined();
        expect(res.body.warehouse).toBeUndefined();
        // Contact redaction is unchanged by the diff work.
        expect(res.body.contactNumber).toBeUndefined();
    });

    it('masks the contact number rather than recording it verbatim', async () => {
        const { app, captured } = warehouseApp();
        await request(app).put('/api/warehouses/42').send({ contactNumber: '9990001234' });
        await flushed();

        const change = captured[0].metadata.changes.find((c) => c.field === 'contactNumber');
        expect(change).toMatchObject({ masked: true });
        expect(change.from).not.toContain('9876');
        expect(change.to).not.toContain('9990');
        expect(change.to.endsWith('1234')).toBe(true);
    });

    it('records a no-op write with an empty diff rather than inventing changes', async () => {
        const { app, captured } = warehouseApp();
        await request(app).put('/api/warehouses/42').send({ city: 'Pune', ratePerSqft: '25' });
        await flushed();

        expect(captured[0].metadata.changes).toEqual([]);
        expect(captured[0].metadata.changeCount).toBe(0);
        expect(captured[0].context).toContain('no field changed');
    });

    it('reports cleared fields and flipped booleans', async () => {
        const { app, captured } = warehouseApp();
        await request(app).put('/api/warehouses/42').send({ availability: null, visibility: false });
        await flushed();

        expect(captured[0].metadata.changes).toEqual([
            { field: 'availability', from: 'Immediate', to: null },
            { field: 'visibility', from: true, to: false },
        ]);
    });

    it('treats an absent nested relation as empty instead of throwing', async () => {
        const { app, captured } = warehouseApp({ ...WAREHOUSE, WarehouseData: null });
        const res = await request(app).put('/api/warehouses/42')
            .send({ warehouseData: { latitude: 19.07 } });
        await flushed();

        expect(res.status).toBe(200);
        expect(captured[0].metadata.changes).toEqual([
            { field: 'warehouseData.latitude', from: null, to: 19.07 },
        ]);
    });

    it('still 404s on a missing row, writing no audit entry', async () => {
        const { app, captured } = warehouseApp(null);
        const res = await request(app).put('/api/warehouses/999').send({ city: 'Mumbai' });
        await flushed();

        expect(res.status).toBe(404);
        expect(captured).toHaveLength(0);
    });

    it('bounds the entry when a large photo set is replaced', async () => {
        const { app, captured } = warehouseApp();
        const photos = JSON.stringify(
            Array.from({ length: 60 }, (_, i) => `https://cdn.example.com/some/long/path/photo-${i}.jpg`),
        );
        await request(app).put('/api/warehouses/42').send({ photos });
        await flushed();

        expect(captured[0].metadata.changes[0].field).toBe('photos');
        expect(JSON.stringify(captured[0].metadata).length).toBeLessThan(2000);
    });
});

describe('visit note UPDATE audit diff', () => {
    const NOTE = {
        id: 11, warehouseId: 42, client: 'Acme', clientPoc: 'Ravi', wareOnGoPoc: null,
        visitDate: new Date('2026-08-01T00:00:00.000Z'), clientFeedback: 'good', pocFeedback: null,
    };

    function noteApp() {
        const model = {
            getById: async () => ({ ...NOTE }),
            updateById: async (_id, data) => ({ ...NOTE, ...data }),
        };
        const controller = new VisitNoteController(new VisitNoteService(model));
        return mount((app) => app.put('/w/:id/notes/:noteId', (req, res, next) => {
            // Mirror the real validation middleware: zod transforms visitDate to a Date.
            const parsed = VisitNoteValidator.updateVisitNoteSchema.safeParse(req.body);
            if (!parsed.success) return res.status(400).json({ error: 'invalid' });
            req.body = parsed.data;
            next();
        }, controller.update));
    }

    it('does not report a change when the same date is re-sent as YYYY-MM-DD', async () => {
        const { app, captured } = noteApp();
        await request(app).put('/w/42/notes/11').send({ visitDate: '2026-08-01', client: 'Acme' });
        await flushed();

        expect(captured[0].metadata.changes).toEqual([]);
    });

    it('records a real date change as ISO instants', async () => {
        const { app, captured } = noteApp();
        const res = await request(app).put('/w/42/notes/11')
            .send({ visitDate: '2026-09-15', pocFeedback: 'follow up' });
        await flushed();

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(11);
        expect(captured[0].metadata.changes).toEqual([
            { field: 'visitDate', from: '2026-08-01T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
            { field: 'pocFeedback', from: null, to: 'follow up' },
        ]);
        expect(captured[0].metadata.warehouseId).toBe(42);
    });
});

describe('micro-market UPDATE audit diff', () => {
    it('summarizes polygon geometry instead of inlining both versions', async () => {
        const ring = Array.from({ length: 120 }, (_, i) => [77 + i * 0.001, 12 + i * 0.001]);
        const existing = {
            id: 'p1', name: 'Nelamangala', city: 'Bengaluru',
            geometry: { type: 'Polygon', coordinates: [ring] },
        };
        const model = {
            getById: async () => existing,
            updateById: async (_id, data) => ({ ...existing, ...data }),
            listForTagging: async () => [],
        };
        const controller = new MicroMarketController(new MicroMarketService(model));
        const { app, captured } = mount((a) => a.put('/mm/:id', controller.update));

        const res = await request(app).put('/mm/p1').send({
            name: 'Nelamangala North',
            geometry: { type: 'Polygon', coordinates: [ring.map(([x, y]) => [x + 0.5, y])] },
        });
        await flushed();

        expect(res.status).toBe(200);
        const byField = Object.fromEntries(captured[0].metadata.changes.map((c) => [c.field, c]));
        expect(byField.name).toEqual({ field: 'name', from: 'Nelamangala', to: 'Nelamangala North' });
        expect(byField.geometry.from.__summary).toBe('object');
        expect(byField.geometry.to.__summary).toBe('object');
        expect(JSON.stringify(captured[0].metadata).length).toBeLessThan(1000);
    });
});

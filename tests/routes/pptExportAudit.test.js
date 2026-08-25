/**
 * Acceptance tests for POST /api/audit/ppt-export (see PPT_AUDIT_SPEC.md §4).
 *
 * Mounts the REAL router — real authenticateJWT, real validator, real
 * controller, real audit middleware — and stubs only the audit sink, so the
 * assertions cover the actual wiring without any test row reaching the
 * production audit_logs table.
 */
const express = require('express');
const request = require('supertest');
const JWTService = require('../../src/services/jwtService');
const AuditValidator = require('../../src/validators/auditValidator');
const createAuditMiddleware = require('../../src/middleware/auditMiddleware');
const ErrorHandler = require('../../src/middleware/errorHandler');

const token = new JWTService().generateToken({
    id: 1, email: 'ops@wareongo.com', name: 'Ops', domain: 'wareongo.com',
});

/** App with the real audit router; `captured` receives what would be persisted. */
function makeApp() {
    const captured = [];
    const app = express();
    // Mirror app.js:75 — with the default 100kb limit the oversized-body case
    // would be caught by body-parser (413) instead of reaching validation.
    app.use(express.json({ limit: '10mb' }));
    app.use(createAuditMiddleware({ log: async (entry) => { captured.push(entry); } }));
    app.use('/api/audit', require('../../src/routes/audit'));
    app.use(ErrorHandler.handleError
        ? ErrorHandler.handleError
        : (err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
    return { app, captured };
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));

const VALID = {
    variant: 'detailed',
    warehouseIds: [101, 102, 103],
    outcome: 'success',
    httpStatus: 200,
    bytes: 2_400_000,
    durationMs: 45_000,
    clientName: 'Acme Logistics',
    clientRequirement: '50k sqft near Bhiwandi',
    selectedImageCount: 12,
};

const post = (app, body, auth = true) => {
    const req = request(app).post('/api/audit/ppt-export');
    if (auth) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
};

describe('POST /api/audit/ppt-export', () => {
    it('writes one EXPORT row attributed to the JWT user (criterion 1)', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, VALID);
        await flushed();

        expect(res.status).toBe(204);
        expect(captured).toHaveLength(1);
        expect(captured[0]).toMatchObject({
            action: 'EXPORT',
            entity: 'presentation',
            userEmail: 'ops@wareongo.com',
            userName: 'Ops',
        });
        expect(captured[0].metadata).toMatchObject({
            variant: 'detailed',
            warehouseIds: [101, 102, 103],
            warehouseCount: 3,
            outcome: 'success',
            bytes: 2_400_000,
            selectedImageCount: 12,
            reportedBy: 'client',
        });
        expect(captured[0].context).toBe('Exported detailed PPT (3 warehouses) for Acme Logistics');
    });

    // Driven off the exported list, so adding a variant to the enum without
    // covering it here is not possible.
    it.each(AuditValidator.PPT_VARIANTS)(
        'accepts the %s variant and records it (criterion 2)', async (variant) => {
            const { app, captured } = makeApp();
            const res = await post(app, { ...VALID, variant });
            await flushed();

            expect(res.status).toBe(204);
            expect(captured[0].metadata.variant).toBe(variant);
        });

    it('records a failed generation with its status and message (criterion 3)', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, {
            variant: 'tci', warehouseIds: [7], outcome: 'failed',
            httpStatus: 500, errorMessage: 'Engine exploded',
        });
        await flushed();

        expect(res.status).toBe(204);
        expect(captured[0].metadata).toMatchObject({
            outcome: 'failed', httpStatus: 500, errorMessage: 'Engine exploded',
        });
        expect(captured[0].context).toContain('FAILED (HTTP 500)');
    });

    it('cannot be used to forge another action or entity (criterion 5)', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, { ...VALID, action: 'DELETE', entity: 'warehouse' });
        await flushed();

        // .strict() rejects the unknown keys outright, so nothing is written at all —
        // strictly safer than accepting the body and ignoring them.
        expect(res.status).toBe(400);
        expect(captured).toHaveLength(0);
    });

    it('cannot be used to write a row as another user (criterion 6)', async () => {
        const { app, captured } = makeApp();
        // userEmail is not in the schema, so a body carrying it is rejected;
        // attribution can only ever come from the JWT.
        const res = await post(app, { ...VALID, userEmail: 'someone.else@wareongo.com' });
        await flushed();

        expect(res.status).toBe(400);
        expect(captured).toHaveLength(0);
    });

    it('rejects an unauthenticated report and writes nothing (criterion 7)', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, VALID, false);
        await flushed();

        expect(res.status).toBe(401);
        expect(captured).toHaveLength(0);
    });

    it('rejects a garbage token', async () => {
        const { app, captured } = makeApp();
        const res = await request(app).post('/api/audit/ppt-export')
            .set('Authorization', 'Bearer not-a-real-token').send(VALID);
        await flushed();

        expect(res.status).toBe(401);
        expect(captured).toHaveLength(0);
    });

    it('rejects an oversized body rather than storing it (criterion 8)', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, { ...VALID, errorMessage: 'e'.repeat(5 * 1024 * 1024) });
        await flushed();

        expect(res.status).toBe(400);
        expect(captured).toHaveLength(0);
    });

    it('truncates a merely-long error message instead of dropping the row', async () => {
        const { app, captured } = makeApp();
        const res = await post(app, {
            variant: 'v2', warehouseIds: [1], outcome: 'failed', errorMessage: 'e'.repeat(1200),
        });
        await flushed();

        expect(res.status).toBe(204);
        expect(captured[0].metadata.errorMessage).toHaveLength(500);
    });

    it.each([
        ['an unknown variant', { ...VALID, variant: 'standard' }],
        ['a bogus outcome', { ...VALID, outcome: 'maybe' }],
        ['more than 200 warehouse ids', { ...VALID, warehouseIds: Array.from({ length: 201 }, (_, i) => i + 1) }],
        ['non-integer warehouse ids', { ...VALID, warehouseIds: ['drop table'] }],
        ['a missing variant', { warehouseIds: [1], outcome: 'success' }],
    ])('rejects %s', async (_label, body) => {
        const { app, captured } = makeApp();
        const res = await post(app, body);
        await flushed();

        expect(res.status).toBe(400);
        expect(captured).toHaveLength(0);
    });

    /**
     * The schema is .strict(), so a field the frontend starts sending that the
     * backend does not know would 400 and silently lose the row — and the client
     * fires this without reading the response. These are the exact payload shapes
     * captured from Frontend_Repository's pptService; update them together.
     */
    describe('frontend payload contract', () => {
        it.each([
            ['fullest success', {
                variant: 'detailed', warehouseIds: [1, 2, 3], outcome: 'success',
                selectedImageCount: 1, clientName: 'Acme', companyName: 'Acme Pvt',
                clientRequirement: '50k sqft', httpStatus: 200, bytes: 2048, durationMs: 16,
            }],
            ['minimal success (no client details, no ids)', {
                variant: 'tci', warehouseIds: [], outcome: 'success',
                selectedImageCount: 0, httpStatus: 200, bytes: 2048, durationMs: 1,
            }],
            ['engine failure', {
                variant: 'v2', warehouseIds: [9], outcome: 'failed', selectedImageCount: 0,
                httpStatus: 502, errorMessage: 'bad gateway', durationMs: 0,
            }],
        ])('accepts the %s payload the frontend actually sends', async (_label, body) => {
            const { app, captured } = makeApp();
            const res = await post(app, body);
            await flushed();

            expect(res.status).toBe(204);
            expect(captured[0].metadata.variant).toBe(body.variant);
            expect(captured[0].metadata.outcome).toBe(body.outcome);
        });
    });

    it('omits optional fields the client did not send, rather than storing nulls', async () => {
        const { app, captured } = makeApp();
        await post(app, { variant: 'v2', warehouseIds: [1], outcome: 'success' });
        await flushed();

        const metadata = captured[0].metadata;
        expect('bytes' in metadata).toBe(false);
        expect('clientName' in metadata).toBe(false);
        expect(metadata.context).toBeUndefined();
        expect(captured[0].context).toBe('Exported v2 PPT (1 warehouse)');
    });
});

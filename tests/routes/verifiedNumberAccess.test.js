/**
 * Access-control acceptance tests for the VerifiedNumber routes.
 *
 * Two rules are pinned here, and they pull in opposite directions:
 *
 *  1. `GET /api/verified-numbers` must stay JWT-only. It backs the POC picker in the
 *     PPT config modal for every user, so adding a capability gate would break export
 *     for anyone without the flag — the exact failure the pptAccess suite exists for.
 *  2. Everything under `/admin` must require CAPS.ADMIN, because those routes write to
 *     the table that decides who can access what.
 */
process.env.JWT_SECRET = 'test-only-secret-for-the-verified-number-access-suite';

const express = require('express');
const request = require('supertest');
const JWTService = require('../../src/services/jwtService');

const NON_ADMIN = { id: 7, email: 'nobody-special@wareongo.com', name: 'Sales', domain: 'wareongo.com' };
const ADMIN = { id: 8, email: 'boss@wareongo.com', name: 'Boss', domain: 'wareongo.com' };

const ALL_CAPS = { DASHBOARD: true, CALL_DASHBOARD: true, REVIEW: true, ADMIN: true };

// jest.mock factories are hoisted, so anything they close over must be `mock`-prefixed.
let mockCapabilityLookups = 0;
let mockCapsByEmail = {};

jest.mock('../../src/utils/access', () => {
    const actual = jest.requireActual('../../src/utils/access');
    return {
        ...actual,
        resolveCapabilities: jest.fn(async (email) => {
            mockCapabilityLookups += 1;
            return mockCapsByEmail[email]
                || { DASHBOARD: false, CALL_DASHBOARD: false, REVIEW: false, ADMIN: false };
        }),
    };
});

// Stub the controller — this suite is about who gets in, not what comes back.
const mockHandlers = {
    list: jest.fn((req, res) => res.status(200).json({ data: [] })),
    adminList: jest.fn((req, res) => res.status(200).json({ data: [] })),
    adminCreate: jest.fn((req, res) => res.status(201).json({ id: 1 })),
    adminUpdate: jest.fn((req, res) => res.status(200).json({ id: 1 })),
};
jest.mock('../../src/container', () => ({
    resolve: (name) => (name === 'verifiedNumberController' ? mockHandlers : {}),
}));

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/verified-numbers', require('../../src/routes/verifiedNumbers'));
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    return app;
}

const tokenFor = (user) => new JWTService().generateToken(user);

beforeEach(() => {
    mockCapabilityLookups = 0;
    mockCapsByEmail = { [ADMIN.email]: ALL_CAPS };
    Object.values(mockHandlers).forEach((h) => h.mockClear());
});

describe('GET /api/verified-numbers (POC picker)', () => {
    it('lets a signed-in user with no capabilities through', async () => {
        const res = await request(makeApp())
            .get('/api/verified-numbers')
            .set('Authorization', `Bearer ${tokenFor(NON_ADMIN)}`);

        expect(res.status).toBe(200);
        expect(mockHandlers.list).toHaveBeenCalled();
    });

    it('does not consult the capability system at all', async () => {
        await request(makeApp())
            .get('/api/verified-numbers')
            .set('Authorization', `Bearer ${tokenFor(NON_ADMIN)}`);

        expect(mockCapabilityLookups).toBe(0);
    });

    it('still rejects an unauthenticated caller', async () => {
        const res = await request(makeApp()).get('/api/verified-numbers');
        expect(res.status).toBe(401);
    });
});

describe('admin routes', () => {
    const CASES = [
        ['get', '/api/verified-numbers/admin', undefined, 'adminList'],
        ['post', '/api/verified-numbers/admin', { name: 'X', email: 'x@wareongo.com' }, 'adminCreate'],
        ['patch', '/api/verified-numbers/admin/1', { name: 'X' }, 'adminUpdate'],
    ];

    it.each(CASES)('%s %s rejects a non-admin with 403', async (method, path, body, handler) => {
        const res = await request(makeApp())[method](path)
            .set('Authorization', `Bearer ${tokenFor(NON_ADMIN)}`)
            .send(body);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_CAPABILITY');
        expect(mockHandlers[handler]).not.toHaveBeenCalled();
    });

    it.each(CASES)('%s %s rejects an unauthenticated caller with 401', async (method, path, body, handler) => {
        const res = await request(makeApp())[method](path).send(body);

        expect(res.status).toBe(401);
        expect(mockHandlers[handler]).not.toHaveBeenCalled();
    });

    it.each(CASES)('%s %s admits an admin', async (method, path, body, handler) => {
        const res = await request(makeApp())[method](path)
            .set('Authorization', `Bearer ${tokenFor(ADMIN)}`)
            .send(body);

        expect(res.status).toBeLessThan(400);
        expect(mockHandlers[handler]).toHaveBeenCalled();
    });

    it('has no DELETE route — offboarding is a PATCH to is_active', async () => {
        const res = await request(makeApp())
            .delete('/api/verified-numbers/admin/1')
            .set('Authorization', `Bearer ${tokenFor(ADMIN)}`);

        expect(res.status).toBe(404);
    });

    it('rejects an unknown column before it reaches the controller', async () => {
        const res = await request(makeApp())
            .patch('/api/verified-numbers/admin/1')
            .set('Authorization', `Bearer ${tokenFor(ADMIN)}`)
            .send({ twenty_user_id: 'not-yours-to-set' });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(mockHandlers.adminUpdate).not.toHaveBeenCalled();
    });
});

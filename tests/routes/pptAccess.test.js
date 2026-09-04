/**
 * Access-control acceptance tests for the PPT generation routes.
 *
 * These routes now require CAPS.DASHBOARD, matching GET /api/warehouses: if you
 * can see the warehouses, you can put them in a deck.
 *
 * This suite previously pinned the opposite rule. That was a regression guard
 * from an earlier attempt to gate these routes on a column set on nobody, where
 * every non-admin got a 403 at the end of a deck they had already waited for
 * while admins sailed through on the master-override. The gate is only correct
 * because that precondition has since been met — dashboardAccess was backfilled
 * for every active employee before it was switched on.
 *
 * So what is pinned here is the shape of the failure, not the absence of a gate:
 * a user *holding* the capability must get through, and one lacking it must be
 * refused with a clear 403 rather than a partial deck.
 */
process.env.JWT_SECRET = 'test-only-secret-for-the-ppt-access-suite';

const express = require('express');
const request = require('supertest');
const JWTService = require('../../src/services/jwtService');

// An ordinary employee: not an admin, but holding DASHBOARD like every active
// member of the roster does.
const STAFF = { id: 7, email: 'nobody-special@wareongo.com', name: 'Sales', domain: 'wareongo.com' };
// Someone off the roster entirely — no VerifiedNumber row, so no capabilities.
const OUTSIDER = { id: 8, email: 'stranger@wareongo.com', name: 'Stranger', domain: 'wareongo.com' };

let mockCapabilityLookups = 0;

jest.mock('../../src/utils/access', () => {
    const actual = jest.requireActual('../../src/utils/access');
    const GRANTED = { DASHBOARD: true, CALL_DASHBOARD: false, REVIEW: false, ADMIN: false };
    const NONE = { DASHBOARD: false, CALL_DASHBOARD: false, REVIEW: false, ADMIN: false };
    return {
        ...actual,
        resolveCapabilities: jest.fn(async (email) => {
            mockCapabilityLookups += 1;
            return email === 'nobody-special@wareongo.com' ? GRANTED : NONE;
        }),
    };
});

// Stub generation itself — this suite is about who gets in, not deck contents.
const mockGenerate = jest.fn((req, res) => res.status(200).send(Buffer.from('fake-pptx')));
jest.mock('../../src/container', () => ({
    resolve: (name) => {
        if (name === 'pptController') return { handleGenerate: () => mockGenerate };
        return {};
    },
}));

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', require('../../src/routes/ppt'));
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    return app;
}

const ROUTES = [
    '/api/generate-ppt',
    '/api/generate-ppt-v2',
    '/api/generate-ppt-v3',
    '/api/generate-ppt-godamwale',
    '/api/generate-ppt-tci',
    '/api/generate-xlsx-last-mile',
    '/api/generate-detailed-ppt',
];

beforeEach(() => { mockCapabilityLookups = 0; mockGenerate.mockClear(); });

describe('PPT route access control', () => {
    const token = (user = STAFF) => new JWTService().generateToken(user);

    it.each(ROUTES)('%s lets an ordinary employee with DASHBOARD through', async (route) => {
        const res = await request(makeApp())
            .post(route)
            .set('Authorization', `Bearer ${token()}`)
            .send({ ids: '1877' });

        expect(res.status).toBe(200);
        expect(mockGenerate).toHaveBeenCalled();
    });

    it.each(ROUTES)('%s refuses someone without the capability, before generating', async (route) => {
        const res = await request(makeApp())
            .post(route)
            .set('Authorization', `Bearer ${token(OUTSIDER)}`)
            .send({ ids: '1877' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_CAPABILITY');
        // The refusal must come before any work, not after a deck was built.
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('consults the capability system exactly once per request', async () => {
        await request(makeApp())
            .post('/api/generate-ppt-v2')
            .set('Authorization', `Bearer ${token()}`)
            .send({ ids: '1877' });

        expect(mockCapabilityLookups).toBe(1);
    });

    it.each(ROUTES)('%s still rejects an unauthenticated caller', async (route) => {
        const res = await request(makeApp()).post(route).send({ ids: '1877' });

        expect(res.status).toBe(401);
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    // The router is mounted flat at /api, so its middleware must not swallow
    // paths it does not own and turn a 404 into a 401.
    it('leaves unmatched /api paths as 404, not 401', async () => {
        const res = await request(makeApp()).get('/api/not-a-real-route');
        expect(res.status).toBe(404);
    });
});

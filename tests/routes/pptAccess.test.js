/**
 * Access-control acceptance tests for the PPT generation routes.
 *
 * Regression guard. These routes briefly required CAPS.DASHBOARD, which reads
 * VerifiedNumber.dashboardAccess — a column set on nobody. Every non-admin got
 * a 403 at the end of a deck they had already waited for, while admins sailed
 * through on the master-override, so it looked fine to whoever tested it.
 *
 * The rule these tests pin down: a signed-in user needs no capability to export,
 * and no capability lookup happens at all. If someone reintroduces a gate here,
 * `resolveCapabilities` starts getting called and the non-admin case starts
 * failing — both of which this suite catches.
 */
process.env.JWT_SECRET = 'test-only-secret-for-the-ppt-access-suite';

const express = require('express');
const request = require('supertest');
const JWTService = require('../../src/services/jwtService');

// A plain signed-in user: no admin email, no capability columns set — exactly
// the shape that was locked out.
const NON_ADMIN = { id: 7, email: 'nobody-special@wareongo.com', name: 'Sales', domain: 'wareongo.com' };

let mockCapabilityLookups = 0;

jest.mock('../../src/utils/access', () => {
    const actual = jest.requireActual('../../src/utils/access');
    return {
        ...actual,
        // Fail closed the way production does for a user with no flags, and
        // count calls so a reintroduced gate is visible even if it somehow passes.
        resolveCapabilities: jest.fn(async () => {
            mockCapabilityLookups += 1;
            return { DASHBOARD: false, CALL_DASHBOARD: false, REVIEW: false, ADMIN: false };
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
    '/api/generate-ppt-godamwale',
    '/api/generate-ppt-tci',
    '/api/generate-detailed-ppt',
];

beforeEach(() => { mockCapabilityLookups = 0; mockGenerate.mockClear(); });

describe('PPT route access control', () => {
    const token = () => new JWTService().generateToken(NON_ADMIN);

    it.each(ROUTES)('%s lets a signed-in user with no capabilities through', async (route) => {
        const res = await request(makeApp())
            .post(route)
            .set('Authorization', `Bearer ${token()}`)
            .send({ ids: '1877' });

        expect(res.status).toBe(200);
        expect(mockGenerate).toHaveBeenCalled();
    });

    it('does not consult the capability system at all', async () => {
        await request(makeApp())
            .post('/api/generate-ppt-v2')
            .set('Authorization', `Bearer ${token()}`)
            .send({ ids: '1877' });

        expect(mockCapabilityLookups).toBe(0);
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

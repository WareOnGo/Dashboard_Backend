const request = require('supertest');
const { app, prisma, reset } = require('../helpers/app');

beforeEach(reset);

test.each(['/api/enrichment/sweep', '/api/image-labels/sweep'])(
    'retired worker endpoint %s cannot execute even with the old cron credential', async route => {
        process.env.CRON_SECRET = 'retired-cron-test-only';
        try {
            await request(app).post(route).set('x-webhook-secret', process.env.CRON_SECRET).send({}).expect(404);
            expect(prisma.cronRunLog.create).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
        } finally { delete process.env.CRON_SECRET; }
    },
);

test.each(['/api/image-labels/warehouse/1', '/api/image-labels/stats'])(
    'retained metadata reader %s still requires dashboard authentication', async route => {
        await request(app).get(route).expect(401);
    },
);

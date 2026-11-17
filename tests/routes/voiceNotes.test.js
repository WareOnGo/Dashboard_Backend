jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn(async () => 'https://private.invalid/temporary-playback'),
}));
const request = require('supertest');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { app, prisma, reset, tokenFor, active } = require('../helpers/app');
const NOTE = '6e5f8cef-838a-4fda-a51c-85a2bd566f2b';
const STAGED = 'f847da36-999e-45ef-ae86-9a9c5f92b19c';
beforeEach(() => {
    reset();
    getSignedUrl.mockClear();
    process.env.R2_BUCKET_NAME = 'qa-warehouse-media';
    process.env.SCOUT_VOICE_NOTES_ENABLED = 'true';
    prisma.verifiedNumber.findFirst.mockResolvedValue(active());
});
afterAll(() => { delete process.env.R2_BUCKET_NAME; delete process.env.SCOUT_VOICE_NOTES_ENABLED; });
const authorized = path => request(app).get(path).set('Authorization', 'Bearer ' + tokenFor());

test('public configuration exposes availability and limits without storage credentials', async () => {
    const { body } = await request(app).get('/api/warehouses/scout/voice-notes/configuration').expect(200);
    expect(body).toEqual({ enabled: true, maxRecordings: 1, maxDurationMs: 300000, maxSizeBytes: 10485760 });
});
test('playback and uploads reject unauthenticated requests', async () => {
    await request(app).get('/api/warehouses/123/voice-notes/' + NOTE + '/playback').expect(401);
    await request(app).get('/api/staging/' + STAGED + '/voice-notes/' + NOTE + '/playback').expect(401);
    await request(app).post('/api/warehouses/scout/voice-notes/uploads').send({}).expect(401);
    expect(getSignedUrl).not.toHaveBeenCalled();
});
test('warehouse playback checks its association and returns a non-cacheable signed link', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ scoutVoiceNotes: [{ id: NOTE, storageKey: 'owned/audio.m4a' }] });
    const result = await authorized('/api/warehouses/123/voice-notes/' + NOTE + '/playback').expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.url).toBe('https://private.invalid/temporary-playback');
    expect(getSignedUrl.mock.calls[0][1].input).toMatchObject({ Bucket: 'qa-warehouse-media', Key: 'owned/audio.m4a' });
});
test('a dashboard-only user cannot play staged review audio', async () => {
    await authorized('/api/staging/' + STAGED + '/voice-notes/' + NOTE + '/playback').expect(403);
    expect(getSignedUrl).not.toHaveBeenCalled();
});
test('a reviewer can play staged audio without dashboard access', async () => {
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ dashboardAccess: false, reviewerAccess: true }));
    prisma.stagedWarehouse.findUnique.mockResolvedValue({ scoutVoiceNotes: [{ id: NOTE, storageKey: 'staged/audio.m4a' }] });
    await authorized('/api/staging/' + STAGED + '/voice-notes/' + NOTE + '/playback').expect(200);
    expect(prisma.stagedWarehouse.findUnique).toHaveBeenCalledWith({ where: { id: STAGED }, select: { scoutVoiceNotes: true } });
});
test('record/note mismatch cannot obtain a playback URL', async () => {
    prisma.warehouse.findUnique.mockResolvedValue({ scoutVoiceNotes: [] });
    await authorized('/api/warehouses/123/voice-notes/' + NOTE + '/playback').expect(404);
    expect(getSignedUrl).not.toHaveBeenCalled();
});
test('a scout cannot finalize another scout’s upload', async () => {
    prisma.verifiedNumber.findUnique.mockResolvedValue(active());
    prisma.scoutVoiceNoteAsset.findUnique.mockResolvedValue({ id: NOTE, scoutId: 999 });
    await request(app).post('/api/warehouses/scout/voice-notes/uploads/' + NOTE + '/complete')
        .send({ uploadedBy: 'QA1234' }).expect(404);
    expect(getSignedUrl).not.toHaveBeenCalled();
});

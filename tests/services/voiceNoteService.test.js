const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const VoiceNoteService = require('../../src/services/voiceNoteService');
const { LIMITS, retainVoiceNotes, referencesSchema } = require('../../src/utils/voiceNotes');
const { S3Client } = require('@aws-sdk/client-s3');

const originalEnabled = process.env.SCOUT_VOICE_NOTES_ENABLED;
beforeEach(() => { process.env.SCOUT_VOICE_NOTES_ENABLED = 'true'; });
afterAll(() => {
    if (originalEnabled === undefined) delete process.env.SCOUT_VOICE_NOTES_ENABLED;
    else process.env.SCOUT_VOICE_NOTES_ENABLED = originalEnabled;
});

function matches(row, where) {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') return value.some(part => matches(row, part));
        if (key === 'scoutId_clientRecordingId') return matches(row, value);
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return value.in.includes(row[key]);
            if ('not' in value) return row[key] !== value.not;
            if ('gt' in value) return row[key] > value.gt;
            if ('lt' in value) return row[key] < value.lt;
        }
        return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
    });
}
function fixture(overrides = {}) {
    const id = crypto.randomUUID();
    const asset = {
        id, scoutId: 7, clientRecordingId: crypto.randomUUID(), draftId: crypto.randomUUID(),
        uploadKey: 'scout-voice-note-uploads/' + id + '/original', contentType: 'audio/webm;codecs=opus', expectedSize: 4,
        state: 'UPLOADING', storageKey: null, operationToken: null, leaseUntil: null,
        createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 86400000),
        ...overrides,
    };
    const rows = [asset];
    const assets = {
        findUnique: jest.fn(async ({ where }) => rows.find(row => matches(row, where)) || null),
        count: jest.fn(async ({ where }) => rows.filter(row => matches(row, where)).length),
        findMany: jest.fn(async ({ where }) => rows.filter(row => matches(row, where)).map(row => ({ ...row }))),
        create: jest.fn(async ({ data }) => {
            const row = { state: 'UPLOADING', createdAt: new Date(), updatedAt: new Date(), ...data };
            rows.push(row); return row;
        }),
        updateMany: jest.fn(async ({ where, data }) => {
            const found = rows.filter(row => matches(row, where));
            found.forEach(row => Object.assign(row, data, { updatedAt: new Date() }));
            return { count: found.length };
        }),
    };
    const prisma = {
        scoutVoiceNoteAsset: assets,
        stagedWarehouse: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
        warehouse: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    };
    const storage = { send: jest.fn(async command => {
        if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 4, ContentType: 'audio/webm' };
        if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('test')]) };
        return {};
    }) };
    const normalize = jest.fn(async () => ({ bytes: Buffer.from('normalized'), durationMs: 43000 }));
    const sign = jest.fn(async (_storage, command) => 'https://private.invalid/' + command.input.Key);
    const service = new VoiceNoteService(prisma, { bucket: 'warehouse-media', storage, normalize, sign });
    return { asset, rows, prisma, storage, normalize, sign, service, scout: { id: 7 } };
}

test('voice attachments reject duplicate IDs and excess notes', () => {
    const id = crypto.randomUUID();
    expect(referencesSchema.safeParse([]).success).toBe(true);
    expect(referencesSchema.safeParse([{ id }]).success).toBe(true);
    expect(referencesSchema.safeParse([{ id }, { id }]).success).toBe(false);
    expect(referencesSchema.safeParse([{ id }, { id: crypto.randomUUID() }]).success).toBe(false);
});
test('submission rejects a second recording before claiming any asset or saving the warehouse', async () => {
    const { service, asset, scout, prisma } = fixture({ state: 'READY', storageKey: 'final' });
    const save = jest.fn();
    await expect(service.withAttachments([{ id: asset.id }, { id: crypto.randomUUID() }], scout, save))
        .rejects.toThrow('Only one voice recording');
    expect(prisma.scoutVoiceNoteAsset.updateMany).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
});
test('editing preserves omitted notes, canonicalizes retained notes, and permits explicit removal', () => {
    const note = { id: crypto.randomUUID(), storageKey: 'owned', durationMs: 4000 };
    expect(retainVoiceNotes({ scoutNotes: 'Updated text' }, { scoutVoiceNotes: [note] })).not.toHaveProperty('scoutVoiceNotes');
    expect(retainVoiceNotes({ scoutVoiceNotes: [{ id: note.id, storageKey: 'forged' }] }, { scoutVoiceNotes: [note] }).scoutVoiceNotes).toEqual([note]);
    expect(retainVoiceNotes({ scoutVoiceNotes: [] }, { scoutVoiceNotes: [note] }).scoutVoiceNotes).toEqual([]);
    expect(() => retainVoiceNotes({ scoutVoiceNotes: [{ id: crypto.randomUUID() }] }, { scoutVoiceNotes: [note] })).toThrow('not attached');
});
test.each([{ contentType: 'video/mp4', sizeBytes: 4 }, { contentType: 'audio/mp4', sizeBytes: LIMITS.maxSizeBytes + 1 }])(
    'upload allocation rejects invalid format/size: %j', async invalid => {
        const { service, asset, scout, sign } = fixture();
        await expect(service.begin({ ...asset, ...invalid }, scout)).rejects.toThrow();
        expect(sign).not.toHaveBeenCalled();
    },
);
test('completion rejects another scout before reading storage', async () => {
    const { service, asset, storage } = fixture();
    await expect(service.complete(asset.id, { id: 8 })).rejects.toMatchObject({ statusCode: 404 });
    expect(storage.send).not.toHaveBeenCalled();
});
test('completion validates actual bytes and stores a normalized canonical recording in the media bucket', async () => {
    const { service, asset, scout, storage, normalize } = fixture();
    const result = await service.complete(asset.id, scout);
    expect(normalize).toHaveBeenCalledWith(Buffer.from('test'));
    expect(result).toMatchObject({ id: asset.id, contentType: 'audio/mp4', durationMs: 43000, sizeBytes: 10 });
    expect(result).not.toHaveProperty('url');
    const put = storage.send.mock.calls.map(([command]) => command).find(command => command.constructor.name === 'PutObjectCommand');
    expect(put.input).toMatchObject({ Bucket: 'warehouse-media', Body: Buffer.from('normalized'), ContentType: 'audio/mp4' });
    expect(put.input.Key).not.toBe(asset.uploadKey);
    await expect(service.complete(asset.id, scout)).resolves.toEqual(result);
    expect(normalize).toHaveBeenCalledTimes(1);
});
test('incomplete upload is rejected without processing and is retryable', async () => {
    const { service, asset, scout, storage, normalize } = fixture();
    storage.send.mockResolvedValueOnce({ ContentLength: 1, ContentType: 'audio/webm' });
    await expect(service.complete(asset.id, scout)).rejects.toThrow('incomplete');
    expect(normalize).not.toHaveBeenCalled();
    expect(asset.state).toBe('UPLOADING');
});
test('submission resolves IDs from owned verified assets and releases its claim after failure', async () => {
    const { service, asset, scout } = fixture({ state: 'READY', storageKey: 'private-final', durationMs: 5000, sizeBytes: 10 });
    const save = jest.fn(async notes => {
        expect(notes).toEqual([expect.objectContaining({ id: asset.id, storageKey: 'private-final' })]);
        expect(asset.state).toBe('CLAIMED');
        throw new Error('Save failed');
    });
    await expect(service.withAttachments([{ id: asset.id, storageKey: 'spoof' }], scout, save)).rejects.toThrow('Save failed');
    expect(asset.state).toBe('READY');
});
test('unverified audio cannot be attached to a warehouse', async () => {
    const { service, asset, scout } = fixture();
    const save = jest.fn();
    await expect(service.withAttachments([{ id: asset.id }], scout, save)).rejects.toThrow('not ready');
    expect(save).not.toHaveBeenCalled();
});
test('retrying a lost submission response returns the existing staged row', async () => {
    const { service, asset, scout, prisma } = fixture({ state: 'READY', storageKey: 'final' });
    const row = { id: crypto.randomUUID(), scoutVoiceNotes: [{ id: asset.id }] };
    prisma.stagedWarehouse.findFirst.mockResolvedValue(row);
    const save = jest.fn();
    await expect(service.withAttachments([{ id: asset.id }], scout, save)).resolves.toEqual(row);
    expect(save).not.toHaveBeenCalled();
});
test('playback requires the note to belong to the requested record', async () => {
    const { service, prisma, sign } = fixture();
    prisma.stagedWarehouse.findUnique.mockResolvedValue({ scoutVoiceNotes: [{ id: 'owned', storageKey: 'private' }] });
    await expect(service.playback('staged-id', 'someone-else', true)).rejects.toMatchObject({ statusCode: 404 });
    expect(sign).not.toHaveBeenCalled();
    await expect(service.playback('staged-id', 'owned', true)).resolves.toMatchObject({ url: 'https://private.invalid/private' });
});
test('a repeated audio submission with changed form fields cannot silently return the old record', async () => {
    const { service, asset, scout, prisma } = fixture({ state: 'READY', storageKey: 'final' });
    prisma.stagedWarehouse.findFirst.mockResolvedValue({
        id: 'old-submission', scoutVoiceNotes: [{ id: asset.id }],
        rawPayload: { scoutNotes: 'Original text', scoutVoiceNotes: [{ id: asset.id }] },
    });
    const save = jest.fn();
    await expect(service.withAttachments([{ id: asset.id }], scout, save, {
        scoutNotes: 'Changed text', scoutVoiceNotes: [{ id: asset.id }],
    })).rejects.toThrow('already been submitted');
    expect(save).not.toHaveBeenCalled();
});
test('an interrupted attachment claim can be retried once its lease expires', async () => {
    const { service, asset, scout } = fixture({
        state: 'CLAIMED', storageKey: 'final', leaseUntil: new Date(0), operationToken: 'stale',
        sizeBytes: 10, durationMs: 1000,
    });
    const save = jest.fn(async notes => notes);
    await expect(service.withAttachments([{ id: asset.id }], scout, save)).resolves.toHaveLength(1);
    expect(asset.state).toBe('READY');
});
test.each(['stagedWarehouse', 'warehouse'])('cleanup retains audio referenced by %s', async table => {
    const { service, asset, prisma, storage } = fixture({ state: 'READY', storageKey: 'saved', expiresAt: new Date(0) });
    prisma[table].findFirst.mockResolvedValue({ id: 1 });
    await expect(service.cleanup()).resolves.toMatchObject({ deleted: 0 });
    expect(asset.state).toBe('READY');
    expect(storage.send.mock.calls.map(([command]) => command.input.Key)).not.toContain('saved');
});
test('cleanup deletes expired unreferenced audio and never deletes an active attachment claim', async () => {
    const { service, asset, rows, storage } = fixture({ state: 'READY', storageKey: 'orphan', expiresAt: new Date(0) });
    rows.push({ ...asset, id: crypto.randomUUID(), state: 'CLAIMED', leaseUntil: new Date(Date.now() + 60000), storageKey: 'in-use' });
    await expect(service.cleanup()).resolves.toEqual({ checked: 1, deleted: 1, failed: 0 });
    expect(asset.state).toBe('DELETED');
    expect(storage.send.mock.calls.filter(([command]) => command.constructor.name === 'DeleteObjectCommand').map(([command]) => command.input.Key)).toEqual([asset.uploadKey, 'orphan']);
});

test('capture fails closed unless deliberately enabled', async () => {
    delete process.env.SCOUT_VOICE_NOTES_ENABLED;
    const { service, asset, scout, sign } = fixture();
    expect(service.configuration.enabled).toBe(false);
    await expect(service.begin({ ...asset, sizeBytes: 4 }, scout)).rejects.toMatchObject({ statusCode: 503 });
    expect(sign).not.toHaveBeenCalled();
});

test('the real SDK signs exact upload size and MIME type with offline fixture credentials', async () => {
    const { service, asset, scout } = fixture();
    const storage = new S3Client({
        region: 'auto', endpoint: 'https://r2.example.invalid',
        credentials: { accessKeyId: 'TEST', secretAccessKey: 'TEST' },
        requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    service.options.sign = undefined;
    service.options.storage = storage;
    try {
        const result = await service.begin({ ...asset, sizeBytes: 4 }, scout);
        const query = new URL(result.uploadUrl).searchParams;
        expect(query.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
        expect(query.get('X-Amz-Expires')).toBe('360');
    } finally { storage.destroy(); }
});

test('renewing an expiring upload prevents a cleanup snapshot from deleting it', async () => {
    const { service, asset, scout, prisma, storage } = fixture({ expiresAt: new Date(0) });
    prisma.scoutVoiceNoteAsset.findMany.mockImplementationOnce(async () => {
        const snapshot = { ...asset };
        await service.begin({ ...asset, sizeBytes: 4 }, scout);
        return [snapshot];
    });
    await expect(service.cleanup()).resolves.toEqual({ checked: 1, deleted: 0, failed: 0 });
    expect(asset.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    expect(asset.state).toBe('UPLOADING');
    expect(storage.send).not.toHaveBeenCalled();
});

test('a draft can re-upload a recording after server cleanup, retaining its stable ID', async () => {
    const { service, asset, scout } = fixture({ state: 'DELETED', storageKey: 'removed', expiresAt: new Date(0) });
    const previousKey = asset.uploadKey;
    const result = await service.begin({ ...asset, sizeBytes: 4 }, scout);
    expect(result.id).toBe(asset.id);
    expect(asset.uploadKey).not.toBe(previousKey);
    expect(asset.storageKey).toBeNull();
    expect(asset.state).toBe('UPLOADING');
});

test('processing capacity is bounded across service instances and released after failure', async () => {
    const fixtures = [fixture(), fixture(), fixture()];
    const releases = [];
    const starts = fixtures.slice(0, 2).map(({ normalize }) => new Promise(resolve => {
        normalize.mockImplementationOnce(() => new Promise((_done, reject) => {
            releases.push(() => reject(new Error('Interrupted decoder')));
            resolve();
        }));
    }));
    const pending = fixtures.slice(0, 2).map(({ service, asset, scout }) => service.complete(asset.id, scout).catch(error => error));
    await Promise.all(starts);
    const third = fixtures[2];
    try {
        await expect(third.service.complete(third.asset.id, third.scout)).rejects.toMatchObject({ statusCode: 503 });
        expect(third.storage.send).not.toHaveBeenCalled();
    } finally {
        releases.forEach(release => release());
        await Promise.all(pending);
    }
    await expect(third.service.complete(third.asset.id, third.scout)).resolves.toHaveProperty('id', third.asset.id);
});

test.each(['stagedWarehouse', 'warehouse'])('draft playback cannot bypass %s reviewer permissions after submission', async table => {
    const { service, asset, scout, prisma, sign } = fixture({ state: 'READY', storageKey: 'submitted' });
    prisma[table].findFirst.mockResolvedValue({ id: 123 });
    await expect(service.ownPlayback(asset.id, scout)).rejects.toMatchObject({ statusCode: 404 });
    expect(sign).not.toHaveBeenCalled();
});

test('uploads, playback and cleanup use the existing warehouse-media bucket and audio-specific prefixes', async () => {
    const { service, asset, scout, sign, storage } = fixture();
    const oldBucket = process.env.R2_BUCKET_NAME;
    process.env.R2_BUCKET_NAME = 'existing-warehouse-media';
    delete service.options.bucket;
    try {
        expect(service.configuration.enabled).toBe(true);
        await service.begin({ ...asset, sizeBytes: asset.expectedSize }, scout);
        expect(sign.mock.calls[0][1].input).toMatchObject({
            Bucket: 'existing-warehouse-media', Key: 'scout-voice-note-uploads/' + asset.id + '/original',
        });
        await service.complete(asset.id, scout);
        await expect(service.ownPlayback(asset.id, scout)).resolves.toHaveProperty('url');
        asset.expiresAt = new Date(0);
        await expect(service.cleanup()).resolves.toEqual({ checked: 1, deleted: 1, failed: 0 });
        expect(storage.send.mock.calls.every(([command]) => command.input.Bucket === 'existing-warehouse-media')).toBe(true);
        expect(storage.send.mock.calls.filter(([command]) => command.constructor.name === 'ListObjectsV2Command')
            .map(([command]) => command.input.Prefix)).toEqual([
            'scout-voice-note-uploads/' + asset.id + '/', 'scout-voice-notes/' + asset.id + '/',
        ]);
    } finally {
        if (oldBucket === undefined) delete process.env.R2_BUCKET_NAME;
        else process.env.R2_BUCKET_NAME = oldBucket;
    }
});

test('playback and cleanup fail safely when the warehouse bucket is missing', async () => {
    const { service, asset, scout, sign, prisma } = fixture({ state: 'READY', storageKey: 'recording' });
    const oldBucket = process.env.R2_BUCKET_NAME;
    delete process.env.R2_BUCKET_NAME;
    delete service.options.bucket;
    try {
        await expect(service.ownPlayback(asset.id, scout)).rejects.toMatchObject({ statusCode: 503 });
        await expect(service.cleanup()).rejects.toMatchObject({ statusCode: 503 });
        expect(sign).not.toHaveBeenCalled();
        expect(prisma.scoutVoiceNoteAsset.findMany).not.toHaveBeenCalled();
    } finally {
        if (oldBucket === undefined) delete process.env.R2_BUCKET_NAME;
        else process.env.R2_BUCKET_NAME = oldBucket;
    }
});

test('cleanup reports individual storage failures and keeps the deletion claim retryable', async () => {
    const { service, asset, storage } = fixture({ expiresAt: new Date(0) });
    storage.send.mockRejectedValueOnce(new Error('Storage offline'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await expect(service.cleanup()).resolves.toEqual({ checked: 1, deleted: 0, failed: 1 });
        expect(asset.state).toBe('DELETING');
        expect(asset.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    } finally { log.mockRestore(); }
});

test('a stale cleanup worker stops deleting after another worker takes its lease', async () => {
    const { service, asset, storage } = fixture({ expiresAt: new Date(0) });
    storage.send.mockImplementationOnce(async () => {
        asset.operationToken = 'another-worker';
        return { Contents: [{ Key: asset.uploadKey }] };
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await expect(service.cleanup()).resolves.toEqual({ checked: 1, deleted: 0, failed: 1 });
        expect(storage.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(['ListObjectsV2Command']);
        expect(asset.operationToken).toBe('another-worker');
    } finally { log.mockRestore(); }
});

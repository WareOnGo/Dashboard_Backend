const { warehouseImageUrls, sourceTarget, buildPlan, readInventory } = require('../../scripts/lib/imageCompressionBackfill');
const { parseArgs, writeBatch } = require('../../scripts/backfillImageCompression');

const config = { publicBase: 'https://fixture.invalid', bucket: 'fixture' };
const row = (id, name) => ({ id, imageUrl: `${config.publicBase}/${name}`, classification: 'INDOOR', description: 'Existing caption' });
const object = { bytes: 12345, lastModified: new Date('2026-09-01T00:00:00Z') };

test('inventories both media images and legacy photo-only entries without treating videos as images', () => {
    const urls = warehouseImageUrls([
        { media: { images: ['https://fixture.invalid/a.jpg'] }, photos: 'https://fixture.invalid/a.jpg, https://fixture.invalid/b.png, https://fixture.invalid/video.mp4' },
        { media: JSON.stringify({ images: ['https://fixture.invalid/c.jpg'] }), photos: JSON.stringify(['https://fixture.invalid/d.webp', null]) },
    ], config.publicBase);
    expect([...urls]).toEqual(['https://fixture.invalid/a.jpg', 'https://fixture.invalid/b.png', 'https://fixture.invalid/c.jpg', 'https://fixture.invalid/d.webp']);
});

test('matches by decoded original path even with query strings and reordered rows', () => {
    const inventory = new Map([['webp/folder/a b.webp', object], ['webp/c.webp', object]]);
    const plan = buildPlan([row(2, 'c.jpg'), row(1, 'folder/a%20b.png?version=2')], inventory, config);
    expect(plan.summary).toMatchObject({ ready: 2, pending: 0, wouldUpdate: 2 });
    expect(plan.changes[1].after).toMatchObject({ originalObjectKey: 'folder/a b.png', compressedImageUrl: 'https://fixture.invalid/webp/folder/a%20b.webp' });
    expect(plan.changes[0].after.compressedImageUrl).toBe('https://fixture.invalid/webp/c.webp');
    expect(plan.changes[0].after).not.toHaveProperty('classification');
    expect(plan.changes[0].after).not.toHaveProperty('description');
});

test('missing and empty objects stay pending with original URLs preserved', () => {
    const source = row(1, 'a.jpg');
    const plan = buildPlan([source], new Map([['webp/a.webp', { bytes: 0 }]]), config);
    expect(plan.summary.pending).toBe(1);
    expect(plan.changes[0]).toMatchObject({ imageUrl: source.imageUrl, after: { compressionStatus: 'PENDING', compressedImageUrl: null } });
    expect(source.description).toBe('Existing caption');
});

test('a second run is a no-op after a verified import', () => {
    const inventory = new Map([['webp/a.webp', object]]);
    const source = row(1, 'a.jpg');
    const first = buildPlan([source], inventory, config);
    const imported = { ...source, ...first.changes[0].after, compressionCheckedAt: '2026-09-21T00:00:00Z' };
    expect(buildPlan([imported], inventory, config).summary).toMatchObject({ ready: 1, unchanged: 1, wouldUpdate: 0 });
});

test('existing compressed bytes and dates normalize across database JSON formats', () => {
    const imported = { ...row(1, 'a.jpg'), storageBucket: 'fixture', originalObjectKey: 'a.jpg',
        compressedImageUrl: 'https://fixture.invalid/webp/a.webp', compressedObjectKey: 'webp/a.webp',
        compressedBytes: 12345, compressedAt: '2026-09-01T00:00:00+00:00', compressionStatus: 'READY',
        compressionCheckedAt: '2026-09-21T00:00:00Z' };
    expect(buildPlan([imported], new Map([['webp/a.webp', object]]), config).changes).toHaveLength(0);
});

test('refuses ambiguous legacy keys shared by different original extensions', () => {
    const plan = buildPlan([row(1, 'a.jpg'), row(2, 'a.png')], new Map([['webp/a.webp', object]]), config);
    expect(plan.summary).toMatchObject({ ambiguous: 2, ready: 0 });
    expect(plan.changes.every(change => change.after.compressionStatus === 'FAILED' && !change.after.compressedImageUrl)).toBe(true);
});

test('detects a key collision with an original that has no label row yet', () => {
    const plan = buildPlan([row(1, 'a.jpg')], new Map([['webp/a.webp', object]]),
        { ...config, additionalOriginalUrls: ['https://fixture.invalid/a.png'] });
    expect(plan.summary).toMatchObject({ ambiguous: 1, ready: 0 });
});

test('multiple URLs for the same source object are not a filename collision', () => {
    const plan = buildPlan([row(1, 'a.jpg?v=1'), row(2, 'a.jpg?v=2')], new Map([['webp/a.webp', object]]), config);
    expect(plan.summary).toMatchObject({ ready: 2, ambiguous: 0 });
});

test('rejects foreign hosts, unsupported documents, and malformed URLs', () => {
    for (const url of ['https://foreign.invalid/a.jpg', 'https://fixture.invalid.evil/a.jpg', 'https://fixture.invalid/a.pdf', 'https://user@fixture.invalid/a.jpg', 'https://fixture.invalid/a%ZZ.jpg']) {
        expect(sourceTarget(url, config.publicBase)).toBeNull();
    }
    expect(buildPlan([{ ...row(1, 'a.jpg'), imageUrl: 'https://foreign.invalid/a.jpg' }], new Map(), config).summary.unsupported).toBe(1);
});

test('does not touch rows currently owned by a compression worker', () => {
    const plan = buildPlan([{ ...row(1, 'a.jpg'), compressionStatus: 'RUNNING' }], new Map(), config);
    expect(plan.summary.runningSkipped).toBe(1);
    expect(plan.changes).toEqual([]);
});

test('does not replace a newer versioned variant with the legacy file layout', () => {
    const source = { ...row(1, 'a.jpg'), compressionStatus: 'READY', compressionVersion: 'webp-v2', compressedObjectKey: 'images/uuid/v2.webp' };
    const plan = buildPlan([source], new Map([['webp/a.webp', object]]), config);
    expect(plan.summary.managedSkipped).toBe(1);
    expect(plan.changes).toEqual([]);
});

test('reads every inventory page, ignores zero-byte objects, and aborts malformed pagination', async () => {
    class Command { constructor(input) { this.input = input; } }
    const client = { send: jest.fn()
        .mockResolvedValueOnce({ Contents: [{ Key: 'webp/a.webp', Size: 12 }], IsTruncated: true, NextContinuationToken: 'next' })
        .mockResolvedValueOnce({ Contents: [{ Key: 'webp/b.webp', Size: 0 }, { Key: 'webp/c.webp', Size: 9 }] }) };
    const inventory = await readInventory(client, Command, 'fixture');
    expect([...inventory.keys()]).toEqual(['webp/a.webp', 'webp/c.webp']);
    expect(client.send.mock.calls[1][0].input.ContinuationToken).toBe('next');
    await expect(readInventory({ send: jest.fn().mockResolvedValue({ IsTruncated: true }) }, Command, 'fixture')).rejects.toThrow('pagination');
    await expect(readInventory({ send: jest.fn().mockRejectedValue(new Error('storage unavailable')) }, Command, 'fixture')).rejects.toThrow('storage unavailable');
});

test('the CLI is read-only by default and caps transaction batch sizes', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, batchSize: 200 });
    expect(parseArgs(['--apply', '--batch-size=50'])).toMatchObject({ apply: true, batchSize: 50 });
    expect(() => parseArgs(['--batch-size=501'])).toThrow();
    expect(() => parseArgs(['--force'])).toThrow();
});

test('updates only compression columns and compares prior values to protect concurrent changes', async () => {
    const tx = { $executeRawUnsafe: jest.fn(), $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const prisma = { $transaction: jest.fn(fn => fn(tx)) };
    await writeBatch(prisma, [{ id: 1, imageUrl: 'fixture', before: {}, after: {} }], '2026-09-21T00:00:00Z');
    const [sql] = tx.$queryRawUnsafe.mock.calls[0];
    const assigned = sql.split('UPDATE public.labeled_warehouse_images AS l SET')[1].split('FROM incoming AS r')[0];
    for (const field of ['classification', 'description', 'imageUrl', 'model', 'confidence', 'warehouseId']) expect(assigned).not.toContain(`"${field}"`);
    expect(sql).toContain('IS NOT DISTINCT FROM');
    expect(sql).toContain('l."imageUrl" = r."imageUrl"');
    expect(sql).not.toMatch(/INSERT|DELETE/);
});

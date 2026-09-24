const axios = require('axios');
const sharp = require('sharp');
const JSZip = require('jszip');
const PptGenerationService = require('../../src/services/pptGenerationService');
const { createPptImageLoader } = require('../../src/services/pptImageService');
const { normalizeImageBuffer, readImageDimensions } = require('../../src/ppt/utils/image');

// Stub only storage/network boundaries. All deck builders and ZIP packaging run.
const original = 'https://images.test/one/photo.jpg';
const other = 'https://images.test/two/photo.jpg'; // Same filename, different image.
const variant = 'https://images.test/hashed/published.jpg'; // Bytes, not extension, are WebP.
const warehouse = {
    id: 1, city: 'Bengaluru', state: 'Karnataka', address: 'Fixture warehouse',
    warehouseType: 'PEB', totalSpaceSqft: [50000], ratePerSqft: 20,
    photos: `${original},${other}`, googleLocation: '', WarehouseData: {},
};
let jpeg, png, webp, rotated;
let get, findMany, service, stats;
const details = { clientName: 'Fixture', mapsLocation: false, pocSlide: false };
const selection = { 1: [original, other] };
const bodies = new Map();

beforeAll(async () => {
    const pixels = { create: { width: 120, height: 80, channels: 3, background: '#0066cc' } };
    jpeg = await sharp(pixels).jpeg().toBuffer();
    png = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#ee8822' } }).png().toBuffer();
    webp = await sharp(pixels).webp().toBuffer();
    rotated = await sharp(pixels).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    bodies.set(original, jpeg); bodies.set(other, png); bodies.set(variant, webp);
});

beforeEach(() => {
    stats = {};
    get = jest.spyOn(axios, 'get').mockImplementation(async url => {
        if (!bodies.has(url)) throw new Error(`Unexpected URL: ${url}`);
        return { data: bodies.get(url) };
    });
    findMany = jest.fn(async () => [{ imageUrl: original, webpUrl: variant }]);
    service = new PptGenerationService({ prisma: { labeledWarehouseImage: { findMany } } });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

const loader = (urls = [original, other]) => createPptImageLoader(
    { labeledWarehouseImage: { findMany } }, urls, stats,
);
const unzipImages = async buffer => {
    const zip = await JSZip.loadAsync(buffer);
    const media = await Promise.all(zip.file(/^ppt\/media\/[^/]+$/).map(async file => ({
        name: file.name, body: await file.async('nodebuffer'),
    })));
    return { zip, media };
};
const contains = (media, body) => media.some(image => image.body.equals(body));

it.each(['standard', 'v2', 'v3', 'godamwale', 'tci', 'detailed'])(
    '%s embeds native WebP, falls back by original identity, and caches repeats', async type => {
        const buffer = await service.createBuffer(type, [warehouse], selection, details, false,
            { compressedPpt: true, imageStats: stats });
        const { zip, media } = await unzipImages(buffer);
        expect(media.filter(image => image.name.endsWith('.webp')).some(image => image.body.equals(webp))).toBe(true);
        expect(await zip.file('[Content_Types].xml').async('string')).toContain('ContentType="image/webp"');
        expect(contains(media, jpeg)).toBe(false);
        expect(contains(media, png)).toBe(true);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0][0].where.imageUrl.in).toEqual([original, other]);
        expect(get.mock.calls.map(call => call[0]).sort()).toEqual([variant, other].sort());
        expect(stats).toEqual({ webpImages: 1, originalFallbacks: 1, failedImages: 0, registryLookupFailed: false });
    },
);

it.each(['standard', 'v2', 'v3', 'godamwale', 'tci', 'detailed'])(
    '%s keeps originals and never looks up variants when the option is omitted', async type => {
        const { media } = await unzipImages(await service.createBuffer(type, [warehouse], selection, details));
        expect(contains(media, jpeg)).toBe(true);
        expect(contains(media, png)).toBe(true);
        expect(media.some(image => image.name.endsWith('.webp'))).toBe(false);
        expect(findMany).not.toHaveBeenCalled();
    },
);

it('keeps simultaneous compressed and normal requests isolated', async () => {
    const [compressed, normal] = await Promise.all([
        service.createBuffer('v3', [warehouse], selection, details, false, { compressedPpt: true }),
        service.createBuffer('v3', [warehouse], selection, details, false, { compressedPpt: false }),
    ]);
    expect(contains((await unzipImages(compressed)).media, jpeg)).toBe(false);
    expect(contains((await unzipImages(normal)).media, jpeg)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
});

it('uses the same fallback for a V3 layout drawing while keeping it on a separate slide', async () => {
    findMany.mockResolvedValue([{ imageUrl: other, webpUrl: variant }]);
    get.mockImplementation(async url => {
        if (url === variant) throw new Error('404');
        return { data: bodies.get(url) };
    });
    const structured = { 1: { photos: [original], cad: [other] } };
    const { zip, media } = await unzipImages(await service.createBuffer('v3', [warehouse], structured, details,
        false, { compressedPpt: true, imageStats: stats }));
    expect(contains(media, jpeg)).toBe(true);
    expect(contains(media, png)).toBe(true);
    const slides = await Promise.all(zip.file(/^ppt\/slides\/slide\d+\.xml$/).map(file => file.async('string')));
    expect(slides.some(xml => xml.includes('Layout') && xml.includes('<p:pic>'))).toBe(true);
    expect(get.mock.calls.filter(([url]) => url === other)).toHaveLength(1);
    expect(stats.originalFallbacks).toBe(2);
});

it.each(['detailed', 'tci'])('%s resolves its implicit warehouse images too', async type => {
    const { media } = await unzipImages(await service.createBuffer(type, [warehouse], {}, details, false,
        { compressedPpt: true }));
    expect(contains(media, webp)).toBe(true);
    expect(contains(media, jpeg)).toBe(false);
});

it.each(['missing', 'null-url', 'invalid-url', 'database-error', '404', 'timeout', 'html', 'wrong-type', 'truncated', 'corrupt'])(
    'falls back for %s and retries neither variant nor original within the deck', async failure => {
        if (failure === 'missing') findMany.mockResolvedValue([]);
        if (failure === 'null-url') findMany.mockResolvedValue([{ imageUrl: original, webpUrl: null }]);
        if (failure === 'invalid-url') findMany.mockResolvedValue([{ imageUrl: original, webpUrl: 'file:///tmp/image.webp' }]);
        if (failure === 'database-error') findMany.mockRejectedValue(new Error('DB unavailable'));
        get.mockImplementation(async (url, options) => {
            if (url === original) return { data: jpeg };
            expect(options.timeout).toBeLessThanOrEqual(5000);
            if (failure === '404' || failure === 'timeout') throw new Error(failure);
            if (failure === 'html') return { data: Buffer.from('<html>storage error</html>') };
            if (failure === 'wrong-type') return { data: jpeg };
            if (failure === 'truncated') return { data: webp.subarray(0, 29) };
            const corrupt = Buffer.from(webp);
            corrupt.fill(0, 20, 30); // Invalid VP8 frame inside an intact RIFF container.
            return { data: corrupt };
        });
        const load = await loader([original, original]);
        const images = await Promise.all([load(original), load(original), load(original)]);
        expect(images[0].data).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
        expect(images.every(image => image === images[0])).toBe(true);
        expect(get.mock.calls.filter(([url]) => url === original)).toHaveLength(1);
        expect(get.mock.calls.filter(([url]) => url === variant).length).toBeLessThanOrEqual(1);
        expect(stats.originalFallbacks).toBe(1);
        expect(stats.registryLookupFailed).toBe(failure === 'database-error');
    },
);

it('falls back after a slow registry lookup without waiting on it indefinitely', async () => {
    jest.useFakeTimers();
    findMany.mockReturnValue(new Promise(() => {}));
    const pending = loader([original]);
    await jest.advanceTimersByTimeAsync(3001);
    const load = await pending;
    expect((await load(original)).data).toContain('data:image/jpeg;');
    expect(stats.registryLookupFailed).toBe(true);
});

it('preserves portrait orientation when the fallback is a phone JPEG', async () => {
    findMany.mockResolvedValue([]);
    get.mockResolvedValue({ data: rotated });
    const image = await (await loader())(original);
    expect(image.dims).toEqual({ w: 80, h: 120 });
    expect((await sharp(Buffer.from(image.data.split(',')[1], 'base64')).metadata()).orientation).toBeUndefined();
});

it('leaves an unavailable original to the existing slide fallback and caches the failure', async () => {
    get.mockRejectedValue(new Error('Both storage objects unavailable'));
    const load = await loader();
    const results = await Promise.allSettled([load(original), load(original)]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(stats.failedImages).toBe(1);
});

it.each(['lossy', 'lossless', 'extended'])('keeps %s WebP bytes and dimensions unchanged despite a .jpg URL', async kind => {
    let input = sharp({ create: { width: 73, height: 41, channels: 3, background: '#33aa66' } });
    if (kind === 'extended') input = input.withMetadata();
    const bytes = await input.webp({ lossless: kind === 'lossless' }).toBuffer();
    const image = await normalizeImageBuffer(bytes, 'https://images.test/image.jpg');
    expect(image.data).toBe(`data:image/webp;base64,${bytes.toString('base64')}`);
    expect(image.dims).toEqual({ w: 73, h: 41 });
    for (let length = 12; length < 30; length++) {
        expect(() => readImageDimensions(bytes.subarray(0, length))).not.toThrow();
    }
});

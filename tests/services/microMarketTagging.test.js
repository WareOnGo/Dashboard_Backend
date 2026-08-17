const MicroMarketService = require('../../src/services/microMarketService');
const WarehouseService = require('../../src/services/warehouseService');

const box = (minLon, minLat, size = 10) => ({
    type: 'Polygon',
    coordinates: [[
        [minLon, minLat],
        [minLon + size, minLat],
        [minLon + size, minLat + size],
        [minLon, minLat + size],
        [minLon, minLat],
    ]],
});

const POLYGONS = [
    { id: 'p1', name: 'Nelamangala', geometry: box(70, 10) },
    { id: 'p2', name: 'Dobbaspet', geometry: box(75, 15) }, // overlaps p1 at 75..80 / 15..20
];

/** Model double that records how often the polygon set was actually fetched. */
const makeModel = (polygons = POLYGONS) => ({
    calls: 0,
    listForTagging: jest.fn(function () {
        this.calls++;
        return Promise.resolve(polygons);
    }),
    createOne: jest.fn((data) => Promise.resolve({ id: 'new', ...data })),
    updateById: jest.fn((id, data) => Promise.resolve({ id, ...data })),
    deleteById: jest.fn(() => Promise.resolve()),
});

describe('MicroMarketService.tagsForPoint', () => {
    it('tags a point with every polygon containing it', async () => {
        const svc = new MicroMarketService(makeModel());
        // lon 77, lat 17 sits in both boxes
        await expect(svc.tagsForPoint(17, 77)).resolves.toEqual(['Dobbaspet', 'Nelamangala']);
    });

    it('returns an empty array for a point outside every polygon', async () => {
        const svc = new MicroMarketService(makeModel());
        await expect(svc.tagsForPoint(0, 0)).resolves.toEqual([]);
    });

    it('returns an empty array when coordinates are missing, without hitting the DB', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await expect(svc.tagsForPoint(null, 77)).resolves.toEqual([]);
        await expect(svc.tagsForPoint(17, null)).resolves.toEqual([]);
        expect(model.listForTagging).not.toHaveBeenCalled();
    });

    it('caches the polygon set across calls (the fetch is the expensive part)', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await svc.tagsForPoint(17, 77);
        await svc.tagsForPoint(11, 71);
        await svc.tagsForPoint(50, 50);
        expect(model.listForTagging).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after the cache is invalidated', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await svc.tagsForPoint(17, 77);
        svc.invalidatePolygonCache();
        await svc.tagsForPoint(17, 77);
        expect(model.listForTagging).toHaveBeenCalledTimes(2);
    });

    it('swallows a polygon-fetch failure so tagging never breaks the warehouse write', async () => {
        const model = makeModel();
        model.listForTagging = jest.fn(() => Promise.reject(new Error('pooler down')));
        const svc = new MicroMarketService(model);
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(svc.tagsForPoint(17, 77)).resolves.toEqual([]);
        spy.mockRestore();
    });
});

describe('MicroMarketService cache invalidation on writes', () => {
    const reviewer = { email: 'r@wareongo.com', name: 'R' };

    it('busts the cache when a polygon is created', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await svc.tagsForPoint(17, 77);
        await svc.create({ name: 'New', city: 'Bengaluru', geometry: box(0, 0), reviewer });
        await svc.tagsForPoint(17, 77);
        expect(model.listForTagging).toHaveBeenCalledTimes(2);
    });

    it('busts the cache when a polygon is updated (a rename changes the tag)', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await svc.tagsForPoint(17, 77);
        await svc.update('p1', { name: 'Renamed', reviewer });
        await svc.tagsForPoint(17, 77);
        expect(model.listForTagging).toHaveBeenCalledTimes(2);
    });

    it('busts the cache when a polygon is deleted', async () => {
        const model = makeModel();
        const svc = new MicroMarketService(model);
        await svc.tagsForPoint(17, 77);
        await svc.remove('p1');
        await svc.tagsForPoint(17, 77);
        expect(model.listForTagging).toHaveBeenCalledTimes(2);
    });
});

describe('WarehouseService.applyMicroMarketTags', () => {
    const svcWith = (polygons = POLYGONS) =>
        new WarehouseService({}, new MicroMarketService(makeModel(polygons)));

    it('stamps micromarket from the payload coordinates', async () => {
        const payload = { city: 'Bengaluru', warehouseData: { latitude: 17, longitude: 77 } };
        await svcWith().applyMicroMarketTags(payload);
        expect(payload.micromarket).toEqual(['Dobbaspet', 'Nelamangala']);
    });

    it('stamps an empty array for coordinates outside every polygon', async () => {
        const payload = { warehouseData: { latitude: 0, longitude: 0 } };
        await svcWith().applyMicroMarketTags(payload);
        expect(payload.micromarket).toEqual([]);
    });

    it('leaves the field absent when the payload carries no coordinates', async () => {
        // A partial edit that never touches location must not wipe an existing tag.
        const payload = { ratePerSqft: '30', warehouseData: {} };
        await svcWith().applyMicroMarketTags(payload);
        expect(payload).not.toHaveProperty('micromarket');
    });

    it('leaves the field absent when only one of the two coordinates is present', async () => {
        const payload = { warehouseData: { latitude: 17 } };
        await svcWith().applyMicroMarketTags(payload);
        expect(payload).not.toHaveProperty('micromarket');
    });

    it('leaves the field absent when there is no warehouseData at all', async () => {
        const payload = { ratePerSqft: '30' };
        await svcWith().applyMicroMarketTags(payload);
        expect(payload).not.toHaveProperty('micromarket');
    });

    it('is a no-op when no micro-market service is wired in', async () => {
        const payload = { warehouseData: { latitude: 17, longitude: 77 } };
        await new WarehouseService({}).applyMicroMarketTags(payload);
        expect(payload).not.toHaveProperty('micromarket');
    });

    it('returns the same payload object it was given', async () => {
        const payload = { warehouseData: { latitude: 17, longitude: 77 } };
        await expect(svcWith().applyMicroMarketTags(payload)).resolves.toBe(payload);
    });
});

const SEARCH_POLYGONS = [
    { id: 'p1', name: 'Bommasandra Industrial Area', geometry: box(70, 10) },
    { id: 'p2', name: 'Peenya Industrial Area', geometry: box(75, 15) },
    { id: 'p3', name: 'Whitefield', geometry: box(80, 20) },
    { id: 'p4', name: '', geometry: box(85, 25) }, // unnamed → tagged by id
];

describe('MicroMarketService.namesMatching', () => {
    const svc = () => new MicroMarketService(makeModel(SEARCH_POLYGONS));

    it('matches an exact name', async () => {
        await expect(svc().namesMatching('Whitefield')).resolves.toEqual(['Whitefield']);
    });

    it('matches a prefix of a longer name', async () => {
        await expect(svc().namesMatching('bommasandra'))
            .resolves.toEqual(['Bommasandra Industrial Area']);
    });

    it('matches through a spelling mistake', async () => {
        await expect(svc().namesMatching('bomasandra'))
            .resolves.toEqual(['Bommasandra Industrial Area']);
        await expect(svc().namesMatching('whitfield')).resolves.toEqual(['Whitefield']);
    });

    it('returns every name a shared term hits, sorted', async () => {
        await expect(svc().namesMatching('industrial area')).resolves.toEqual([
            'Bommasandra Industrial Area',
            'Peenya Industrial Area',
        ]);
    });

    it('falls back to the polygon id for an unnamed polygon', async () => {
        await expect(svc().namesMatching('p4')).resolves.toEqual(['p4']);
    });

    it('returns nothing for an unrelated term', async () => {
        await expect(svc().namesMatching('chakan')).resolves.toEqual([]);
    });

    it('returns nothing for an empty term, without hitting the DB', async () => {
        const model = makeModel(SEARCH_POLYGONS);
        const s = new MicroMarketService(model);
        await expect(s.namesMatching('   ')).resolves.toEqual([]);
        expect(model.listForTagging).not.toHaveBeenCalled();
    });

    it('reuses the tagging cache rather than re-fetching per search', async () => {
        const model = makeModel(SEARCH_POLYGONS);
        const s = new MicroMarketService(model);
        await s.namesMatching('whitefield');
        await s.namesMatching('peenya');
        expect(model.listForTagging).toHaveBeenCalledTimes(1);
    });

    it('honours an explicit threshold', async () => {
        // 'whitfield' vs 'Whitefield' scores 0.9 — in at 0.6, out at 0.95.
        await expect(svc().namesMatching('whitfield', 0.6)).resolves.toEqual(['Whitefield']);
        await expect(svc().namesMatching('whitfield', 0.95)).resolves.toEqual([]);
    });

    it('degrades to no hits when the polygon fetch fails', async () => {
        const model = makeModel(SEARCH_POLYGONS);
        model.listForTagging = jest.fn(() => Promise.reject(new Error('pooler down')));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(new MicroMarketService(model).namesMatching('whitefield')).resolves.toEqual([]);
        spy.mockRestore();
    });
});

describe('WarehouseService.buildWhere micro-market search', () => {
    const svc = () => new WarehouseService({}, new MicroMarketService(makeModel(SEARCH_POLYGONS)));

    /** The micromarket clause inside the free-text OR, or undefined if absent. */
    const mmClause = (where) => (where.OR || []).find((c) => c.micromarket);

    it('adds a hasSome clause for the resolved micro-market names', async () => {
        const where = await svc().buildWhere({ search: 'bomasandra' });
        expect(mmClause(where)).toEqual({
            micromarket: { hasSome: ['Bommasandra Industrial Area'] },
        });
    });

    it('keeps the existing free-text columns alongside it', async () => {
        const where = await svc().buildWhere({ search: 'whitefield' });
        const keys = where.OR.map((c) => Object.keys(c)[0]);
        expect(keys).toEqual(expect.arrayContaining([
            'address', 'city', 'contactPerson', 'warehouseType', 'warehouseOwnerType', 'micromarket',
        ]));
    });

    it('omits the clause when the term matches no micro-market', async () => {
        const where = await svc().buildWhere({ search: 'chakan' });
        expect(mmClause(where)).toBeUndefined();
        expect(where.OR.length).toBeGreaterThan(0);
    });

    it('omits the clause when no micro-market service is wired in', async () => {
        const where = await new WarehouseService({}).buildWhere({ search: 'whitefield' });
        expect(mmClause(where)).toBeUndefined();
    });

    it('leaves the OR absent entirely when there is no search term', async () => {
        const where = await svc().buildWhere({ city: 'Bengaluru' });
        expect(where.OR).toBeUndefined();
        expect(where.city).toEqual({ contains: 'Bengaluru', mode: 'insensitive' });
    });

    it('still matches the id for a numeric term', async () => {
        const where = await svc().buildWhere({ search: '42' });
        expect(where.OR).toEqual(expect.arrayContaining([{ id: 42 }]));
    });
});

const GeoService = require('../../src/services/geoService');

const makeModel = (rows = []) => ({
    osmPoisInBbox: jest.fn(async () => rows),
    ownPoisInBbox: jest.fn(async () => rows),
    warehousesInBbox: jest.fn(async () => rows),
    osmCategories: jest.fn(async () => [{ category: 'fuel', count: 3 }]),
    ownCategories: jest.fn(async () => []),
    createOwnPoi: jest.fn(async (d) => ({ id: 'new-id', ...d })),
    updateOwnPoi: jest.fn(async (id, d) => ({ id, ...d })),
    deleteOwnPoi: jest.fn(async () => ({})),
});

const BLR = '77.55,12.90,77.65,13.00';

describe('GeoService bbox validation', () => {
    let svc;
    beforeEach(() => { svc = new GeoService(makeModel()); });

    // A map request without a valid bbox is a request for the whole planet, so
    // these are correctness guards rather than input hygiene.
    it.each([
        ['missing', undefined],
        ['too few parts', '1,2,3'],
        ['non-numeric', 'a,b,c,d'],
        ['west >= east', '77.65,12.90,77.55,13.00'],
        ['south >= north', '77.55,13.00,77.65,12.90'],
        ['absurdly large', '0,0,120,80'],
        ['outside coordinate range', '-200,-100,200,100'],
    ])('rejects a bbox that is %s', async (_label, bbox) => {
        await expect(svc.osmPois({ bbox })).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it('accepts a sane bbox', async () => {
        await expect(svc.osmPois({ bbox: BLR })).resolves.toMatchObject({ type: 'FeatureCollection' });
    });
});

describe('GeoService GeoJSON shaping', () => {
    it('emits [lng, lat] order, which is what GeoJSON and Mapbox require', async () => {
        const svc = new GeoService(makeModel([{ id: 1, category: 'fuel', name: 'A', lat: 12.95, lng: 77.6 }]));

        const fc = await svc.osmPois({ bbox: BLR });

        expect(fc.features[0].geometry.coordinates).toEqual([77.6, 12.95]);
        expect(fc.features[0].properties).toMatchObject({ category: 'fuel', source: 'osm' });
    });

    it('flags truncation when the row cap is hit, so the UI can say so', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, category: 'fuel', lat: 1, lng: 1 }));
        const svc = new GeoService(makeModel(rows));

        const fc = await svc.osmPois({ bbox: BLR, limit: 10 });

        expect(fc.truncated).toBe(true);
    });

    it('does not flag truncation below the cap', async () => {
        const svc = new GeoService(makeModel([{ id: 1, category: 'fuel', lat: 1, lng: 1 }]));
        const fc = await svc.osmPois({ bbox: BLR, limit: 10 });
        expect(fc.truncated).toBe(false);
    });

    it('clamps an oversized limit rather than honouring it', async () => {
        const model = makeModel();
        const svc = new GeoService(model);

        await svc.osmPois({ bbox: BLR, limit: 999999 });

        const [, , limit] = model.osmPoisInBbox.mock.calls[0];
        expect(limit).toBe(5000); // MAX_LIMIT
    });

    it('treats an empty categories string as "no filter", not as one empty category', async () => {
        const model = makeModel();
        const svc = new GeoService(model);

        await svc.osmPois({ bbox: BLR, categories: '' });

        const [, categories] = model.osmPoisInBbox.mock.calls[0];
        expect(categories).toEqual([]);
    });
});

describe('GeoService own points', () => {
    it('stamps the creating user rather than trusting the payload', async () => {
        const model = makeModel();
        const svc = new GeoService(model);

        await svc.createOwnPoi(
            { name: 'Site', category: 'logistics_node', lat: 12.9, lng: 77.6, createdBy: 'attacker@evil.com' },
            { email: 'real@wareongo.com' },
        );

        expect(model.createOwnPoi.mock.calls[0][0].createdBy).toBe('real@wareongo.com');
    });

    it.each([
        ['latitude out of range', { name: 'a', category: 'b', lat: 999, lng: 77 }],
        ['longitude out of range', { name: 'a', category: 'b', lat: 12, lng: 999 }],
        ['missing name', { category: 'b', lat: 12, lng: 77 }],
        ['missing category', { name: 'a', lat: 12, lng: 77 }],
        ['non-numeric lat', { name: 'a', category: 'b', lat: 'north', lng: 77 }],
    ])('rejects %s', async (_label, body) => {
        const svc = new GeoService(makeModel());
        await expect(svc.createOwnPoi(body, { email: 'x@y.z' })).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it('allows a partial update without requiring every field', async () => {
        const model = makeModel();
        const svc = new GeoService(model);

        await svc.updateOwnPoi('abc', { name: 'Renamed' });

        expect(model.updateOwnPoi).toHaveBeenCalledWith('abc', { name: 'Renamed' });
    });

    it('rejects an update that would change nothing', async () => {
        const svc = new GeoService(makeModel());
        await expect(svc.updateOwnPoi('abc', {})).rejects.toMatchObject({ name: 'ValidationError' });
    });
});

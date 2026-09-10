const Service = require('../../src/services/warehouseProximityService');
const { CATEGORIES } = require('../../src/utils/proximityCategories');
const { DirectionsUnavailableError } = require('../../src/utils/mapboxDirections');
const warehouse = { id: 42, lat: 12, lng: 77 };
const fresh = (category, extra = {}) => ({ category, status: 'OK', roadKm: 3,
    computedFromLat: warehouse.lat, computedFromLng: warehouse.lng, ...extra });

function setup({ stored = [], todo = [warehouse], incomplete = [] } = {}) {
    const model = {
        bounded: jest.fn(async (method, ...args) => {
            if (method === 'coverage') return CATEGORIES.map(c => ({ category: c.key, complete: !incomplete.includes(c.key) }));
            if (method === 'findPending') return todo;
            if (method === 'poiWatermarks') return new Map();
            if (method === 'rowsFor') return stored;
            if (method === 'nearestPois') return args[1].map(c => ({ category: c.key, name: c.key,
                poiId: '123', poiSource: 'osm_poi', lat: 12.1, lng: 77.1, directM: 1000 }));
            if (method === 'nearestHighway') return [{ name: 'NH44', poiId: '456', poiSource: 'osm_highway', lat: null, lng: null, directM: 1000 }];
            throw new Error(`Unexpected method ${method}`);
        }),
        upsertCurrent: jest.fn(async (_w, rows) => rows.length),
    };
    const log = { recent: jest.fn(async () => []), start: jest.fn(async () => ({ id: 9n })), finish: jest.fn(async () => {}) };
    const route = jest.fn(async (_token, _origin, dests) => dests.map(() => ({ km: 2, minutes: 3 })));
    return { model, log, route, service: new Service(model, log, { route }) };
}

const oldToken = process.env.MAPBOX_ACCESS_TOKEN;
beforeEach(() => { process.env.MAPBOX_ACCESS_TOKEN = 'test-only'; });
afterAll(() => { if (oldToken === undefined) delete process.env.MAPBOX_ACCESS_TOKEN; else process.env.MAPBOX_ACCESS_TOKEN = oldToken; });

test('fills nine road categories and only the highway name; never routes a highway point', async () => {
    const { service, model, route } = setup();
    const result = await service.sweep();
    expect(result).toMatchObject({ status: 'SUCCESS', updated: 1, rows: 10 });
    expect(route.mock.calls[0][2]).toHaveLength(9);
    expect(route.mock.calls[0][2].every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
    const rows = model.upsertCurrent.mock.calls[0][1];
    expect(rows.find(r => r.category === 'national_highway')).toMatchObject({
        status: 'IDENTITY_ONLY', landmarkName: 'NH44', roadKm: null, driveMinutes: null,
    });
    expect(rows.find(r => r.category === 'hospital')).toMatchObject({ status: 'OK', roadKm: 2, driveMinutes: 3 });
});

test('preserves current highway measurements and completed terminal results', async () => {
    const stored = CATEGORIES.filter(c => c.key !== 'hospital').map(c => fresh(c.key,
        c.key === 'fuel' ? { status: 'NONE_IN_RANGE', roadKm: null }
            : c.key === 'aerodrome' ? { status: 'ROUTING_FAILED', roadKm: null } : {}));
    const { service, model, route } = setup({ stored });
    await service.sweep();
    expect(route.mock.calls[0][2]).toHaveLength(1);
    expect(model.upsertCurrent.mock.calls[0][1].map(r => r.category)).toEqual(['hospital']);
    expect(model.bounded.mock.calls.some(c => c[0] === 'nearestHighway')).toBe(false);
});

test('refreshes moved coordinates and replaces an outdated highway distance with name only', async () => {
    const stored = CATEGORIES.map(c => fresh(c.key, { computedFromLat: 1 }));
    const { service, model } = setup({ stored });
    await service.sweep();
    const rows = model.upsertCurrent.mock.calls[0][1];
    expect(rows).toHaveLength(10);
    expect(rows.every(r => r.computedFromLat === 12)).toBe(true);
    expect(rows.find(r => r.category === 'national_highway').roadKm).toBeNull();
});

test('a coordinate change during routing does not count as an updated warehouse', async () => {
    const { service, model } = setup();
    model.upsertCurrent.mockResolvedValue(0);
    expect((await service.sweep()).updated).toBe(0);
});

test('a provider outage writes retry metadata, no invented proximity facts, and stops the batch', async () => {
    const { service, model, log, route } = setup({ todo: [warehouse, { ...warehouse, id: 43 }] });
    route.mockRejectedValue(new DirectionsUnavailableError('throttled', 429));
    const result = await service.sweep();
    expect(result).toMatchObject({ status: 'FAILED', failed: 1, deferred: 1 });
    expect(model.upsertCurrent).not.toHaveBeenCalled();
    expect(log.finish).toHaveBeenCalledWith(9n, 'FAILED', expect.any(Number),
        expect.objectContaining({ lat: 12, lng: 77, attempts: 1, retryAt: expect.any(String) }), expect.stringContaining('429'));
    expect(route).toHaveBeenCalledTimes(1);
});

test('exponential retry cooldown survives invocations and caps at six hours', async () => {
    const { service, log, route } = setup();
    log.recent.mockResolvedValue([{ status: 'FAILED', metadata: { lat: 12, lng: 77, attempts: 8 } }]);
    route.mockRejectedValue(new DirectionsUnavailableError('unavailable', 503));
    const before = Date.now();
    await service.sweep();
    const metadata = log.finish.mock.calls[0][3];
    expect(metadata.attempts).toBe(9);
    expect(new Date(metadata.retryAt).getTime() - before).toBeGreaterThanOrEqual(6 * 3600000);
    expect(new Date(metadata.retryAt).getTime() - before).toBeLessThan(6 * 3600000 + 1000);
});

test('does not compute against incomplete source categories', async () => {
    const { service, model } = setup({ incomplete: ['hospital'] });
    expect((await service.sweep()).status).toBe('PARTIAL');
    expect(model.upsertCurrent.mock.calls[0][1].some(r => r.category === 'hospital')).toBe(false);
});

test('dry run and an empty queue make no paid calls or run-log writes', async () => {
    const { service, model, route, log } = setup();
    delete process.env.MAPBOX_ACCESS_TOKEN;
    expect((await service.sweep({ dryRun: true })).status).toBe('DRY_RUN');
    expect(route).not.toHaveBeenCalled();
    expect(model.upsertCurrent).not.toHaveBeenCalled();
    expect(log.start).not.toHaveBeenCalled();
    const empty = setup({ todo: [] });
    expect((await empty.service.sweep()).status).toBe('SUCCESS');
});

test('caps a requested batch at five warehouses', async () => {
    const { service, model } = setup({ todo: [] });
    await service.sweep({ limit: 5000 });
    expect(model.bounded).toHaveBeenCalledWith('findPending', expect.any(Array), 6);
});

test('an aborted routing call leaves the warehouse eligible for a later retry', async () => {
    const { service, route, model } = setup();
    const controller = new AbortController();
    route.mockImplementation(async () => { controller.abort(); throw new Error('canceled'); });
    expect((await service.sweep({ signal: controller.signal })).status).toBe('FAILED');
    expect(model.upsertCurrent).not.toHaveBeenCalled();
});

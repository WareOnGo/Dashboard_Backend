const { Prisma } = require('@prisma/client');
const GeoModel = require('../../src/models/geoModel');
const GeoService = require('../../src/services/geoService');

const bbox = '77,12,78,13';
const box = { west: 77, south: 12, east: 78, north: 13 };
const row = id => ({ id, city: 'Bengaluru', availability: 'Yes', warehouseType: 'PEB', lat: 12.9, lng: 77.6 });

test('viewport filters are validated and preserve dashboard search, owner, compliance and ranges', async () => {
    const model = { warehousesInBbox: jest.fn().mockResolvedValue([row(1)]) };
    const markets = { namesMatching: jest.fn().mockResolvedValue(['Nelamangala']) };
    const service = new GeoService(model, markets);
    const fc = await service.warehouses({ bbox, limit: '25', search: 'nelamangla', state: 'Karnataka', contactPerson: 'Sharma', fireNoc: 'available', minArea: '5000', maxRate: '22.5' });
    expect(model.warehousesInBbox).toHaveBeenCalledWith(box, 26, {
        search: 'nelamangla', state: 'Karnataka', contactPerson: 'Sharma', fireNoc: 'available', minArea: 5000, maxRate: 22.5,
    }, ['Nelamangala']);
    expect(markets.namesMatching).toHaveBeenCalledWith('nelamangla');
    expect(fc.features[0].geometry.coordinates).toEqual([77.6, 12.9]);
    expect(fc.features[0].properties).toEqual({ id: 1, city: 'Bengaluru', availability: 'Yes', warehouseType: 'PEB' });
});

test.each(['not-a-number', '-10'])('invalid range %s is rejected before the spatial query', async minArea => {
    const model = { warehousesInBbox: jest.fn() };
    await expect(new GeoService(model).warehouses({ bbox, minArea })).rejects.toMatchObject({ name: 'ValidationError' });
    expect(model.warehousesInBbox).not.toHaveBeenCalled();
});

test('warehouse truncation uses a lookahead row and never exceeds the requested cap', async () => {
    const model = { warehousesInBbox: jest.fn().mockResolvedValue([row(1), row(2)]) };
    const service = new GeoService(model);
    expect((await service.warehouses({ bbox, limit: '2' })).truncated).toBe(false);
    model.warehousesInBbox.mockResolvedValue([row(1), row(2), row(3)]);
    const capped = await service.warehouses({ bbox, limit: '2' });
    expect(capped.truncated).toBe(true);
    expect(capped.features.map(feature => feature.properties.id)).toEqual([1, 2]);
    await service.warehouses({ bbox, limit: '999999' });
    expect(model.warehousesInBbox.mock.calls.at(-1)[1]).toBe(5001);
});

test('one indexed spatial query applies all filters before its cap with parameterized inputs', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const model = new GeoModel(prisma);
    const filters = { search: "x' OR 1=1 --", city: 'Bengaluru', state: 'Karnataka', zone: 'South', warehouseType: 'PEB', warehouseOwnerType: 'Owner', availability: 'Yes', isBroker: 'No', uploadedBy: 'employee', contactPerson: 'Sharma', listing_type: 'Rent', status: 'Ready', ids: '1,2', fireNoc: 'not_available', visibility: 'hidden', landType: 'Industrial', minArea: 5000, maxArea: 25000, minRate: 10, maxRate: 25 };
    await model.warehousesInBbox(box, 2001, filters, ['Nelamangala']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = Prisma.sql(...prisma.$queryRaw.mock.calls[0]);
    expect(query.text).toContain('d.geog &&');
    expect(query.text).toContain('ST_MakeEnvelope');
    expect(query.text).toContain('d.longitude BETWEEN');
    expect(query.text).toContain('w.visibility IS NOT TRUE');
    expect(query.text).toContain('d."fireNocAvailable" IS FALSE');
    expect(query.text).toContain('unnest(w."totalSpaceSqft")');
    expect(query.text).toContain('regexp_replace');
    expect(query.text).toContain('w.micromarket && ARRAY[');
    expect(query.text.indexOf('w."city" ILIKE')).toBeLessThan(query.text.indexOf('LIMIT'));
    expect(query.text).not.toContain(filters.search);
    expect(query.values).toContain(`%${filters.search}%`);
    expect(query.values).toContain('%Sharma%');
    expect(query.values).toContain('Nelamangala');
    expect(query.values.at(-1)).toBe(2001);
});

test('the ordinary GIS call still uses the same bounded query without dashboard filters', async () => {
    const model = { warehousesInBbox: jest.fn().mockResolvedValue([row(7)]) };
    const service = new GeoService(model);
    const fc = await service.warehouses({ bbox });
    expect(model.warehousesInBbox).toHaveBeenCalledWith(box, 2001, {}, []);
    expect(fc.features).toHaveLength(1);
    expect(fc.truncated).toBe(false);
});

test('a bounded warehouse read can advance beyond a capped page by ID', async () => {
    const model = { warehousesInBbox: jest.fn().mockResolvedValue([row(2002)]) };
    const service = new GeoService(model);
    await service.warehouses({ bbox, afterId: '2001', limit: '2000' });
    expect(model.warehousesInBbox).toHaveBeenCalledWith(box, 2001, { afterId: 2001 }, []);
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await new GeoModel(prisma).warehousesInBbox(box, 2001, { afterId: 2001 });
    const query = Prisma.sql(...prisma.$queryRaw.mock.calls[0]);
    expect(query.text.indexOf('w.id >')).toBeLessThan(query.text.indexOf('ORDER BY w.id'));
    expect(query.values).toContain(2001);
});

test.each(['-1', '1.5', '1 OR 1=1', '9007199254740993'])('rejects invalid warehouse cursor %s before querying', async afterId => {
    const model = { warehousesInBbox: jest.fn() };
    await expect(new GeoService(model).warehouses({ bbox, afterId })).rejects.toMatchObject({ name: 'ValidationError' });
    expect(model.warehousesInBbox).not.toHaveBeenCalled();
});

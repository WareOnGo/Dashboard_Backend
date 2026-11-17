const { resolvePin } = require('../../src/utils/googleMaps/resolvePin');
const WarehouseService = require('../../src/services/warehouseService');

test.each([
    'https://www.google.com/maps?q=12.9,77.6',
    'https://maps.google.com/?q=12.9,77.6',
    'https://www.google.co.in/maps/search/?api=1&query=12.9,77.6',
    'https://www.google.com/maps/place/Warehouse/@13.2,78.1,16z/data=!8m2!3d12.9!4d77.6',
    'https://www.google.com/maps/search/12.9,77.6',
])('resolves a pin, preferring it to the viewport: %s', async url => {
    const fetchImpl = jest.fn();
    expect(await resolvePin(url, { fetchImpl })).toMatchObject({ latitude: 12.9, longitude: 77.6 });
    expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([
    'https://www.google.com/maps/@12.9,77.6,16z',
    'https://maps.google.com/?ll=12.9,77.6',
    'https://www.google.com/maps?q=91,77',
    'https://www.google.com/maps?q=12,181',
    'https://evil.example/maps?q=12,77',
    'https://google.com.evil.example/maps?q=12,77',
    'https://google.com@evil.example/maps?q=12,77',
    'https://www.google.com:8443/maps?q=12,77',
    'file:///etc/passwd', 'not a URL', '', null,
])('rejects an unresolved, unsafe or invalid location: %s', async url => {
    const fetchImpl = jest.fn();
    await expect(resolvePin(url, { fetchImpl })).rejects.toHaveProperty('statusCode');
    expect(fetchImpl).not.toHaveBeenCalled();
});

test('follows Google share redirects and checks every destination', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(new Response(null, { status: 302,
        headers: { location: 'https://www.google.com/maps?q=0,-0.5' } }));
    expect(await resolvePin('https://maps.app.goo.gl/test', { fetchImpl })).toMatchObject({ latitude: 0, longitude: -0.5 });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } }));
    await expect(resolvePin('https://maps.app.goo.gl/test', { fetchImpl })).rejects.toHaveProperty('statusCode', 400);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('bounds redirect chains and reports network failures as retryable', async () => {
    const fetchImpl = jest.fn().mockImplementation(async () => new Response(null, { status: 302,
        headers: { location: 'https://maps.app.goo.gl/loop' } }));
    await expect(resolvePin('https://maps.app.goo.gl/loop', { fetchImpl })).rejects.toThrow(/redirects too many/);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    fetchImpl.mockRejectedValue(new Error('network unavailable'));
    await expect(resolvePin('https://maps.app.goo.gl/test', { fetchImpl })).rejects.toHaveProperty('statusCode', 503);
});

test('coordinates appended to a broken short link cannot bypass resolution', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(resolvePin('https://maps.app.goo.gl/missing?q=12,77', { fetchImpl })).rejects.toHaveProperty('statusCode', 422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('CID lookup is bounded and resolves a place rather than its viewport', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('[null,null,12.90000,77.60000]'));
    expect(await resolvePin('https://www.google.com/maps/place/Test/@13.0,78.0,16z/data=!1s0xab:0xcd', { fetchImpl }))
        .toMatchObject({ latitude: 12.9, longitude: 77.6 });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/www.google.com\/maps\/preview\/place/);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
});

test.each(['+45 32 12 34 56', '+1 202 555 0123', '+44 20 7946 0123'])('does not turn international %s into an Indian number', value => {
    expect(WarehouseService.prototype.normalizeContactNumber(value)).toBe(`+${value.replace(/\D/g, '')}`);
});

describe('adversarial location inputs', () => {
    test.each([
        'https://www.google.com/maps?q=12.9,77.6garbage',
        'https://www.google.com/maps?unrelated=q=12.9,77.6',
        'https://www.google.com/maps#q=12.9,77.6',
        'https://www.google.com/maps/search/?api=1&query=12.9,77.6&query_place_id=ChIJanotherPlace',
        'https://www.google.com/maps/dir/A/B/data=!3d12.9!4d77.6',
        'https://www.google.com/maps?q=12.9,77.6&q=15,80',
        'https://www.google.com/maps?fake=!3d12.9!4d77.6',
        'https://www.google.com/maps/place/test/data=!3d12.9!4d77.6junk',
    ])('does not claim an ambiguous or malformed link is verified: %s', async value => {
        const fetchImpl = jest.fn();
        await expect(resolvePin(value, { fetchImpl })).rejects.toHaveProperty('statusCode', 422);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    test('invalid percent encoding is a bad link, not a temporary upstream outage', async () => {
        await expect(resolvePin('https://www.google.com/maps/place/%bad')).rejects.toHaveProperty('statusCode', 422);
    });
});

test.each([
    'https://www.google.com/maps/dir/A/B/data=!1s0xab:0xcd',
    'https://www.google.com/maps?unrelated=!1s0xab:0xcd',
    'https://www.google.com/maps?api=1&map_action=map&q=12.9,77.6',
    'https://www.google.com/maps/place/test/data=!3d12!4d77!3d13!4d78',
])('does not fall back to an unrelated place ID or camera: %s', async value => {
    const fetchImpl = jest.fn();
    await expect(resolvePin(value, { fetchImpl })).rejects.toHaveProperty('statusCode', 422);
    expect(fetchImpl).not.toHaveBeenCalled();
});
test('keeps encoded dropped pins and valid DMS place links working', async () => {
    expect(await resolvePin('https://www.google.com/maps/place/12.9%2C+77.6')).toMatchObject({ latitude: 12.9, longitude: 77.6 });
    expect(await resolvePin('https://www.google.com/maps/place/12%C2%B030\'0%22S+77%C2%B015\'0%22W'))
        .toMatchObject({ latitude: -12.5, longitude: -77.25 });
    await expect(resolvePin('https://www.google.com/maps/place/12%C2%B090\'0%22N+77%C2%B015\'0%22E'))
        .rejects.toHaveProperty('statusCode', 422);
});

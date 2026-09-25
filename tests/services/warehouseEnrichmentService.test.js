const Service = require('../../src/services/warehouseEnrichmentService');

function setup() {
    const images = { sweep: jest.fn(async () => ({ status: 'SUCCESS', processed: 0 })) };
    const proximity = { sweep: jest.fn(async () => ({ status: 'SUCCESS', updated: 1 })) };
    const website = { sweep: jest.fn(async () => ({ status: 'SUCCESS', assessed: 0 })) };
    const log = { tryStart: jest.fn(async () => ({ id: 1n })), finish: jest.fn(async () => {}) };
    return { images, proximity, website, log, service: new Service(images, proximity, log, website) };
}

test('runs independent website and proximity work after the original labels, with fixed caps', async () => {
    const { service, images, proximity, website } = setup();
    const order = [];
    images.sweep.mockImplementation(async () => { order.push('images'); return { status: 'SUCCESS', processed: 0 }; });
    proximity.sweep.mockImplementation(async () => { order.push('proximity'); return { status: 'SUCCESS' }; });
    website.sweep.mockImplementation(async () => { order.push('website'); return { status: 'SUCCESS' }; });
    expect((await service.sweep()).status).toBe('SUCCESS');
    expect(order).toEqual(['images', 'proximity', 'website']);
    expect(images.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(proximity.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    expect(website.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 12 }));
});

test('an image failure does not suppress proximity and is reported independently', async () => {
    const { service, images, proximity, website, log } = setup();
    images.sweep.mockRejectedValue(new Error('OPENAI_API_KEY is not configured'));
    const result = await service.sweep();
    expect(result.status).toBe('PARTIAL');
    expect(result.stages.images.configurationMissing).toBe(true);
    expect(proximity.sweep).toHaveBeenCalledTimes(1);
    expect(website.sweep).toHaveBeenCalledTimes(1);
    expect(log.finish).toHaveBeenCalledWith(1n, 'PARTIAL', expect.any(Number), result.stages);
});

test('returns a failure when all stages fail, without hiding partial step results', async () => {
    const { service, images, proximity, website } = setup();
    images.sweep.mockResolvedValue({ status: 'FAILED', failed: 2 });
    proximity.sweep.mockRejectedValue(new Error('db unavailable'));
    website.sweep.mockResolvedValue({ status: 'FAILED', failed: 3 });
    expect((await service.sweep()).status).toBe('FAILED');
});

test('an overlapping sweep performs no stage work', async () => {
    const { service, images, proximity, website, log } = setup();
    log.tryStart.mockResolvedValue(null);
    expect((await service.sweep()).status).toBe('SKIPPED');
    expect(images.sweep).not.toHaveBeenCalled();
    expect(proximity.sweep).not.toHaveBeenCalled();
    expect(website.sweep).not.toHaveBeenCalled();
});

test('dry run reaches all stages without acquiring or writing run logs', async () => {
    const { service, images, proximity, website, log } = setup();
    expect((await service.sweep({ dryRun: true })).status).toBe('DRY_RUN');
    for (const stage of [images, proximity, website]) expect(stage.sweep).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(log.tryStart).not.toHaveBeenCalled();
    expect(log.finish).not.toHaveBeenCalled();
});

test('cancels a stalled image stage before starting independent follow-up budgets', async () => {
    jest.useFakeTimers();
    try {
        const { service, images, proximity, website } = setup();
        images.sweep.mockImplementation(({ signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ status: 'PARTIAL' }), { once: true });
        }));
        const running = service.sweep();
        await jest.advanceTimersByTimeAsync(30001);
        const result = await running;
        expect(result.status).toBe('PARTIAL');
        expect(proximity.sweep.mock.calls[0][0].signal.aborted).toBe(false);
        expect(website.sweep.mock.calls[0][0].signal.aborted).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test('website failure does not change the outcome of original labeling or proximity', async () => {
    const { service, images, proximity, website } = setup();
    website.sweep.mockRejectedValue(new Error('model unavailable'));
    const result = await service.sweep();
    expect(result.status).toBe('PARTIAL');
    expect(result.stages.images.status).toBe('SUCCESS');
    expect(result.stages.proximity.status).toBe('SUCCESS');
    expect(result.stages.websiteImages.status).toBe('FAILED');
    expect(images.sweep).toHaveBeenCalledTimes(1);
    expect(proximity.sweep).toHaveBeenCalledTimes(1);
});

test('parallel follow-ups finish within the existing cron request budget and use different cancellation signals', async () => {
    jest.useFakeTimers();
    try {
        const { service, images, proximity, website } = setup();
        const stalled = ({ signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ status: 'PARTIAL' }), { once: true });
        });
        for (const stage of [images, proximity, website]) stage.sweep.mockImplementation(stalled);
        const running = service.sweep();
        await jest.advanceTimersByTimeAsync(30001);
        expect(proximity.sweep).toHaveBeenCalledTimes(1);
        expect(website.sweep).toHaveBeenCalledTimes(1);
        expect(proximity.sweep.mock.calls[0][0].signal).not.toBe(website.sweep.mock.calls[0][0].signal);
        await jest.advanceTimersByTimeAsync(45001);
        const result = await running;
        expect(result.status).toBe('PARTIAL');
        expect(result.durationMs).toBeLessThan(80000);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

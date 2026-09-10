const Service = require('../../src/services/warehouseEnrichmentService');

function setup() {
    const images = { sweep: jest.fn(async () => ({ status: 'SUCCESS', processed: 0 })) };
    const proximity = { sweep: jest.fn(async () => ({ status: 'SUCCESS', updated: 1 })) };
    const log = { tryStart: jest.fn(async () => ({ id: 1n })), finish: jest.fn(async () => {}) };
    return { images, proximity, log, service: new Service(images, proximity, log) };
}

test('runs proximity even when images have no work, sequentially with fixed caps', async () => {
    const { service, images, proximity } = setup();
    const order = [];
    images.sweep.mockImplementation(async () => { order.push('images'); return { status: 'SUCCESS', processed: 0 }; });
    proximity.sweep.mockImplementation(async () => { order.push('proximity'); return { status: 'SUCCESS' }; });
    expect((await service.sweep()).status).toBe('SUCCESS');
    expect(order).toEqual(['images', 'proximity']);
    expect(images.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(proximity.sweep).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
});

test('an image failure does not suppress proximity and is reported independently', async () => {
    const { service, images, proximity, log } = setup();
    images.sweep.mockRejectedValue(new Error('OPENAI_API_KEY is not configured'));
    const result = await service.sweep();
    expect(result.status).toBe('PARTIAL');
    expect(result.stages.images.configurationMissing).toBe(true);
    expect(proximity.sweep).toHaveBeenCalledTimes(1);
    expect(log.finish).toHaveBeenCalledWith(1n, 'PARTIAL', expect.any(Number), result.stages);
});

test('returns a failure when both stages fail, without hiding partial step results', async () => {
    const { service, images, proximity } = setup();
    images.sweep.mockResolvedValue({ status: 'FAILED', failed: 2 });
    proximity.sweep.mockRejectedValue(new Error('db unavailable'));
    expect((await service.sweep()).status).toBe('FAILED');
});

test('an overlapping sweep performs no stage work', async () => {
    const { service, images, proximity, log } = setup();
    log.tryStart.mockResolvedValue(null);
    expect((await service.sweep()).status).toBe('SKIPPED');
    expect(images.sweep).not.toHaveBeenCalled();
    expect(proximity.sweep).not.toHaveBeenCalled();
});

test('dry run reaches both stages without acquiring or writing run logs', async () => {
    const { service, images, proximity, log } = setup();
    expect((await service.sweep({ dryRun: true })).status).toBe('DRY_RUN');
    for (const stage of [images, proximity]) expect(stage.sweep).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(log.tryStart).not.toHaveBeenCalled();
    expect(log.finish).not.toHaveBeenCalled();
});

test('cancels a stalled image stage before starting the independent proximity budget', async () => {
    jest.useFakeTimers();
    try {
        const { service, images, proximity } = setup();
        images.sweep.mockImplementation(({ signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ status: 'PARTIAL' }), { once: true });
        }));
        const running = service.sweep();
        await jest.advanceTimersByTimeAsync(30001);
        const result = await running;
        expect(result.status).toBe('PARTIAL');
        expect(proximity.sweep.mock.calls[0][0].signal.aborted).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

const ImageLabelService = require('../../src/services/imageLabelService');

// Keep classifier, database and cache calls local to the test fixtures.
jest.mock('../../src/utils/imageClassifier', () => ({
    PRICING: { 'gpt-5.6-terra': { in: 2.0, out: 12.0 } },
    classify: jest.fn(),
    // Must be mocked even for tests that never produce a DOCUMENT: the sweep looks
    // it up unconditionally, so omitting it here would make any future DOCUMENT
    // fixture crash on `undefined is not a function` rather than fail a claim.
    classifyDocumentKind: jest.fn(),
}));
jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ ImagePipelineRepository: jest.fn() }));
jest.mock('../../src/utils/imageCacheInvalidation', () => ({ invalidateImageCache: jest.fn(async () => {}) }));
const { classify, classifyDocumentKind } = require('../../src/utils/imageClassifier');
const { ImagePipelineRepository } = require('../../src/models/imagePipelineRepository.cjs');

const ok = (classification = 'INDOOR') => ({
    classification, description: 'a description', confidence: 0.99,
    inputTokens: 600, outputTokens: 45, latencyMs: 2000,
});

const makeModels = ({ unlabelled = [], inFlight = null } = {}) => {
    let remaining = unlabelled.length;
    const pending = { label: [...unlabelled], document: [] };
    const documentFailures = [];
    const repository = {
        reconcile: jest.fn(async () => ({ registered: unlabelled.length, retained: 0 })),
        claim: jest.fn(async (stage, { limit }) => pending[stage].splice(0, limit)),
        complete: jest.fn(async (stage, row, result) => {
            if (stage === 'label') {
                remaining--;
                if (result.classification === 'DOCUMENT') pending.document.push(row);
            }
            return 1;
        }),
        fail: jest.fn(async (stage, row) => {
            if (stage === 'document') documentFailures.push(row);
            return 1;
        }),
        backlog: jest.fn(async () => ({ PENDING: pending.document.length, FAILED: documentFailures.length })),
    };
    ImagePipelineRepository.mockImplementation(() => repository);
    const imageLabelModel = {
        prisma: {},
        countUnlabelled: jest.fn(async () => remaining),
        countByClassification: jest.fn(async () => [{ classification: 'INDOOR', count: 2 }]),
        countAll: jest.fn(async () => 2),
        countStale: jest.fn(async () => 0),
        findForWarehouse: jest.fn(async () => []),
        findForWarehouses: jest.fn(async () => []),
    };
    const cronRunLogModel = {
        tryStart: jest.fn(async () => inFlight ? null : ({ id: 1n })),
        findInFlight: jest.fn(async () => inFlight),
        start: jest.fn(async () => ({ id: 1n })),
        finish: jest.fn(async () => ({})),
        recent: jest.fn(async () => [{ id: 2n, ranAt: new Date(), status: 'SUCCESS', durationMs: 10, metadata: null, notes: null }]),
    };
    imageLabelModel.bounded = jest.fn(async (method, ...args) => imageLabelModel[method](...args));
    return { imageLabelModel, cronRunLogModel, repository };
};

const images = (n) => Array.from({ length: n }, (_, i) => ({ warehouseId: i + 1, imageUrl: `https://x/${i}.jpg` }));

describe('ImageLabelService.sweep', () => {
    const OLD_KEY = process.env.OPENAI_API_KEY;
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.OPENAI_API_KEY = 'test-key';
        classify.mockImplementation(async () => ok());
        classifyDocumentKind.mockImplementation(async () => ({
            documentKind: 'LAYOUT', reason: 'a plan', confidence: 0.95,
            inputTokens: 400, outputTokens: 30,
        }));
    });
    afterAll(() => { process.env.OPENAI_API_KEY = OLD_KEY; });

    it('labels unlabelled images and reports the run', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(3) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep();

        expect(res.status).toBe('SUCCESS');
        expect(res.processed).toBe(3);
        expect(res.labelled).toBe(3);
        expect(res.failed).toBe(0);
        expect(res.remaining).toBe(0);
        expect(classify).toHaveBeenCalledTimes(3);
        expect(cronRunLogModel.finish).toHaveBeenCalledWith(1n, 'SUCCESS', expect.any(Number), expect.any(Object), null);
    });

    it('stops starting image requests when the budget expires while keeping completed labels', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(20) });
        const controller = new AbortController();
        classify.mockImplementation(async () => { controller.abort(); return ok(); });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);
        const result = await svc.sweep({ signal: controller.signal });
        expect(classify).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'PARTIAL', processed: 1, labelled: 1, deferred: 7, remaining: 19 });
        expect(repository.complete).toHaveBeenCalledTimes(1);
        expect(repository.fail).toHaveBeenCalledTimes(7);
        expect(repository.fail).toHaveBeenCalledWith('label', expect.any(Object), '', { deferred: true });
    });

    it('skips when another sweep is already in flight, without calling the API', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({
            unlabelled: images(3),
            inFlight: { id: 9n, ranAt: new Date() },
        });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep();

        // Overlap is normal, not an error — but it must not spend money.
        expect(res.status).toBe('SKIPPED');
        expect(classify).not.toHaveBeenCalled();
        expect(cronRunLogModel.start).not.toHaveBeenCalled();
    });

    it('keeps failed images pending for retry without saving a failed label', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(3) });
        classify
            .mockImplementationOnce(async () => ok())
            .mockImplementationOnce(async () => ({ error: 'http 400: bad image' }))
            .mockImplementationOnce(async () => ok('OUTDOOR'));
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep();

        expect(res.labelled).toBe(2);
        expect(res.failed).toBe(1);
        const written = repository.complete.mock.calls.map(([, row]) => row);
        expect(written).toHaveLength(2);
        expect(written.map((r) => r.imageUrl)).not.toContain('https://x/1.jpg');
        expect(repository.fail).toHaveBeenCalledWith('label', expect.objectContaining({ imageUrl: 'https://x/1.jpg' }), 'Image classification failed');
        expect(res.remaining).toBe(1);
    });

    it('caps the limit so one invocation cannot run unbounded', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(501) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const result = await svc.sweep({ limit: 99999 });

        expect(result).toMatchObject({ limit: 500, labelled: 500, remaining: 1, status: 'PARTIAL' });
        expect(classify).toHaveBeenCalledTimes(500);
    });

    it('retains stale metadata and reports the count without deleting rows', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(2) });
        repository.reconcile.mockResolvedValueOnce({ registered: 2, retained: 7 });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep();

        expect(res.pruned).toBe(0);
        expect(res.retained).toBe(7);
        expect(res.labelled).toBe(2);
    });

    it('reconciles current image references before labelling', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(1) });
        const order = [];
        repository.reconcile.mockImplementation(async () => { order.push('reconcile'); return { registered: 1, retained: 0 }; });
        classify.mockImplementation(async () => { order.push('classify'); return ok(); });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await svc.sweep();

        expect(order).toEqual(['reconcile', 'classify']);
    });

    it('dry run reports stale references without changing retention', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(5) });
        imageLabelModel.countStale.mockResolvedValueOnce(4);
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep({ dryRun: true });

        expect(res.wouldPrune).toBe(4);
        expect(repository.reconcile).not.toHaveBeenCalled();
    });

    it('dry run reports the backlog without calling the API or writing', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(5) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep({ dryRun: true });

        expect(res.status).toBe('DRY_RUN');
        expect(res.remaining).toBe(5);
        expect(classify).not.toHaveBeenCalled();
        expect(repository.complete).not.toHaveBeenCalled();
        expect(repository.claim).not.toHaveBeenCalled();
        expect(cronRunLogModel.start).not.toHaveBeenCalled();
        expect(cronRunLogModel.tryStart).not.toHaveBeenCalled();
    });

    it('fails loudly when no API key is configured rather than silently labelling nothing', async () => {
        delete process.env.OPENAI_API_KEY;
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(1) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await expect(svc.sweep()).rejects.toThrow(/OPENAI_API_KEY/);
        expect(classify).not.toHaveBeenCalled();
    });

    it('marks the run FAILED and rethrows if the batch blows up', async () => {
        const { imageLabelModel, cronRunLogModel, repository } = makeModels({ unlabelled: images(1) });
        repository.claim.mockRejectedValueOnce(new Error('db exploded'));
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await expect(svc.sweep()).rejects.toThrow('db exploded');
        expect(cronRunLogModel.finish).toHaveBeenCalledWith(1n, 'FAILED', expect.any(Number), null, 'db exploded');
    });
});

describe('ImageLabelService.getForWarehouse', () => {
    it('keys labels by url and omits unlabelled images', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        imageLabelModel.findForWarehouse.mockResolvedValueOnce([
            { imageUrl: 'a.jpg', classification: 'INDOOR', description: 'inside', confidence: 0.99 },
            { imageUrl: 'b.jpg', classification: null, description: null, confidence: null },
        ]);
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.getForWarehouse(42);

        expect(res.warehouseId).toBe(42);
        expect(res.total).toBe(2);
        expect(res.labelled).toBe(1);
        expect(res.labels['a.jpg'].classification).toBe('INDOOR');
        // Absent, not null — the consumer falls back per-image.
        expect(res.labels['b.jpg']).toBeUndefined();
        expect(res.images).toEqual([
            expect.objectContaining({ originalUrl: 'a.jpg', displayUrl: 'a.jpg', caption: 'inside' }),
            expect.objectContaining({ originalUrl: 'b.jpg', displayUrl: 'b.jpg', classification: null }),
        ]);
    });

    it('accepts a numeric string id, as it arrives from a route param', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.getForWarehouse('42');

        expect(res.warehouseId).toBe(42);
        expect(imageLabelModel.findForWarehouse).toHaveBeenCalledWith(42);
    });

    it('rejects a non-numeric id as a validation error, not a database error', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await expect(svc.getForWarehouse('abc')).rejects.toMatchObject({ name: 'ValidationError' });
        expect(imageLabelModel.findForWarehouse).not.toHaveBeenCalled();
    });

    it('returns an empty map for a warehouse with no images', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.getForWarehouse(7);

        expect(res).toEqual({ warehouseId: 7, total: 0, labelled: 0, labels: {}, images: [] });
    });
});

describe('ImageLabelService.getForWarehouses', () => {
    it('always returns image pairs, original fallbacks and empty arrays for empty warehouses', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        imageLabelModel.findForWarehouses.mockResolvedValueOnce([
            { warehouseId: 1, imageUrl: 'https://x/a.jpg', webpUrl: 'https://x/a.webp', classification: 'INDOOR', description: 'inside' },
            { warehouseId: 1, imageUrl: 'https://x/b.jpg', classification: null },
        ]);
        const result = await new ImageLabelService(imageLabelModel, cronRunLogModel).getForWarehouses([1, 2]);
        expect(result.warehouses['1'].images).toEqual([
            expect.objectContaining({ originalUrl: 'https://x/a.jpg', displayUrl: 'https://x/a.webp', caption: 'inside' }),
            expect.objectContaining({ originalUrl: 'https://x/b.jpg', displayUrl: 'https://x/b.jpg', classification: null }),
        ]);
        expect(result.warehouses['1'].labelled).toBe(1);
        expect(result.warehouses['2']).toEqual({ total: 0, labelled: 0, labels: {}, images: [] });
    });
});

describe('ImageLabelService.getStats', () => {
    it('returns coverage and serialises BigInt run ids', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels();
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const stats = await svc.getStats();

        expect(stats.labelled).toBe(2);
        expect(stats.recentRuns[0].id).toBe('2');
        // BigInt ids would otherwise throw here, breaking the endpoint.
        expect(() => JSON.stringify(stats)).not.toThrow();
    });
});

/**
 * The documents-only second pass.
 *
 * DOCUMENT holds both the drawings a client deck wants and the paperwork it must
 * never show, and the scene prompt cannot separate them. So documents get asked a
 * second question — and only documents, because they are ~1.6% of labelled images
 * and asking every photograph would cost sixty times more for an answer that does
 * not apply to it.
 */
describe('ImageLabelService.sweep — document sub-labels', () => {
    const OLD_KEY = process.env.OPENAI_API_KEY;
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.OPENAI_API_KEY = 'test-key';
        classifyDocumentKind.mockImplementation(async () => ({
            documentKind: 'LAYOUT', reason: 'a plan', confidence: 0.95,
            inputTokens: 400, outputTokens: 30,
        }));
    });
    afterAll(() => { process.env.OPENAI_API_KEY = OLD_KEY; });

    it('asks the second question only about documents', async () => {
        classify.mockImplementation(async (model, url) => (
            url.endsWith('1.jpg') ? ok('DOCUMENT') : ok('OUTDOOR')));
        const models = makeModels({ unlabelled: images(3) });
        const svc = new ImageLabelService(models.imageLabelModel, models.cronRunLogModel);

        await svc.sweep({ limit: 3 });

        expect(classify).toHaveBeenCalledTimes(3);
        expect(classifyDocumentKind).toHaveBeenCalledTimes(1);
        expect(classifyDocumentKind.mock.calls[0][1]).toContain('1.jpg');
    });

    it('stores the sub-label on the document row and nowhere else', async () => {
        classify.mockImplementation(async (model, url) => (
            url.endsWith('0.jpg') ? ok('DOCUMENT') : ok('INDOOR')));
        const models = makeModels({ unlabelled: images(2) });
        const svc = new ImageLabelService(models.imageLabelModel, models.cronRunLogModel);

        await svc.sweep({ limit: 2 });

        const writes = models.repository.complete.mock.calls;
        const documents = writes.filter(([stage]) => stage === 'document');
        expect(documents).toEqual([
            ['document', expect.objectContaining({ imageUrl: 'https://x/0.jpg' }), expect.objectContaining({ documentKind: 'LAYOUT' })],
        ]);
        expect(writes.filter(([stage]) => stage === 'label')).toHaveLength(2);
    });

    it('keeps the scene label when the sub-label call fails', async () => {
        // A document with no sub-label is still correctly a document. Failing the
        // row over it would discard a good scene label and make the image reappear
        // in the next sweep to be re-classified from scratch.
        classify.mockImplementation(async () => ok('DOCUMENT'));
        classifyDocumentKind.mockImplementation(async () => ({ error: 'http 500' }));
        const models = makeModels({ unlabelled: images(1) });
        const svc = new ImageLabelService(models.imageLabelModel, models.cronRunLogModel);

        const res = await svc.sweep({ limit: 1 });

        expect(models.repository.complete).toHaveBeenCalledTimes(1);
        expect(models.repository.complete).toHaveBeenCalledWith('label', expect.any(Object), expect.objectContaining({ classification: 'DOCUMENT' }));
        expect(models.repository.fail).toHaveBeenCalledWith('document', expect.any(Object), 'Image classification failed');
        expect(res).toMatchObject({ labelled: 1, documents: 0, failed: 1, status: 'PARTIAL' });
    });

    it('ignores a sub-label the schema does not define', async () => {
        classify.mockImplementation(async () => ok('DOCUMENT'));
        classifyDocumentKind.mockImplementation(async () => ({ documentKind: null, confidence: 0.1 }));
        const models = makeModels({ unlabelled: images(1) });
        const svc = new ImageLabelService(models.imageLabelModel, models.cronRunLogModel);

        await svc.sweep({ limit: 1 });

        expect(models.repository.complete).toHaveBeenCalledTimes(1);
        expect(models.repository.complete.mock.calls[0][0]).toBe('label');
        expect(models.repository.fail).toHaveBeenCalledWith('document', expect.any(Object), 'Image classification failed');
    });
});

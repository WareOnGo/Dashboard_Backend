const ImageLabelService = require('../../src/services/imageLabelService');

// The OpenAI call is the one thing these tests must not make for real.
jest.mock('../../src/utils/imageClassifier', () => ({
    PRICING: { 'gpt-5.6-terra': { in: 2.0, out: 12.0 } },
    classify: jest.fn(),
}));
const { classify } = require('../../src/utils/imageClassifier');

const ok = (classification = 'INDOOR') => ({
    classification, description: 'a description', confidence: 0.99,
    inputTokens: 600, outputTokens: 45, latencyMs: 2000,
});

const makeModels = ({ unlabelled = [], inFlight = null } = {}) => {
    let remaining = unlabelled.length;
    const imageLabelModel = {
        findUnlabelled: jest.fn(async (limit) => unlabelled.slice(0, limit)),
        countUnlabelled: jest.fn(async () => remaining),
        createManyLabels: jest.fn(async (rows) => {
            remaining = Math.max(0, remaining - rows.length);
            return rows.length;
        }),
        countByClassification: jest.fn(async () => [{ classification: 'INDOOR', count: 2 }]),
        countAll: jest.fn(async () => 2),
    };
    const cronRunLogModel = {
        findInFlight: jest.fn(async () => inFlight),
        start: jest.fn(async () => ({ id: 1n })),
        finish: jest.fn(async () => ({})),
        recent: jest.fn(async () => [{ id: 2n, ranAt: new Date(), status: 'SUCCESS', durationMs: 10, metadata: null, notes: null }]),
    };
    return { imageLabelModel, cronRunLogModel };
};

const images = (n) => Array.from({ length: n }, (_, i) => ({ warehouseId: i + 1, imageUrl: `https://x/${i}.jpg` }));

describe('ImageLabelService.sweep', () => {
    const OLD_KEY = process.env.OPENAI_API_KEY;
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.OPENAI_API_KEY = 'test-key';
        classify.mockImplementation(async () => ok());
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

    it('does not write failed images, so they are retried by the next sweep', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(3) });
        classify
            .mockImplementationOnce(async () => ok())
            .mockImplementationOnce(async () => ({ error: 'http 400: bad image' }))
            .mockImplementationOnce(async () => ok('OUTDOOR'));
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep();

        expect(res.labelled).toBe(2);
        expect(res.failed).toBe(1);
        const written = imageLabelModel.createManyLabels.mock.calls[0][0];
        expect(written).toHaveLength(2);
        expect(written.map((r) => r.imageUrl)).not.toContain('https://x/1.jpg');
    });

    it('caps the limit so one invocation cannot run unbounded', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(10) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await svc.sweep({ limit: 99999 });

        expect(imageLabelModel.findUnlabelled).toHaveBeenCalledWith(500); // MAX_LIMIT
    });

    it('dry run reports the backlog without calling the API or writing', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(5) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        const res = await svc.sweep({ dryRun: true });

        expect(res.status).toBe('DRY_RUN');
        expect(res.remaining).toBe(5);
        expect(classify).not.toHaveBeenCalled();
        expect(imageLabelModel.createManyLabels).not.toHaveBeenCalled();
        expect(cronRunLogModel.start).not.toHaveBeenCalled();
    });

    it('fails loudly when no API key is configured rather than silently labelling nothing', async () => {
        delete process.env.OPENAI_API_KEY;
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(1) });
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await expect(svc.sweep()).rejects.toThrow(/OPENAI_API_KEY/);
        expect(classify).not.toHaveBeenCalled();
    });

    it('marks the run FAILED and rethrows if the batch blows up', async () => {
        const { imageLabelModel, cronRunLogModel } = makeModels({ unlabelled: images(1) });
        imageLabelModel.findUnlabelled.mockRejectedValueOnce(new Error('db exploded'));
        const svc = new ImageLabelService(imageLabelModel, cronRunLogModel);

        await expect(svc.sweep()).rejects.toThrow('db exploded');
        expect(cronRunLogModel.finish).toHaveBeenCalledWith(1n, 'FAILED', expect.any(Number), null, 'db exploded');
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

const ImageLabelService = require('../../src/services/imageLabelService');

function makeModels() {
    return {
        imageLabelModel: {
            countUnlabelled: jest.fn(async () => 0),
            countByClassification: jest.fn(async () => [{ classification: 'INDOOR', count: 2 }]),
            countAll: jest.fn(async () => 2),
            findForWarehouse: jest.fn(async () => []),
            findForWarehouses: jest.fn(async () => []),
        },
        cronRunLogModel: {
            recent: jest.fn(async () => [{ id: 2n, ranAt: new Date(), status: 'SUCCESS', durationMs: 10, metadata: null, notes: null }]),
        },
    };
}

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

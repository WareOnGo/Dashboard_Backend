jest.mock('../../src/utils/imageClassifier', () => ({ PRICING: {}, classify: jest.fn(), classifyDocumentKind: jest.fn() }));
jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ ImagePipelineRepository: jest.fn() }));
jest.mock('../../src/utils/imageCacheInvalidation', () => ({ invalidateImageCache: jest.fn(async () => {}) }));
const { classify, classifyDocumentKind } = require('../../src/utils/imageClassifier');
const { ImagePipelineRepository } = require('../../src/models/imagePipelineRepository.cjs');
const { invalidateImageCache } = require('../../src/utils/imageCacheInvalidation');
const ImageLabelService = require('../../src/services/imageLabelService');

beforeEach(() => jest.clearAllMocks());
function fixture() {
    const scene = { id: 1, imageUrl: 'https://fixture.test/a.jpg', labelClaimToken: 'scene' };
    const document = { ...scene, documentClaimToken: 'doc' };
    const queues = { label: [[scene], []], document: [[document], []] };
    const repository = { reconcile: jest.fn(async () => ({ registered: 1, retained: 0 })),
        claim: jest.fn(async stage => queues[stage].shift() || []), complete: jest.fn(async () => 1),
        fail: jest.fn(async () => 1), backlog: jest.fn(async () => ({ FAILED: 1 })) };
    ImagePipelineRepository.mockImplementation(() => repository);
    return { repository, scene, service: new ImageLabelService({ prisma: {}, countUnlabelled: async () => 0 }, {}) };
}
test('a failed document subtype preserves the committed caption and invalidates the cache once', async () => {
    const { repository, service } = fixture();
    classify.mockResolvedValue({ classification: 'DOCUMENT', description: 'Site plan', confidence: 0.9 });
    classifyDocumentKind.mockResolvedValue({ error: 'fixture failure' });
    const result = await service.processBatch(10, 'fixture');
    expect(result).toMatchObject({ labelled: 1, documents: 0, failed: 1 });
    expect(repository.complete).toHaveBeenCalledWith('label', expect.any(Object), expect.objectContaining({ description: 'Site plan' }));
    expect(repository.fail).toHaveBeenCalledWith('document', expect.any(Object), 'Image classification failed');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(invalidateImageCache).toHaveBeenCalledTimes(1);
});
test('time budget expiry releases work that never started and preserves the successful result', async () => {
    const { repository, scene, service } = fixture();
    const controller = new AbortController();
    repository.claim.mockResolvedValueOnce([scene, { ...scene, id: 2 }]);
    classify.mockImplementation(async () => { controller.abort(); return { classification: 'INDOOR', description: 'Inside' }; });
    const result = await service.processBatch(10, 'fixture', controller.signal);
    expect(result).toMatchObject({ labelled: 1, deferred: 1 });
    expect(repository.fail).toHaveBeenCalledWith('label', expect.objectContaining({ id: 2 }), '', { deferred: true });
    expect(classify).toHaveBeenCalledTimes(1);
});

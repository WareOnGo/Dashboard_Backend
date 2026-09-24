const express = require('express');
const request = require('supertest');
const JWTService = require('../../src/services/jwtService');
const PptController = require('../../src/controllers/pptController');

const mockService = {
    parseIds: require('../../src/services/pptGenerationService').prototype.parseIds,
    findWarehousesByIds: jest.fn(),
    createBuffer: jest.fn(),
};
const mockAudit = { log: jest.fn() };
const mockController = new PptController(mockService, mockAudit);
jest.mock('../../src/container', () => ({ resolve: () => mockController }));
jest.mock('../../src/utils/access', () => ({
    ...jest.requireActual('../../src/utils/access'),
    resolveCapabilities: jest.fn(async () => ({ DASHBOARD: true })),
}));
const app = express();
app.use(express.json());
app.use('/api', require('../../src/routes/ppt'));
const token = new JWTService().generateToken({ id: 1, email: 'ops@wareongo.com', name: 'Ops' });
const post = (route, body) => request(app).post(`/api/${route}`)
    .set('Authorization', `Bearer ${token}`).send({ ids: '1', ...body });

beforeEach(() => {
    jest.clearAllMocks();
    mockService.findWarehousesByIds.mockResolvedValue([{ id: 1 }]);
    mockService.createBuffer.mockImplementation(async (...args) => {
        Object.assign(args[5].imageStats, { webpImages: 2, originalFallbacks: 1, failedImages: 0 });
        return Buffer.from('deck');
    });
});

it.each(['generate-ppt', 'generate-ppt-v2', 'generate-ppt-v3', 'generate-detailed-ppt', 'generate-ppt-godamwale', 'generate-ppt-tci'])(
    '%s accepts compression as an explicit boolean and audits observed image counts', async route => {
        const response = await post(route, { compressedPpt: true,
            selectedImages: { 1: { photos: ['original-a', 'original-b'], cad: ['original-c'] } } });
        expect(response.status).toBe(200);
        expect(mockService.createBuffer.mock.calls[0][5].compressedPpt).toBe(true);
        expect(mockAudit.log.mock.calls[0][0].metadata).toMatchObject({
            compressedPpt: true, outcome: 'success', selectedImageCount: 3,
            imageStats: { webpImages: 2, originalFallbacks: 1, failedImages: 0 },
        });
    },
);

it.each([undefined, false])('keeps normal exports when compressedPpt is %s', async value => {
    expect((await post('generate-ppt-v3', { compressedPpt: value })).status).toBe(200);
    expect(mockService.createBuffer.mock.calls[0][5].compressedPpt).toBe(false);
    expect(mockAudit.log.mock.calls[0][0].metadata.compressedPpt).toBe(false);
});

it.each(['true', 'false', 1, null, {}])('rejects invalid compressedPpt=%p before DB or export work', async value => {
    const response = await post('generate-ppt-v3', { compressedPpt: value });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('compressedPpt must be a boolean.');
    expect(mockService.findWarehousesByIds).not.toHaveBeenCalled();
    expect(mockService.createBuffer).not.toHaveBeenCalled();
});

it('ignores PPT compression for Excel, including its audit metadata', async () => {
    expect((await post('generate-xlsx-last-mile', { compressedPpt: true })).status).toBe(200);
    expect(mockService.createBuffer.mock.calls[0][5].compressedPpt).toBe(false);
    expect(mockAudit.log.mock.calls[0][0].metadata).not.toHaveProperty('compressedPpt');
});

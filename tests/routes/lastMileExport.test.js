process.env.JWT_SECRET = 'test-only-last-mile-secret';
const express = require('express');
const request = require('supertest');
const ExcelJS = require('exceljs');
const JWTService = require('../../src/services/jwtService');
const PptController = require('../../src/controllers/pptController');
const PptGenerationService = require('../../src/services/pptGenerationService');

const mockModel = { findManyForPpt: jest.fn() };
const mockAudit = { log: jest.fn() };
const mockController = new PptController(new PptGenerationService(mockModel), mockAudit);
jest.mock('../../src/container', () => ({ resolve: () => mockController }));
jest.mock('../../src/utils/access', () => ({
    ...jest.requireActual('../../src/utils/access'),
    resolveCapabilities: jest.fn(async () => ({ DASHBOARD: true })),
}));
const app = express();
app.use(express.json());
app.use('/api', require('../../src/routes/ppt'));
const token = new JWTService().generateToken({ id: 1, email: 'ops@wareongo.com', name: 'Ops' });
const post = (body) => request(app).post('/api/generate-xlsx-last-mile')
    .set('Authorization', `Bearer ${token}`).send(body);

beforeEach(() => {
    jest.clearAllMocks();
    mockModel.findManyForPpt.mockResolvedValue([{ id: 2, address: 'Second' }, { id: 7, address: 'First' }]);
});

it('downloads a real XLSX through the authenticated route and audits the ordered export once', async () => {
    const response = await post({ ids: '7,2', customDetails: { clientName: 'Last Mile' } })
        .buffer(true).parse((res, callback) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body);
    expect(workbook.worksheets[0].getCell('B3').value).toBe('First');
    expect(workbook.worksheets[0].getCell('C3').value).toBe('Second');
    expect(mockModel.findManyForPpt).toHaveBeenCalledWith([7, 2]);
    expect(mockAudit.log).toHaveBeenCalledTimes(1);
    expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'EXPORT', userEmail: 'ops@wareongo.com',
        metadata: expect.objectContaining({ variant: 'last-mile', warehouseIds: [7, 2], outcome: 'success', reportedBy: 'server' }),
    }));
});

it.each([{}, { ids: '' }, { ids: 'invalid,-1' }])('rejects invalid warehouse selections (%p)', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockModel.findManyForPpt).not.toHaveBeenCalled();
    expect(mockAudit.log.mock.calls[0][0].metadata.outcome).toBe('failed');
});

it('reports missing warehouses', async () => {
    mockModel.findManyForPpt.mockResolvedValue([]);
    expect((await post({ ids: '999' })).status).toBe(404);
});

it('returns an Excel-specific error and records failures', async () => {
    mockModel.findManyForPpt.mockRejectedValue(new Error('DB unavailable'));
    const response = await post({ ids: '7' });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('An internal server error occurred during Last Mile Excel generation.');
    expect(mockAudit.log.mock.calls[0][0].metadata).toMatchObject({ outcome: 'failed', httpStatus: 500 });
});

const mockFindUnique = jest.fn();

jest.mock('../../src/utils/database', () => ({
  getClient: () => ({ verifiedNumber: { findUnique: mockFindUnique } })
}));

const { verifyScoutToken, clearScoutCache } = require('../../src/middleware/scoutMiddleware');

const ACTIVE_ROW = {
  id: 7,
  empID: 'VBHIWH',
  name: 'Scout Seven',
  email: 'seven@example.com',
  is_active: true
};

describe('verifyScoutToken', () => {
  let req, res, next;

  beforeEach(() => {
    clearScoutCache();
    mockFindUnique.mockReset();
    req = { body: {}, headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a request with no empID', async () => {
    await verifyScoutToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('accepts the empID from the x-scout-token header, upper-cased and trimmed', async () => {
    mockFindUnique.mockResolvedValue(ACTIVE_ROW);
    req.headers['x-scout-token'] = '  vbhiwh  ';

    await verifyScoutToken(req, res, next);

    expect(mockFindUnique).toHaveBeenCalledWith({ where: { empID: 'VBHIWH' } });
    expect(req.scout).toMatchObject({ id: 7, empid: 'VBHIWH', status: 'ACTIVE' });
    expect(next).toHaveBeenCalled();
  });

  it('rejects an unknown empID', async () => {
    mockFindUnique.mockResolvedValue(null);
    req.body.uploadedBy = 'NOPE';

    await verifyScoutToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a revoked scout with 403', async () => {
    mockFindUnique.mockResolvedValue({ ...ACTIVE_ROW, is_active: false });
    req.body.uploadedBy = 'VBHIWH';

    await verifyScoutToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // The bug this middleware caused: one presigned-URL request per media file
  // meant one query per file, and a large submission exhausted the connection
  // pooler. A whole submission must now cost a single query.
  it('queries once for a burst of requests carrying the same empID', async () => {
    mockFindUnique.mockResolvedValue(ACTIVE_ROW);

    for (let i = 0; i < 30; i += 1) {
      const r = { body: { uploadedBy: 'VBHIWH' }, headers: {} };
      await verifyScoutToken(r, res, next);
      expect(r.scout).toMatchObject({ empid: 'VBHIWH' });
    }

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(30);
  });

  it('re-queries after the cache is cleared', async () => {
    mockFindUnique.mockResolvedValue(ACTIVE_ROW);
    req.body.uploadedBy = 'VBHIWH';

    await verifyScoutToken(req, res, next);
    clearScoutCache('VBHIWH');
    await verifyScoutToken({ body: { uploadedBy: 'VBHIWH' }, headers: {} }, res, next);

    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejection, so granting access takes effect at once', async () => {
    mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(ACTIVE_ROW);
    req.body.uploadedBy = 'VBHIWH';

    await verifyScoutToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);

    const second = { body: { uploadedBy: 'VBHIWH' }, headers: {} };
    await verifyScoutToken(second, res, next);

    expect(mockFindUnique).toHaveBeenCalledTimes(2);
    expect(second.scout).toMatchObject({ empid: 'VBHIWH' });
  });

  // A pooler failure is not a bad employee ID. Reporting it as 500 "failed to
  // verify scout token" is what made this incident read as an auth problem.
  it('reports a database failure as a retryable 503, not 500', async () => {
    mockFindUnique.mockRejectedValue(
      new Error('max clients reached in session mode - pool_size: 15')
    );
    req.body.uploadedBy = 'VBHIWH';

    await verifyScoutToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('does not cache a database failure', async () => {
    mockFindUnique
      .mockRejectedValueOnce(new Error('pooler down'))
      .mockResolvedValueOnce(ACTIVE_ROW);
    req.body.uploadedBy = 'VBHIWH';

    await verifyScoutToken(req, res, next);
    const second = { body: { uploadedBy: 'VBHIWH' }, headers: {} };
    await verifyScoutToken(second, res, next);

    expect(mockFindUnique).toHaveBeenCalledTimes(2);
    expect(second.scout).toMatchObject({ empid: 'VBHIWH' });
  });
});

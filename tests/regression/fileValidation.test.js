const request = require('supertest');
const { app, prisma, storage, reset, tokenFor, active } = require('../helpers/app');
const { FILE_UPLOAD } = require('../../src/utils/constants');
const { HeadObjectCommand } = require('@aws-sdk/client-s3');
const modified = new Date('2026-01-01T00:00:00Z');
const metadata = { ContentLength: 1234, ContentType: 'image/jpeg', LastModified: modified };
const validate = (options = {}) => request(app).post('/api/warehouses/files/fixture.jpg/validate')
  .set('Authorization', `Bearer ${tokenFor()}`).send(options);

beforeEach(() => {
  reset();
  prisma.verifiedNumber.findFirst.mockResolvedValue(active());
  storage.send.mockResolvedValue(metadata);
});
test.each(FILE_UPLOAD.ALLOWED_MIME_TYPES)('accepts an existing non-empty %s object', async ContentType => {
  storage.send.mockResolvedValue({ ...metadata, ContentType });
  const { body } = await validate().expect(200);
  expect(body).toMatchObject({ isValid: true, validationErrors: [], fileSize: 1234, lastModified: modified.toISOString() });
  expect(storage.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  expect(storage.send.mock.calls[0][0].input).toEqual({ Bucket: 'warehouse-qa-fixture', Key: 'fixture.jpg' });
});
test.each([
  ['empty object', { ContentLength: 0 }],
  ['unknown size', { ContentLength: undefined }],
  ['invalid size', { ContentLength: -1 }],
  ['fractional size', { ContentLength: 1.5 }],
  ['oversized object', { ContentLength: FILE_UPLOAD.MAX_FILE_SIZE + 1 }],
  ['unsupported MIME', { ContentType: 'application/x-msdownload' }],
  ['missing MIME', { ContentType: undefined }],
])('rejects %s based on stored metadata', async (_name, overrides) => {
  storage.send.mockResolvedValue({ ...metadata, ...overrides });
  const { body } = await validate().expect(200);
  expect(body.isValid).toBe(false);
  expect(body.validationErrors.length).toBeGreaterThan(0);
});
test('accepts the exact size boundary and normalizes MIME metadata', async () => {
  storage.send.mockResolvedValue({ ...metadata, ContentLength: FILE_UPLOAD.MAX_FILE_SIZE, ContentType: ' IMAGE/JPEG; charset=binary' });
  expect((await validate().expect(200)).body.isValid).toBe(true);
});
test('allows a stricter caller size limit', async () => {
  expect((await validate({ maxSize: 1233 }).expect(200)).body.isValid).toBe(false);
  expect((await validate({ maxSize: 1234, checkSize: true, checkType: true }).expect(200)).body.isValid).toBe(true);
});
test.each([{ checkSize: false }, { checkType: false }, { maxSize: FILE_UPLOAD.MAX_FILE_SIZE + 1 },
  { maxSize: 0 }, { maxSize: '100' }, { maxSize: -1 }, { unexpected: true }])
  ('rejects invalid options before accessing storage: %j', async options => {
    await validate(options).expect(400);
    expect(storage.send).not.toHaveBeenCalled();
  });
test.each([
  { name: 'NotFound' }, { name: 'NoSuchKey' }, { name: 'S3ServiceException', $metadata: { httpStatusCode: 404 } },
])('missing object returns 404: %j', async error => {
  storage.send.mockRejectedValue(Object.assign(new Error('fixture missing'), error));
  const { body } = await validate().expect(404);
  expect(body.isValid).not.toBe(true);
});
test.each([
  [new Error('fixture storage outage'), 500],
  [Object.assign(new Error('fixture bucket missing'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }), 503],
])('storage failures never claim validation success', async (error, status) => {
  storage.send.mockRejectedValue(error);
  const { body } = await validate().expect(status);
  expect(body.isValid).not.toBe(true);
});

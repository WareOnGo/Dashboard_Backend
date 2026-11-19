const { S3Client } = require('@aws-sdk/client-s3');
const mockClient = new S3Client({ region: 'auto', endpoint: 'https://storage.example.test',
  credentials: { accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' }, requestChecksumCalculation: 'WHEN_REQUIRED' });
jest.mock('../../src/utils/s3Client', () => ({
  getClient: () => mockClient, getBucketName: () => 'fixture-bucket',
  getPublicUrlBase: () => 'https://media.example.test', validateConfig: () => true,
}));
const FileUploadService = require('../../src/services/fileUploadService');
afterAll(() => mockClient.destroy());

test('review uploads cryptographically bind the create-only condition; normal uploads retain their contract', async () => {
  const storage = new FileUploadService();
  const review = await storage.generatePresignedUrl({ contentType: 'image/jpeg' }, { preventOverwrite: true });
  expect(review.instructions.headers).toEqual({ 'Content-Type': 'image/jpeg', 'If-None-Match': '*' });
  expect(new URL(review.uploadUrl).searchParams.get('X-Amz-SignedHeaders').split(';')).toContain('if-none-match');
  const normal = await storage.generatePresignedUrl({ contentType: 'image/jpeg' });
  expect(normal.instructions.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  expect(new URL(normal.uploadUrl).searchParams.get('X-Amz-SignedHeaders').split(';')).not.toContain('if-none-match');
  expect(review.fileName).not.toBe(normal.fileName);
});

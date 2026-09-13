const request = require('supertest');
const { app, database, reset } = require('./helpers/app');

beforeEach(reset);

test('importing the production app does not connect or start a server', () => {
  expect(database.connect).not.toHaveBeenCalled();
  expect(app).toBeInstanceOf(Function);
});
test('root reports the production API', async () => {
  const { body } = await request(app).get('/').expect(200);
  expect(body).toMatchObject({ message: 'Warehouse API is running!', version: '2.0.0' });
});
test.each([true, false])('health reflects database health %s', async healthy => {
  database.healthCheck.mockResolvedValue(healthy);
  const { body } = await request(app).get('/health').expect(healthy ? 200 : 503);
  expect(body.status).toBe(healthy ? 'healthy' : 'unhealthy');
});
test('health reports an unavailable dependency', async () => {
  database.healthCheck.mockRejectedValue(new Error('fixture outage'));
  await request(app).get('/health').expect(503);
});
test('unknown routes return 404', async () => {
  const { body } = await request(app).get('/api/not-a-route').expect(404);
  expect(body).toMatchObject({ error: 'Route not found', path: '/api/not-a-route' });
});
test('malformed JSON returns 400 without reflecting the body', async () => {
  const { body } = await request(app).post('/api/warehouses')
    .set('Content-Type', 'application/json').send('{"fixture-secret":').expect(400);
  expect(body.code).toBe('INVALID_JSON');
  expect(JSON.stringify(body)).not.toContain('fixture-secret');
});
test('oversized JSON returns 413', async () => {
  const { body } = await request(app).post('/api/warehouses')
    .send({ padding: 'x'.repeat(10 * 1024 * 1024) }).expect(413);
  expect(body.code).toBe('PAYLOAD_TOO_LARGE');
});
test.each([
  ['Content-Type', 'application/json; charset=iso-8859-1'],
  ['Content-Encoding', 'unsupported'],
])('unsupported body encoding %s=%s returns 415', async (header, value) => {
  const { body } = await request(app).post('/api/warehouses')
    .set('Content-Type', 'application/json').set(header, value)
    .send('{"fixture-secret":"private"}').expect(415);
  expect(body.code).toBe('UNSUPPORTED_ENCODING');
  expect(JSON.stringify(body)).not.toContain('fixture-secret');
});
test('production CORS supports an allowed DELETE preflight', async () => {
  const response = await request(app).options('/api/warehouses/1')
    .set('Origin', 'http://localhost:3000')
    .set('Access-Control-Request-Method', 'DELETE').expect(200);
  expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  expect(response.headers['access-control-allow-methods']).toContain('DELETE');
});

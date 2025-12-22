const request = require('supertest');
const app = require('../src/app-test');

describe('App Basic Tests', () => {
  describe('GET /', () => {
    it('should return API status information', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);

      expect(response.body).toHaveProperty('message', 'Warehouse API is running!');
      expect(response.body).toHaveProperty('version', '2.0.0');
      expect(response.body).toHaveProperty('architecture', 'MVC');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect((res) => {
          expect([200, 503]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('services');
      expect(response.body.services).toHaveProperty('api', 'running');
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for non-existent routes', async () => {
      const response = await request(app)
        .get('/non-existent-route')
        .expect(404);

      expect(response.body).toHaveProperty('error', 'Route not found');
      expect(response.body).toHaveProperty('path', '/non-existent-route');
      expect(response.body).toHaveProperty('method', 'GET');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});
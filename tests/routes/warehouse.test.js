const request = require('supertest');
const app = require('../../src/app-test');
const { mockController } = require('../../src/routes/warehouse-test');

describe('Warehouse API Routes', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('GET /api/warehouses', () => {
    it('should return list of warehouses', async () => {
      const mockWarehouses = {
        data: [
          { id: 1, name: 'Warehouse 1', city: 'New York' },
          { id: 2, name: 'Warehouse 2', city: 'Los Angeles' }
        ],
        pagination: { page: 1, limit: 10, total: 2 }
      };

      // Mock the service method
      mockController.mockWarehouseService.getAllWarehouses.mockResolvedValue(mockWarehouses);

      const response = await request(app)
        .get('/api/warehouses')
        .expect(200);

      expect(response.body).toEqual(mockWarehouses);
      expect(mockController.mockWarehouseService.getAllWarehouses).toHaveBeenCalledWith({});
    });
  });

  describe('GET /api/warehouses/:id', () => {
    it('should return a specific warehouse', async () => {
      const mockWarehouse = {
        id: 1,
        name: 'Test Warehouse',
        city: 'New York',
        state: 'NY'
      };

      mockController.mockWarehouseService.getWarehouseById.mockResolvedValue(mockWarehouse);

      const response = await request(app)
        .get('/api/warehouses/1')
        .expect(200);

      expect(response.body).toEqual(mockWarehouse);
      expect(mockController.mockWarehouseService.getWarehouseById).toHaveBeenCalledWith(1);
    });

    it('should return 500 for invalid ID', async () => {
      const response = await request(app)
        .get('/api/warehouses/invalid-id')
        .expect(500);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('code', 'INTERNAL_ERROR');
    });
  });

  describe('GET /api/warehouses/search', () => {
    it('should search warehouses with query parameters', async () => {
      const mockSearchResults = {
        data: [
          { id: 1, name: 'NYC Warehouse', city: 'New York', state: 'NY' }
        ],
        pagination: { page: 1, limit: 10, total: 1 }
      };

      mockController.mockWarehouseService.searchWarehouses.mockResolvedValue(mockSearchResults);

      const response = await request(app)
        .get('/api/warehouses/search?city=New York&state=NY')
        .expect(200);

      expect(response.body).toEqual(mockSearchResults);
      expect(mockController.mockWarehouseService.searchWarehouses).toHaveBeenCalledWith({
        city: 'New York',
        state: 'NY'
      });
    });
  });

  describe('GET /api/warehouses/statistics', () => {
    it('should return warehouse statistics', async () => {
      const mockStats = {
        totalWarehouses: 10,
        averageSpace: 5000,
        totalCapacity: 50000,
        byState: { NY: 5, CA: 3, TX: 2 }
      };

      mockController.mockWarehouseService.getWarehouseStatistics.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/api/warehouses/statistics')
        .expect(200);

      expect(response.body).toEqual(mockStats);
      expect(mockController.mockWarehouseService.getWarehouseStatistics).toHaveBeenCalled();
    });
  });
});
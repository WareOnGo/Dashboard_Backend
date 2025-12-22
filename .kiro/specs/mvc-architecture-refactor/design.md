# MVC Architecture Refactor Design Document

## Overview

This design document outlines the transformation of the existing warehouse management API from a monolithic route-based structure to a clean MVC (Model-View-Controller) architecture. The refactored system will separate concerns into distinct layers: Controllers for HTTP handling, Services for business logic, Models for data access, and supporting infrastructure for validation and error handling.

## Architecture

### High-Level Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Controllers   │───▶│    Services     │───▶│     Models      │
│  (HTTP Layer)   │    │ (Business Logic)│    │ (Data Access)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Middleware    │    │   Validators    │    │     Prisma      │
│ (Cross-cutting) │    │ (Input Validation)│  │   (Database)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Directory Structure

```
src/
├── controllers/
│   ├── warehouseController.js
│   └── baseController.js
├── services/
│   ├── warehouseService.js
│   └── fileUploadService.js
├── models/
│   ├── warehouseModel.js
│   └── baseModel.js
├── validators/
│   ├── warehouseValidator.js
│   └── commonValidator.js
├── middleware/
│   ├── errorHandler.js
│   ├── validation.js
│   └── cors.js
├── utils/
│   ├── database.js
│   ├── s3Client.js
│   └── constants.js
├── routes/
│   └── index.js
└── app.js
```

## Components and Interfaces

### Controller Layer

**Purpose**: Handle HTTP requests/responses and coordinate with services

```javascript
// controllers/warehouseController.js
class WarehouseController extends BaseController {
  constructor(warehouseService, fileUploadService) {
    super();
    this.warehouseService = warehouseService;
    this.fileUploadService = fileUploadService;
  }

  async getAllWarehouses(req, res, next) {
    // Handle HTTP request, delegate to service, format response
  }

  async createWarehouse(req, res, next) {
    // Validate input, delegate to service, return response
  }

  async updateWarehouse(req, res, next) {
    // Extract params, delegate to service, handle response
  }

  async deleteWarehouse(req, res, next) {
    // Extract ID, delegate to service, return status
  }

  async generatePresignedUrl(req, res, next) {
    // Delegate to file upload service
  }
}
```

### Service Layer

**Purpose**: Contain business logic and orchestrate data operations

```javascript
// services/warehouseService.js
class WarehouseService {
  constructor(warehouseModel) {
    this.warehouseModel = warehouseModel;
  }

  async getAllWarehouses() {
    // Business logic for fetching warehouses
    return await this.warehouseModel.findAll();
  }

  async createWarehouse(warehouseData) {
    // Business logic for warehouse creation
    // Data transformation, business rules
    return await this.warehouseModel.create(warehouseData);
  }

  async updateWarehouse(id, updateData) {
    // Business logic for updates
    // Validation, transformation
    return await this.warehouseModel.update(id, updateData);
  }

  async deleteWarehouse(id) {
    // Business logic for deletion
    return await this.warehouseModel.delete(id);
  }
}
```

### Model Layer

**Purpose**: Handle database operations and data persistence

```javascript
// models/warehouseModel.js
class WarehouseModel extends BaseModel {
  constructor(prismaClient) {
    super(prismaClient);
    this.model = prismaClient.warehouse;
  }

  async findAll() {
    return await this.model.findMany({
      include: { WarehouseData: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async create(data) {
    const { warehouseData, ...warehouse } = data;
    return await this.model.create({
      data: {
        ...warehouse,
        WarehouseData: {
          create: warehouseData,
        },
      },
      include: { WarehouseData: true },
    });
  }

  async update(id, data) {
    const { warehouseData, ...warehouse } = data;
    return await this.model.update({
      where: { id: parseInt(id) },
      data: {
        ...warehouse,
        ...(warehouseData && {
          WarehouseData: {
            update: warehouseData,
          },
        }),
      },
      include: { WarehouseData: true },
    });
  }

  async delete(id) {
    return await this.model.delete({
      where: { id: parseInt(id) }
    });
  }
}
```

### Validation Layer

**Purpose**: Centralized input validation and sanitization

```javascript
// validators/warehouseValidator.js
class WarehouseValidator {
  static createWarehouseSchema = z.object({
    // Zod schema definitions
  });

  static updateWarehouseSchema = this.createWarehouseSchema.partial();

  static validateCreate(data) {
    return this.createWarehouseSchema.safeParse(data);
  }

  static validateUpdate(data) {
    return this.updateWarehouseSchema.safeParse(data);
  }
}
```

## Data Models

### Warehouse Entity Structure

```javascript
// Warehouse main entity
{
  id: number,
  warehouseType: string,
  address: string,
  city: string,
  state: string,
  zone: string,
  contactPerson: string,
  contactNumber: string,
  totalSpaceSqft: number[],
  compliances: string,
  ratePerSqft: string,
  uploadedBy: string,
  // ... other fields
  WarehouseData: WarehouseData // Related entity
}

// WarehouseData nested entity
{
  id: number,
  warehouseId: number,
  latitude: number,
  longitude: number,
  fireNocAvailable: boolean,
  fireSafetyMeasures: string,
  // ... other fields
}
```

## Error Handling

### Centralized Error Handler

```javascript
// middleware/errorHandler.js
class ErrorHandler {
  static handle(error, req, res, next) {
    // Prisma error handling
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return this.handlePrismaError(error, res);
    }
    
    // Validation errors
    if (error.name === 'ValidationError') {
      return this.handleValidationError(error, res);
    }
    
    // Generic error handling
    return this.handleGenericError(error, res);
  }

  static handlePrismaError(error, res) {
    switch (error.code) {
      case 'P2025':
        return res.status(404).json({ error: 'Resource not found' });
      case 'P2002':
        return res.status(409).json({ error: 'Duplicate entry' });
      default:
        return res.status(500).json({ error: 'Database error' });
    }
  }
}
```

### Error Response Format

```javascript
// Standardized error response structure
{
  error: string,           // Human-readable error message
  code?: string,          // Error code for programmatic handling
  details?: object,       // Additional error details
  timestamp: string,      // ISO timestamp
  path: string           // Request path where error occurred
}
```

## Testing Strategy

### Unit Testing Approach

1. **Controller Tests**: Mock services, test HTTP handling
2. **Service Tests**: Mock models, test business logic
3. **Model Tests**: Test database operations with test database
4. **Validator Tests**: Test input validation schemas
5. **Integration Tests**: Test complete request/response cycles

### Test Structure

```javascript
// Example controller test
describe('WarehouseController', () => {
  let controller;
  let mockWarehouseService;

  beforeEach(() => {
    mockWarehouseService = {
      getAllWarehouses: jest.fn(),
      createWarehouse: jest.fn(),
      // ... other methods
    };
    controller = new WarehouseController(mockWarehouseService);
  });

  describe('getAllWarehouses', () => {
    it('should return warehouses successfully', async () => {
      // Test implementation
    });
  });
});
```

## Migration Strategy

### Phase 1: Infrastructure Setup
- Create new directory structure
- Set up base classes and utilities
- Implement error handling middleware

### Phase 2: Model Layer
- Extract database operations to model classes
- Implement base model with common functionality
- Test model operations

### Phase 3: Service Layer
- Move business logic to service classes
- Implement dependency injection
- Test service operations

### Phase 4: Controller Layer
- Refactor route handlers to controller methods
- Implement proper HTTP handling
- Wire up all layers

### Phase 5: Validation & Middleware
- Extract validation logic
- Implement middleware stack
- Test complete integration

## Performance Considerations

1. **Database Connection Pooling**: Maintain single Prisma client instance
2. **Lazy Loading**: Load related data only when needed
3. **Caching Strategy**: Implement caching at service layer for frequently accessed data
4. **Error Handling**: Minimize error handling overhead in hot paths
5. **Memory Management**: Proper cleanup of resources and connections

## Security Considerations

1. **Input Validation**: All inputs validated at controller level
2. **SQL Injection**: Prisma ORM provides protection
3. **File Upload Security**: Validate file types and sizes
4. **Environment Variables**: Secure handling of sensitive configuration
5. **Error Information**: Avoid exposing sensitive data in error messages
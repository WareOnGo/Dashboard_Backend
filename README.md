# Warehouse Management API

A modern Node.js REST API for warehouse management built with Express.js and following MVC (Model-View-Controller) architecture patterns. This API provides comprehensive warehouse data management capabilities with file upload support, robust validation, and centralized error handling.

## 🏗️ Architecture Overview

This application follows a clean MVC architecture with clear separation of concerns:

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

### Architecture Layers

- **Controllers**: Handle HTTP requests/responses and coordinate with services
- **Services**: Contain business logic and orchestrate data operations
- **Models**: Handle database operations and data persistence
- **Validators**: Centralized input validation and sanitization
- **Middleware**: Cross-cutting concerns (error handling, CORS, logging)

## 📁 Project Structure

```
warehouse-api/
├── src/
│   ├── controllers/          # HTTP request handlers
│   │   ├── baseController.js
│   │   └── warehouseController.js
│   ├── services/            # Business logic layer
│   │   ├── baseService.js
│   │   ├── warehouseService.js
│   │   └── fileUploadService.js
│   ├── models/              # Data access layer
│   │   ├── baseModel.js
│   │   └── warehouseModel.js
│   ├── validators/          # Input validation
│   │   ├── baseValidator.js
│   │   ├── commonValidator.js
│   │   └── warehouseValidator.js
│   ├── middleware/          # Express middleware
│   │   ├── errorHandler.js
│   │   ├── validation.js
│   │   └── index.js
│   ├── utils/               # Utility functions
│   │   ├── database.js
│   │   ├── s3Client.js
│   │   └── constants.js
│   ├── routes/              # Route definitions
│   │   └── warehouse.js
│   ├── app.js               # Express app configuration
│   └── container.js         # Dependency injection container
├── prisma/
│   └── schema.prisma        # Database schema
├── routes/                  # Legacy routes (being phased out)
├── index.js                 # Application entry point
├── package.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- PostgreSQL database
- AWS S3 bucket (for file uploads)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd warehouse-api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the root directory:
   ```env
   # Database
   DATABASE_URL="postgresql://username:password@localhost:5432/warehouse_db"
   
   # Server
   PORT=3001
   NODE_ENV=development
   CORS_ORIGIN=*
   
   # AWS S3 Configuration
   AWS_ACCESS_KEY_ID=your_access_key
   AWS_SECRET_ACCESS_KEY=your_secret_key
   AWS_REGION=us-east-1
   S3_BUCKET_NAME=your-bucket-name
   ```

4. **Set up the database**
   ```bash
   # Generate Prisma client
   npx prisma generate
   
   # Run database migrations
   npx prisma db push
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:3001`

### Production Deployment

```bash
# Install production dependencies
npm ci --only=production

# Generate Prisma client
npm run postinstall

# Start the server
npm start
```

## 📚 API Documentation

### Base URL
```
http://localhost:3001/api
```

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "services": {
    "database": "connected",
    "api": "running"
  },
  "version": "2.0.0"
}
```

### Warehouse Endpoints

#### Get All Warehouses
```http
GET /api/warehouses
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "warehouseType": "Cold Storage",
      "address": "123 Storage St",
      "city": "New York",
      "state": "NY",
      "zone": "North",
      "contactPerson": "John Doe",
      "contactNumber": "+1234567890",
      "totalSpaceSqft": [10000],
      "compliances": "FDA, USDA",
      "ratePerSqft": "$5.50",
      "uploadedBy": "admin",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "WarehouseData": {
        "id": 1,
        "latitude": 40.7128,
        "longitude": -74.0060,
        "fireNocAvailable": true,
        "fireSafetyMeasures": "Sprinkler system, Fire exits"
      }
    }
  ],
  "count": 1
}
```

#### Create Warehouse
```http
POST /api/warehouses
Content-Type: application/json
```

**Request Body:**
```json
{
  "warehouseType": "Cold Storage",
  "address": "123 Storage St",
  "city": "New York",
  "state": "NY",
  "zone": "North",
  "contactPerson": "John Doe",
  "contactNumber": "+1234567890",
  "totalSpaceSqft": [10000],
  "compliances": "FDA, USDA",
  "ratePerSqft": "$5.50",
  "uploadedBy": "admin",
  "warehouseData": {
    "latitude": 40.7128,
    "longitude": -74.0060,
    "fireNocAvailable": true,
    "fireSafetyMeasures": "Sprinkler system, Fire exits"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "warehouseType": "Cold Storage",
    // ... other fields
  },
  "message": "Warehouse created successfully"
}
```

#### Update Warehouse
```http
PUT /api/warehouses/:id
Content-Type: application/json
```

**Request Body:** (Same as create, all fields optional)

#### Delete Warehouse
```http
DELETE /api/warehouses/:id
```

**Response:**
```json
{
  "success": true,
  "message": "Warehouse deleted successfully"
}
```

#### Generate Presigned URL for File Upload
```http
POST /api/warehouses/upload/presigned-url
Content-Type: application/json
```

**Request Body:**
```json
{
  "fileName": "warehouse-image.jpg",
  "fileType": "image/jpeg"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://s3.amazonaws.com/bucket/signed-url",
    "fileUrl": "https://s3.amazonaws.com/bucket/warehouse-image.jpg",
    "expiresIn": 3600
  }
}
```

### Error Responses

All errors follow a consistent format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": {
    "field": "Additional error details"
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "path": "/api/warehouses"
}
```

**Common HTTP Status Codes:**
- `400` - Bad Request (validation errors)
- `404` - Not Found
- `409` - Conflict (duplicate entries)
- `500` - Internal Server Error

## 🔧 Development

### Running Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Database Operations
```bash
# View database in Prisma Studio
npx prisma studio

# Reset database
npx prisma db push --force-reset

# Generate Prisma client after schema changes
npx prisma generate
```

### Code Quality
```bash
# Lint code
npm run lint

# Format code
npm run format
```

## 🏛️ Architecture Details

### Dependency Injection

The application uses a custom dependency injection container (`src/container.js`) to manage dependencies:

```javascript
// Example: Resolving a controller with its dependencies
const container = require('./src/container');
const warehouseController = container.resolve('warehouseController');
```

### Error Handling

Centralized error handling through `ErrorHandler` middleware:
- Prisma database errors
- Validation errors
- Generic application errors
- Consistent error response format

### Validation

Input validation using Zod schemas:
- Request body validation
- Query parameter validation
- File upload validation
- Automatic sanitization

### File Upload

AWS S3 integration for file uploads:
- Presigned URL generation
- Secure file upload
- File type validation
- Size limits

## 🔒 Security Features

- **Input Validation**: All inputs validated and sanitized
- **CORS Protection**: Configurable CORS policies
- **Error Information**: Sensitive data excluded from error responses
- **File Upload Security**: File type and size validation
- **Environment Variables**: Secure configuration management

## 📊 Monitoring & Health Checks

- **Health Check Endpoint**: `/health` - Database and service status
- **Request Logging**: Automatic request/response logging
- **Graceful Shutdown**: Proper cleanup on process termination
- **Error Tracking**: Comprehensive error logging

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow MVC architecture patterns
- Write comprehensive tests
- Add JSDoc comments to all functions
- Follow consistent code formatting
- Update documentation for API changes

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the API documentation above
- Review the architecture documentation

---

**Version:** 2.0.0  
**Architecture:** MVC Pattern  
**Last Updated:** 2024

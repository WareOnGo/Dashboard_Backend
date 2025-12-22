# Warehouse API Architecture Documentation

## Overview

This document provides detailed architectural diagrams and explanations for the Warehouse Management API, which follows a clean MVC (Model-View-Controller) pattern with dependency injection.

## System Architecture Diagram

```mermaid
graph TB
    subgraph "Client Layer"
        Client[Client Applications]
        Browser[Web Browser]
        Mobile[Mobile App]
    end

    subgraph "API Layer"
        Router[Express Router]
        Middleware[Middleware Stack]
        CORS[CORS Middleware]
        Validation[Validation Middleware]
        ErrorHandler[Error Handler]
    end

    subgraph "Controller Layer"
        BaseController[BaseController]
        WarehouseController[WarehouseController]
    end

    subgraph "Service Layer"
        BaseService[BaseService]
        WarehouseService[WarehouseService]
        FileUploadService[FileUploadService]
    end

    subgraph "Model Layer"
        BaseModel[BaseModel]
        WarehouseModel[WarehouseModel]
    end

    subgraph "Validation Layer"
        BaseValidator[BaseValidator]
        WarehouseValidator[WarehouseValidator]
    end

    subgraph "Infrastructure Layer"
        Database[(PostgreSQL Database)]
        S3[AWS S3/Cloudflare R2]
        Prisma[Prisma ORM]
    end

    subgraph "Dependency Injection"
        Container[DI Container]
    end

    Client --> Router
    Browser --> Router
    Mobile --> Router

    Router --> Middleware
    Middleware --> CORS
    Middleware --> Validation
    Middleware --> ErrorHandler

    Router --> WarehouseController
    WarehouseController --> BaseController

    WarehouseController --> WarehouseService
    WarehouseController --> FileUploadService
    WarehouseService --> BaseService
    FileUploadService --> BaseService

    WarehouseService --> WarehouseModel
    WarehouseModel --> BaseModel

    WarehouseController --> WarehouseValidator
    WarehouseValidator --> BaseValidator

    BaseModel --> Prisma
    Prisma --> Database
    FileUploadService --> S3

    Container --> WarehouseController
    Container --> WarehouseService
    Container --> FileUploadService
    Container --> WarehouseModel
```

## Request Flow Diagram

```mermaid
sequenceDiagram
    participant Client
    participant Router
    participant Middleware
    participant Controller
    participant Service
    participant Model
    participant Database

    Client->>Router: HTTP Request
    Router->>Middleware: Process Request
    Middleware->>Middleware: CORS Check
    Middleware->>Middleware: Body Parsing
    Middleware->>Middleware: Validation
    Middleware->>Controller: Validated Request
    Controller->>Controller: Extract Parameters
    Controller->>Service: Business Logic Call
    Service->>Service: Apply Business Rules
    Service->>Model: Data Operation
    Model->>Database: SQL Query
    Database-->>Model: Query Result
    Model-->>Service: Processed Data
    Service-->>Controller: Business Result
    Controller->>Controller: Format Response
    Controller-->>Client: HTTP Response

    Note over Client,Database: Error handling flows through ErrorHandler middleware
```

## Component Relationships

```mermaid
classDiagram
    class BaseController {
        +sendSuccess(res, data, statusCode)
        +sendCreated(res, data)
        +sendError(res, message, statusCode)
        +asyncHandler(fn)
        +extractId(req, paramName)
    }

    class WarehouseController {
        -warehouseService: WarehouseService
        -fileUploadService: FileUploadService
        +getAllWarehouses(req, res, next)
        +createWarehouse(req, res, next)
        +updateWarehouse(req, res, next)
        +deleteWarehouse(req, res, next)
        +generatePresignedUrl(req, res, next)
    }

    class BaseService {
        +validateData(data, validator)
        +transformData(data)
        +applyBusinessRules(data)
        +executeOperation(operation)
    }

    class WarehouseService {
        -warehouseModel: WarehouseModel
        +getAllWarehouses(options)
        +createWarehouse(data)
        +updateWarehouse(id, data)
        +deleteWarehouse(id)
        +searchWarehouses(criteria)
    }

    class FileUploadService {
        -s3Client: S3Client
        +generatePresignedUrl(request, options)
        +validateUploadedFile(fileName, options)
        +deleteUploadedFile(fileName)
    }

    class BaseModel {
        #prisma: PrismaClient
        +findMany(options)
        +findById(id, options)
        +create(data, options)
        +update(id, data, options)
        +delete(id)
    }

    class WarehouseModel {
        +findAll(options)
        +search(criteria)
        +getStatistics()
        +findByLocation(city, state)
    }

    class BaseValidator {
        +validate(schema, data)
        +validateOrThrow(schema, data)
        +createPaginationSchema(maxLimit)
    }

    class WarehouseValidator {
        +validateCreate(data)
        +validateUpdate(data)
        +validateId(params)
        +validateFileUpload(data)
    }

    BaseController <|-- WarehouseController
    BaseService <|-- WarehouseService
    BaseService <|-- FileUploadService
    BaseModel <|-- WarehouseModel
    BaseValidator <|-- WarehouseValidator

    WarehouseController --> WarehouseService
    WarehouseController --> FileUploadService
    WarehouseService --> WarehouseModel
    WarehouseController --> WarehouseValidator
```

## Dependency Injection Pattern

```mermaid
graph LR
    subgraph "Container"
        Container[DI Container]
    end

    subgraph "Models"
        WM[WarehouseModel]
    end

    subgraph "Services"
        WS[WarehouseService]
        FUS[FileUploadService]
    end

    subgraph "Controllers"
        WC[WarehouseController]
    end

    Container -->|"resolve('warehouseModel')"| WM
    Container -->|"resolve('warehouseService')"| WS
    Container -->|"resolve('fileUploadService')"| FUS
    Container -->|"resolve('warehouseController')"| WC

    WS -->|"depends on"| WM
    WC -->|"depends on"| WS
    WC -->|"depends on"| FUS
```

## Error Handling Flow

```mermaid
flowchart TD
    Request[Incoming Request] --> Middleware[Middleware Processing]
    Middleware --> Controller[Controller Method]
    Controller --> Service[Service Method]
    Service --> Model[Model Method]
    
    Model --> DatabaseError{Database Error?}
    Service --> ValidationError{Validation Error?}
    Controller --> GenericError{Generic Error?}
    
    DatabaseError -->|Yes| PrismaHandler[Prisma Error Handler]
    ValidationError -->|Yes| ValidationHandler[Validation Error Handler]
    GenericError -->|Yes| GenericHandler[Generic Error Handler]
    
    PrismaHandler --> ErrorResponse[Standardized Error Response]
    ValidationHandler --> ErrorResponse
    GenericHandler --> ErrorResponse
    
    ErrorResponse --> Client[Client Response]
    
    DatabaseError -->|No| Success[Success Response]
    ValidationError -->|No| Success
    GenericError -->|No| Success
    
    Success --> Client
```

## File Upload Architecture

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant FileUploadService
    participant S3
    participant Database

    Client->>API: Request Presigned URL
    API->>FileUploadService: Generate Presigned URL
    FileUploadService->>S3: Create Presigned URL
    S3-->>FileUploadService: Signed URL
    FileUploadService-->>API: Upload URL + File URL
    API-->>Client: Presigned URL Response

    Client->>S3: Upload File (Direct)
    S3-->>Client: Upload Success

    Client->>API: Save File Reference
    API->>Database: Store File Metadata
    Database-->>API: Success
    API-->>Client: File Saved
```

## Database Schema Relationships

```mermaid
erDiagram
    Warehouse {
        int id PK
        string warehouseType
        string address
        string city
        string state
        string zone
        string contactPerson
        string contactNumber
        int[] totalSpaceSqft
        string compliances
        string ratePerSqft
        string uploadedBy
        datetime createdAt
        datetime updatedAt
    }

    WarehouseData {
        int id PK
        int warehouseId FK
        float latitude
        float longitude
        boolean fireNocAvailable
        string fireSafetyMeasures
        string landType
        string vaastuCompliance
        string approachRoadWidth
        string dimensions
        string parkingDockingSpace
        string pollutionZone
        string powerKva
    }

    Warehouse ||--|| WarehouseData : "has one"
```

## Middleware Stack

```mermaid
graph TD
    Request[Incoming Request] --> CORS[CORS Middleware]
    CORS --> BodyParser[Body Parser Middleware]
    BodyParser --> Sanitization[Request Sanitization]
    Sanitization --> Logging[Request Logging]
    Logging --> Routes[Route Handlers]
    Routes --> Controllers[Controller Methods]
    Controllers --> ErrorHandler[Error Handler Middleware]
    ErrorHandler --> Response[HTTP Response]
```

## Key Architectural Principles

### 1. Separation of Concerns
- **Controllers**: Handle HTTP requests/responses only
- **Services**: Contain business logic and orchestration
- **Models**: Handle data persistence and database operations
- **Validators**: Manage input validation and sanitization

### 2. Dependency Injection
- Centralized dependency management through DI container
- Loose coupling between components
- Easy testing and mocking
- Singleton pattern for shared resources

### 3. Error Handling
- Centralized error handling middleware
- Consistent error response format
- Proper HTTP status codes
- Detailed logging for debugging

### 4. Validation Strategy
- Input validation at controller level
- Business rule validation at service level
- Database constraint validation at model level
- Consistent validation error format

### 5. File Upload Strategy
- Presigned URLs for direct client-to-S3 uploads
- Reduced server load and bandwidth
- Secure file upload with time-limited URLs
- File metadata tracking in database

## Performance Considerations

1. **Database Connection Pooling**: Single Prisma client instance
2. **Lazy Loading**: Load related data only when needed
3. **Caching Strategy**: Service-level caching for frequently accessed data
4. **Error Handling Optimization**: Minimal overhead in hot paths
5. **Memory Management**: Proper cleanup of resources and connections

## Security Features

1. **Input Validation**: All inputs validated at multiple levels
2. **SQL Injection Protection**: Prisma ORM provides built-in protection
3. **File Upload Security**: Content type and size validation
4. **Environment Variables**: Secure configuration management
5. **Error Information**: Sensitive data excluded from error responses
6. **CORS Configuration**: Configurable cross-origin policies

This architecture ensures maintainability, scalability, and security while following industry best practices for Node.js applications.
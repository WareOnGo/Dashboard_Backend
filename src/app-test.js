// src/app-test.js - Test version of app without server startup
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Mock database for tests
const mockDatabase = {
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    healthCheck: jest.fn().mockResolvedValue(true)
};

// Mock middleware
const mockValidationMiddleware = {
    sanitizeAll: () => (req, res, next) => next(),
    validateWarehouseCreate: (req, res, next) => next(),
    validateWarehouseUpdate: (req, res, next) => next(),
    validateFileUpload: (req, res, next) => next(),
    validateBatchFileUpload: (req, res, next) => next()
};

// Mock error handler
const mockErrorHandler = {
    handle: (error, req, res, next) => {
        console.error('Test Error:', error.message);
        res.status(500).json({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            timestamp: new Date().toISOString(),
            path: req.path
        });
    }
};

const app = express();

// Middleware
const corsOptions = {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mockValidationMiddleware.sanitizeAll());

// Request logging (simplified for tests)
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Mock routes for testing
app.use('/api/warehouses', require('./routes/warehouse-test'));

// Basic routes
app.get('/', (req, res) => {
    res.json({
        message: 'Warehouse API is running!',
        version: '2.0.0',
        architecture: 'MVC',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', async (req, res) => {
    try {
        const dbHealthy = await mockDatabase.healthCheck();
        const healthStatus = {
            status: dbHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealthy ? 'connected' : 'disconnected',
                api: 'running'
            },
            version: '2.0.0'
        };

        res.status(dbHealthy ? 200 : 503).json(healthStatus);
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Health check failed'
        });
    }
});

// 404 Handler
app.use((req, res, next) => {
    res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// Error handling
app.use(mockErrorHandler.handle);

module.exports = app;
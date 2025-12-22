// src/container.js
const database = require('./utils/database');

// Import Models
const WarehouseModel = require('./models/warehouseModel');

// Import Services
const WarehouseService = require('./services/warehouseService');
const FileUploadService = require('./services/fileUploadService');

// Import Controllers
const WarehouseController = require('./controllers/warehouseController');

/**
 * Dependency Injection Container
 * 
 * Manages application dependencies using the dependency injection pattern.
 * Supports both singleton and transient instance registration.
 * 
 * @example
 * // Resolve a controller with all its dependencies
 * const container = require('./container');
 * const warehouseController = container.resolve('warehouseController');
 * 
 * @example
 * // Register a new service
 * container.registerSingleton('myService', () => new MyService());
 */
class Container {
    /**
     * Create a new dependency injection container
     */
    constructor() {
        /**
         * Map of transient instance factories
         * @type {Map<string, Function>}
         * @private
         */
        this.instances = new Map();
        
        /**
         * Map of singleton instance factories
         * @type {Map<string, Function>}
         * @private
         */
        this.singletons = new Map();
    }

    /**
     * Register a singleton instance factory
     * 
     * Singleton instances are created once and reused for all subsequent requests.
     * Ideal for stateless services, models, and utilities.
     * 
     * @param {string} name - Unique service name identifier
     * @param {Function} factory - Factory function that creates the instance
     * @param {Container} factory.container - Container instance passed to factory
     * @returns {void}
     * 
     * @example
     * container.registerSingleton('database', () => new DatabaseService());
     * container.registerSingleton('userService', (container) => {
     *   const userModel = container.resolve('userModel');
     *   return new UserService(userModel);
     * });
     */
    registerSingleton(name, factory) {
        this.singletons.set(name, factory);
    }

    /**
     * Register a transient instance factory
     * 
     * Transient instances are created fresh for each resolution request.
     * Useful for stateful components or when you need a new instance each time.
     * 
     * @param {string} name - Unique service name identifier
     * @param {Function} factory - Factory function that creates the instance
     * @param {Container} factory.container - Container instance passed to factory
     * @returns {void}
     * 
     * @example
     * container.register('requestHandler', (container) => {
     *   const service = container.resolve('myService');
     *   return new RequestHandler(service);
     * });
     */
    register(name, factory) {
        this.instances.set(name, factory);
    }

    /**
     * Resolve a dependency by name
     * 
     * Returns the instance associated with the given name. For singletons,
     * the same instance is returned on subsequent calls. For transient
     * registrations, a new instance is created each time.
     * 
     * @param {string} name - Service name to resolve
     * @returns {*} The resolved service instance
     * @throws {Error} If the service is not registered
     * 
     * @example
     * const warehouseService = container.resolve('warehouseService');
     * const controller = container.resolve('warehouseController');
     */
    resolve(name) {
        // Check if it's a singleton
        if (this.singletons.has(name)) {
            const cacheKey = `singleton_${name}`;
            if (!this.instances.has(cacheKey)) {
                const factory = this.singletons.get(name);
                this.instances.set(cacheKey, factory(this));
            }
            return this.instances.get(cacheKey);
        }

        // Check if it's a regular instance
        if (this.instances.has(name)) {
            const factory = this.instances.get(name);
            return factory(this);
        }

        throw new Error(`Service '${name}' not found in container`);
    }

    /**
     * Check if a service is registered
     * 
     * @param {string} name - Service name to check
     * @returns {boolean} True if the service is registered
     * 
     * @example
     * if (container.has('myService')) {
     *   const service = container.resolve('myService');
     * }
     */
    has(name) {
        return this.singletons.has(name) || this.instances.has(name);
    }

    /**
     * Get all registered service names
     * 
     * @returns {string[]} Array of all registered service names
     * 
     * @example
     * const services = container.getRegisteredServices();
     * console.log('Available services:', services);
     */
    getRegisteredServices() {
        const singletonNames = Array.from(this.singletons.keys());
        const instanceNames = Array.from(this.instances.keys());
        return [...singletonNames, ...instanceNames];
    }

    /**
     * Initialize all application dependencies
     * 
     * Registers all models, services, and controllers with their dependencies.
     * This method sets up the complete dependency graph for the application.
     * 
     * Models are registered as singletons since they're stateless.
     * Services are registered as singletons for performance.
     * Controllers can be transient if they need per-request state.
     * 
     * @returns {void}
     * 
     * @example
     * const container = new Container();
     * container.initialize();
     * const controller = container.resolve('warehouseController');
     */
    initialize() {
        // Register Models (singletons)
        // Models are stateless and can be safely shared across requests
        this.registerSingleton('warehouseModel', () => {
            const prismaClient = database.getClient();
            return new WarehouseModel(prismaClient);
        });

        // Register Services (singletons)
        // Services contain business logic and are typically stateless
        this.registerSingleton('warehouseService', (container) => {
            const warehouseModel = container.resolve('warehouseModel');
            return new WarehouseService(warehouseModel);
        });

        this.registerSingleton('fileUploadService', () => {
            return new FileUploadService();
        });

        // Register Controllers (transient - new instance per request if needed)
        // Controllers handle HTTP requests and may benefit from fresh instances
        this.register('warehouseController', (container) => {
            const warehouseService = container.resolve('warehouseService');
            const fileUploadService = container.resolve('fileUploadService');
            return new WarehouseController(warehouseService, fileUploadService);
        });
    }

    /**
     * Clear all registrations and cached instances
     * 
     * Useful for testing or when you need to reset the container state.
     * 
     * @returns {void}
     * 
     * @example
     * // In tests
     * afterEach(() => {
     *   container.clear();
     * });
     */
    clear() {
        this.instances.clear();
        this.singletons.clear();
    }
}

// Create and initialize the global container instance
const container = new Container();
container.initialize();

module.exports = container;
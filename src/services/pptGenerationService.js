// src/services/pptGenerationService.js

const pptService = require('../ppt/services/pptService');
const pptServiceV2 = require('../ppt/services/pptServiceV2');
const pptServiceV3 = require('../ppt/services/pptServiceV3');
const pptServiceGodamwale = require('../ppt/services/pptServiceGodamwale');
const pptServiceTci = require('../ppt/services/pptServiceTci');
const detailedPptService = require('../ppt/services/detailedPptService');

/**
 * PPT generation service.
 *
 * Thin seam over the deck builders ported from the Warehouse Proposal Engine
 * (src/ppt/**). Those modules are kept byte-for-byte close to their original
 * form so slide output stays identical to what the standalone service produced;
 * everything backend-specific — the Prisma client, auth, auditing — lives here
 * and in PptController rather than being threaded through them.
 *
 * The engine shipped its own `new PrismaClient()`. This uses the injected model
 * so PPT requests share the app's single connection pool (the Supabase pooler
 * is configured with connection_limit=5 — a second pool would risk exhausting it).
 */
class PptGenerationService {
    /**
     * @param {WarehouseModel} warehouseModel - Injected warehouse model
     */
    constructor(warehouseModel) {
        this.warehouseModel = warehouseModel;
    }

    /**
     * Parse a comma-separated ID string into positive integers.
     * Mirrors the engine's `parseIds`: silently drops anything non-numeric or
     * non-positive rather than erroring, so a stray trailing comma is harmless.
     *
     * @param {string} idString - e.g. "1343, 2141, 556"
     * @returns {number[]}
     */
    parseIds(idString) {
        if (!idString) return [];
        return String(idString)
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id) && id > 0);
    }

    /**
     * Fetch warehouses by ID, preserving the caller's ordering.
     *
     * Slide order follows the order the user picked the warehouses in, which is
     * not the order Postgres returns them, so the result is re-sorted against
     * the input. IDs that don't exist are dropped.
     *
     * @param {number[]} warehouseIds
     * @returns {Promise<Object[]>}
     */
    async findWarehousesByIds(warehouseIds) {
        const warehouses = await this.warehouseModel.findManyForPpt(warehouseIds);
        const byId = new Map(warehouses.map(w => [w.id, w]));
        return warehouseIds.map(id => byId.get(id)).filter(Boolean);
    }

    /**
     * Build a deck. `variant` selects the template.
     *
     * @param {string} variant - 'standard' | 'v2' | 'v3' | 'godamwale' | 'tci' | 'detailed'
     * @param {Object[]} warehouses
     * @param {Object} selectedImages - { [warehouseId]: string[] }
     * @param {Object} customDetails
     * @param {boolean} includeLocation - standard variant only
     * @returns {Promise<Buffer>}
     */
    async createBuffer(variant, warehouses, selectedImages = {}, customDetails = {}, includeLocation = false) {
        switch (variant) {
            case 'standard':
                return pptService.createPptBuffer(warehouses, selectedImages, customDetails, includeLocation);
            case 'v2':
                return pptServiceV2.createPptBufferV2(warehouses, selectedImages, customDetails);
            case 'v3':
                return pptServiceV3.createPptBufferV3(warehouses, selectedImages, customDetails);
            case 'godamwale':
                return pptServiceGodamwale.createPptBufferGodamwale(warehouses, selectedImages, customDetails);
            case 'tci':
                return pptServiceTci.createPptBufferTci(warehouses, selectedImages, customDetails);
            case 'detailed':
                return detailedPptService.createDetailedPptBuffer(warehouses, selectedImages, customDetails);
            default:
                throw new Error(`Unknown PPT variant: ${variant}`);
        }
    }
}

module.exports = PptGenerationService;

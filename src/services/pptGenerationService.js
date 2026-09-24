// src/services/pptGenerationService.js

const pptService = require('../ppt/services/pptService');
const pptServiceV2 = require('../ppt/services/pptServiceV2');
const pptServiceV3 = require('../ppt/services/pptServiceV3');
const pptServiceGodamwale = require('../ppt/services/pptServiceGodamwale');
const pptServiceTci = require('../ppt/services/pptServiceTci');
const detailedPptService = require('../ppt/services/detailedPptService');
const { createLastMileBuffer } = require('../xlsx/lastMileService');
const { createPptImageLoader } = require('./pptImageService');

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
     * @param {string} variant - 'standard' | 'v2' | 'v3' | 'godamwale' | 'tci' | 'detailed' | 'last-mile'
     * @param {Object[]} warehouses
     * @param {Object} selectedImages - { [warehouseId]: string[] }
     * @param {Object} customDetails
     * @param {boolean} includeLocation - standard variant only
     * @returns {Promise<Buffer>}
     */
    async createBuffer(variant, warehouses, selectedImages = {}, customDetails = {}, includeLocation = false, options = {}) {
        const imageOptions = [];
        if (variant !== 'last-mile' && options.compressedPpt === true) {
            const urls = warehouses.flatMap(warehouse => {
                const selection = selectedImages[warehouse.id];
                const { photos, cad } = pptServiceV3.splitSelection(selection);
                const originals = [...photos, ...cad];
                // These templates can use a warehouse photo without an explicit
                // selection: Detailed's technical hero and TCI's default grid.
                if (variant === 'detailed') originals.push(...detailedPptService.parsePhotos(warehouse.photos).slice(0, 1));
                if (variant === 'tci' && !selection) originals.push(...detailedPptService.parsePhotos(warehouse.photos).slice(0, 4));
                return originals;
            });
            imageOptions.push({ imageLoader: await createPptImageLoader(this.warehouseModel.prisma, urls, options.imageStats) });
        }
        switch (variant) {
            case 'last-mile':
                return createLastMileBuffer(warehouses, selectedImages, customDetails);
            case 'standard':
                return pptService.createPptBuffer(warehouses, selectedImages, customDetails, includeLocation, ...imageOptions);
            case 'v2':
                return pptServiceV2.createPptBufferV2(warehouses, selectedImages, customDetails, ...imageOptions);
            case 'v3':
                return pptServiceV3.createPptBufferV3(warehouses, selectedImages, customDetails, ...imageOptions);
            case 'godamwale':
                return pptServiceGodamwale.createPptBufferGodamwale(warehouses, selectedImages, customDetails, ...imageOptions);
            case 'tci':
                return pptServiceTci.createPptBufferTci(warehouses, selectedImages, customDetails, ...imageOptions);
            case 'detailed':
                return detailedPptService.createDetailedPptBuffer(warehouses, selectedImages, customDetails, ...imageOptions);
            default:
                throw new Error(`Unknown PPT variant: ${variant}`);
        }
    }
}

module.exports = PptGenerationService;

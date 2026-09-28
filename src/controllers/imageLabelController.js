// src/controllers/imageLabelController.js
const BaseController = require('./baseController');

/**
 * Read-only image metadata and enrichment coverage for dashboard consumers.
 */
class ImageLabelController extends BaseController {
    /**
     * @param {ImageLabelService} imageLabelService
     */
    constructor(imageLabelService) {
        super();
        this.imageLabelService = imageLabelService;
    }

    /**
     * GET /api/image-labels/warehouse/:id
     * Labels for one warehouse's images, keyed by image URL. Unlabelled images
     * are absent from the map so callers can fall back per-image.
     */
    byWarehouse = this.asyncHandler(async (req, res) => {
        const data = await this.imageLabelService.getForWarehouse(req.params.id);
        return res.status(200).json({ success: true, data });
    });

    /**
     * GET /api/image-labels/stats
     * Label coverage, distribution and recent sweep history.
     */
    stats = this.asyncHandler(async (req, res) => {
        const data = await this.imageLabelService.getStats();
        return res.status(200).json({ success: true, data });
    });
}

module.exports = ImageLabelController;

// src/controllers/imageLabelController.js
const BaseController = require('./baseController');

/**
 * ImageLabelController — HTTP surface for the warehouse image-label sweep.
 *
 * The sweep is bounded per invocation so the request always returns promptly;
 * the response carries `remaining` so the caller can see whether a backlog is
 * still draining and poke again if it wants to catch up faster.
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
     * POST /api/image-labels/sweep
     * Body/query: { limit?: number, model?: string, dryRun?: boolean }
     *
     * Returns 200 with a summary. A run skipped because another sweep is in
     * flight is a normal outcome, not an error — it returns 200 with
     * status: 'SKIPPED' so a cron doesn't alert on it.
     */
    sweep = this.asyncHandler(async (req, res) => {
        const src = { ...req.query, ...req.body };
        const result = await this.imageLabelService.sweep({
            limit: src.limit !== undefined ? Number(src.limit) : undefined,
            model: src.model || undefined,
            dryRun: src.dryRun === true || src.dryRun === 'true',
        });
        return res.status(200).json({ success: true, data: result });
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

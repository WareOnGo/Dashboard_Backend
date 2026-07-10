// src/controllers/verifiedNumberController.js
const BaseController = require('./baseController');

/**
 * VerifiedNumberController — read-only access to verified staff numbers,
 * used to populate POC pickers on the frontend.
 */
class VerifiedNumberController extends BaseController {
    /**
     * @param {VerifiedNumberModel} verifiedNumberModel
     */
    constructor(verifiedNumberModel) {
        super();
        this.verifiedNumberModel = verifiedNumberModel;
    }

    /** GET /api/verified-numbers — active verified numbers as { data: [...] } */
    list = this.asyncHandler(async (req, res) => {
        const rows = await this.verifiedNumberModel.listActive();
        this.sendSuccess(res, { data: rows });
    });
}

module.exports = VerifiedNumberController;

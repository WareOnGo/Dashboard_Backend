const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyCronSecret } = require('../middleware/webhookMiddleware');
const container = require('../container');

const router = express.Router();
const service = container.resolve('warehouseEnrichmentService');
router.post('/sweep', rateLimit({ windowMs: 3600000, max: 120, standardHeaders: true, legacyHeaders: false }),
    verifyCronSecret, async (req, res, next) => {
        try {
            const body = req.body || {};
            if (Object.keys(body).some(key => key !== 'dryRun')
                || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')
                || Object.keys(req.query).length) {
                return res.status(400).json({ error: 'Only an optional boolean dryRun is accepted.' });
            }
            const result = await service.sweep({ dryRun: body.dryRun === true });
            return res.status(['FAILED', 'PARTIAL'].includes(result.status) ? 503 : 200)
                .json({ success: !['FAILED', 'PARTIAL'].includes(result.status), data: result });
        } catch (error) { next(error); }
    });

module.exports = router;

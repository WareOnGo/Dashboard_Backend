const { resolvePin } = require('../utils/googleMaps/resolvePin');
const rateLimit = require('express-rate-limit');
const { requiresNewFormFields } = require('../utils/formChanges');

// Location checks have their own allowance; typing a Maps URL must not consume
// the Scout image/voice upload allowance.
const locationCheckRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 200,
    message: { error: 'Too many location checks. Please try again later.' },
    standardHeaders: true, legacyHeaders: false,
});

const sendFailure = (res, error) => res.status(error.statusCode || 503).json({
    error: 'Location validation failed', message: error.message,
    details: { issues: error.issues || [{ path: ['googleLocation'], message: error.message }] },
});

async function resolveFormLocation(req, res) {
    try { res.json(await resolvePin(req.body?.googleLocation)); }
    catch (error) { sendFailure(res, error); }
}

function validateNewWarehouseForm(req, res, next) {
    if (requiresNewFormFields() && (typeof req.body?.warehouseData?.landType !== 'string' || !req.body.warehouseData.landType.trim())) {
        return res.status(400).json({ error: 'Validation failed', message: 'Land Type is required.',
            details: { issues: [{ path: ['warehouseData', 'landType'], message: 'Land Type is required.' }] } });
    }
    if (requiresNewFormFields() && (typeof req.body?.googleLocation !== 'string' || !req.body.googleLocation.trim())) {
        return res.status(400).json({ error: 'Validation failed', message: 'Google Location URL is required.',
            details: { issues: [{ path: ['googleLocation'], message: 'Google Location URL is required.' }] } });
    }
    // Pin resolution is deferred for a later audit. Saving does not contact Maps.
    if (typeof req.body?.googleLocation === 'string') req.body.googleLocation = req.body.googleLocation.trim();
    next();
}

function validateDashboardForm(req, res, next) {
    // Attribution belongs to the signed-in submitter, never a client-supplied name.
    req.body = { ...req.body, uploadedBy: req.user.email };
    return validateNewWarehouseForm(req, res, next);
}

module.exports = { resolveFormLocation, validateNewWarehouseForm, validateDashboardForm, locationCheckRateLimiter };

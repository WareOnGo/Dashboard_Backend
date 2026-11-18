const { resolvePin } = require('../utils/googleMaps/resolvePin');
const rateLimit = require('express-rate-limit');
const { PPT_FORM_FIELDS, HANDOVER_FIELDS, pptFormIssues } = require('../utils/pptFormPolicy');

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
    // Validate only writable payload paths. WarehouseData (the read shape)
    // and flattened nested keys are stripped by Zod and must not satisfy a
    // requirement here when the actual warehouseData value is missing.
    const answers = Object.fromEntries(PPT_FORM_FIELDS.map(field => [field.key,
        field.nested ? req.body?.warehouseData?.[field.key] : req.body?.[field.key]]));
    for (const key of HANDOVER_FIELDS) answers[key] = req.body?.[key];
    const issues = pptFormIssues(null, answers);
    if (issues.length) return res.status(400).json({ error: 'Validation failed', message: issues[0].message, details: { issues } });
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

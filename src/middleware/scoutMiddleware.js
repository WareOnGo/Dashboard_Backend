// src/middleware/scoutMiddleware.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Middleware to verify a scout's empid token
 * It checks if req.body.uploadedBy (or a header) contains a valid, active empid
 */
const verifyScoutToken = async (req, res, next) => {
    try {
        // Try to get token from body.uploadedBy (as requested) or fallback to an auth header
        const empid = req.body?.uploadedBy || req.headers['x-scout-token'];

        if (!empid) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Scout token (empid) is missing. Please provide your Employee ID in the uploadedBy field.'
            });
        }

        // Query the database for the scout
        const scout = await prisma.scout.findUnique({
            where: { empid }
        });

        // Check if scout exists and is active
        if (!scout) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid Scout token (empid).'
            });
        }

        if (scout.status !== 'ACTIVE') {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Your Scout access has been revoked. Please contact administration.'
            });
        }

        // Attach scout object to request for the controller to use
        req.scout = scout;
        next();
    } catch (error) {
        console.error('Error verifying scout token:', error);
        return res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to verify scout token.'
        });
    }
};

module.exports = {
    verifyScoutToken
};

// src/middleware/scoutMiddleware.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Middleware to verify a scout's empID against the VerifiedNumber table.
 * Token comes in via req.body.uploadedBy or the x-scout-token header.
 * On success, attaches req.scout with { id, empid, name, email, status } so
 * downstream controllers can keep using their existing field names.
 */
const verifyScoutToken = async (req, res, next) => {
    try {
        const rawEmpId = req.body?.uploadedBy || req.headers['x-scout-token'];

        if (!rawEmpId) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Scout token (empID) is missing. Please provide your Employee ID in the uploadedBy field.'
            });
        }

        const empID = String(rawEmpId).trim().toUpperCase();

        const verified = await prisma.verifiedNumber.findUnique({
            where: { empID }
        });

        if (!verified) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid Scout token (empID).'
            });
        }

        if (!verified.is_active) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Your Scout access has been revoked. Please contact administration.'
            });
        }

        req.scout = {
            id: verified.id,
            empid: verified.empID,
            name: verified.name,
            email: verified.email,
            status: verified.is_active ? 'ACTIVE' : 'REVOKED',
        };

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

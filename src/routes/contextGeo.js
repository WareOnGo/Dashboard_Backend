const express = require('express');
const database = require('../utils/database');
const ContextGeoService = require('../services/contextGeoService');
const { configuration, authenticate, ContextGeoError } = require('../utils/contextGeoAuth');

/** Mounted before the browser JSON parser and sanitizer so signatures cover actual bytes. */
function createRouter({ service, env = process.env, now = Date.now } = {}) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try { configuration(env); next(); } catch (error) { next(error); }
    });
    router.post(['/', '/rollback'], express.raw({ type: 'application/json', limit: '32kb', inflate: false }), async (req, res, next) => {
        try {
            const auth = authenticate(req, env, now());
            let body;
            try { body = JSON.parse(req.body.toString('utf8')); }
            catch { throw new ContextGeoError(400, 'CONTEXT_GEO_INVALID_POINT'); }
            const action = req.path === '/rollback' ? 'rollback' : 'create';
            const result = await (service || new ContextGeoService(database.getClient(), { env, now }))[action](body, auth);
            res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
        } catch (error) { next(error); }
    });
    router.use((req, res) => res.status(405).json({ success: false, code: 'CONTEXT_GEO_METHOD_NOT_ALLOWED' }));
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error instanceof ContextGeoError ? error.status : error.type === 'entity.too.large' ? 413
            : ['encoding.unsupported', 'charset.unsupported'].includes(error.type) ? 415 : 503;
        const code = error instanceof ContextGeoError ? error.code : status === 413 ? 'CONTEXT_GEO_BODY_TOO_LARGE'
            : status === 415 ? 'CONTEXT_GEO_UNSUPPORTED_ENCODING' : 'CONTEXT_GEO_UNAVAILABLE';
        // Never log request bodies, JWTs, database error objects or employee details.
        if (status >= 500) console.error('Context Engine GIS request failed', { code });
        res.status(status).json({ success: false, code });
    });
    return router;
}

module.exports = createRouter;

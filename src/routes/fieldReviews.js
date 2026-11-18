const express = require('express');
const {
  z
} = require('zod');
const {
  authMiddleware
} = require('../middleware/authMiddleware');
const {
  CAPS
} = require('../utils/access');
const {
  schemas
} = require('../fieldReview/fields');
const {
  ReviewError
} = require('../fieldReview/service');
const WarehouseValidator = require('../validators/warehouseValidator');
const id = z.string().uuid();
const number = z.coerce.number().int().positive().max(2147483647);
const query = WarehouseValidator.warehouseQuerySchema.omit({
  page: true, limit: true, all: true, ids: true, sortBy: true, sortOrder: true
}).extend({
  view: z.enum(['current', 'previous', 'verify', 'employee', 'all']).default('current'),
  page: number.default(1),
  limit: number.max(100).default(12),
  assigneeId: number.optional()
});
function createRouter(service, auth = authMiddleware) {
  const router = express.Router();
  router.use(auth.authenticateJWT, auth.requireAccess(CAPS.WAREHOUSE_VIEW_OWN));
  const route = fn => async (req, res, next) => {
    try {
      res.json({
        success: true,
        data: await fn(req)
      });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FIELD_REVIEW',
          message: error.issues[0]?.message || 'Invalid request.'
        }
      });
      if (error instanceof ReviewError) return res.status(error.status).json({
        success: false,
        error: {
          code: error.code,
          message: error.message
        }
      });
      if (error.code === 'P2002') return res.status(409).json({
        success: false,
        error: {
          code: 'FIELD_REVIEW_CONFLICT',
          message: 'This review was already changed. Refresh before continuing.'
        }
      });
      if (['P2034', 'P2028'].includes(error.code)) return res.status(409).json({
        success: false,
        error: {
          code: 'FIELD_REVIEW_CONFLICT',
          message: 'Another change happened at the same time. Refresh and retry.'
        }
      });
      next(error);
    }
  };
  router.get('/setup/:warehouseId', auth.requireAccess(CAPS.REVIEW, { fresh: true }), route(r => service.setup(number.parse(r.params.warehouseId), r.user)));
  router.get('/summaries', route(r => {
    const ids = z.string().regex(/^\d+(,\d+)*$/).parse(r.query.ids).split(',').map(Number);
    if (ids.length > 100 || ids.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 2147483647)) throw new ReviewError(400, 'INVALID_IDS', 'Supply at most 100 valid warehouse IDs.');
    return service.summaries(ids, r.user);
  }));
  router.get('/', route(r => service.list(r.user, query.parse(r.query))));
  router.post('/', auth.requireAccess(CAPS.REVIEW), route(r => service.create(schemas.create.parse(r.body), r.user)));
  router.get('/:id/events', route(r => service.events(id.parse(r.params.id), r.user, r.query.cursor ? id.parse(r.query.cursor) : null)));
  router.get('/:id', route(r => service.detail(id.parse(r.params.id), r.user)));
  router.patch('/:id/assignee', auth.requireAccess(CAPS.REVIEW), route(r => service.reassign(id.parse(r.params.id), schemas.assign.parse(r.body), r.user)));
  router.get('/:id/flags/:flagId/history', route(r => service.history(id.parse(r.params.id), id.parse(r.params.flagId), r.user)));
  router.post('/:id/flags/:flagId/reveal', route(r => service.reveal(id.parse(r.params.id), id.parse(r.params.flagId), schemas.reveal.parse(r.body), r.user)));
  for (const [path, schema, method, reviewer] of [['response', 'response', 'respond', false], ['decision', 'decision', 'decide', true], ['return', 'return', 'returnForChanges', true], ['reopen', 'reopen', 'reopen', true]]) {
    router.post('/:id/flags/:flagId/' + path, ...(reviewer ? [auth.requireAccess(CAPS.REVIEW)] : []), route(r => service[method](id.parse(r.params.id), id.parse(r.params.flagId), schemas[schema].parse(r.body), r.user)));
  }
  return router;
}
module.exports = {
  createRouter
};

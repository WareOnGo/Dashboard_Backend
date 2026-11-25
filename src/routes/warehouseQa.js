const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { z } = require('zod');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');
const { QaError } = require('../warehouseQa/common');
const contracts = require('../warehouseQa/contracts');
const { ReviewError } = require('../fieldReview/service');

const runId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const warehouseId = z.coerce.number().int().positive().max(2147483647);
const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    stage: z
      .enum(['AI_REVIEW', 'ASSIGNED_LOCAL', 'ASSIGNED', 'STALE', 'DISMISSED', 'SUPERSEDED', 'all'])
      .default('AI_REVIEW'),
    search: z.string().trim().max(100).default('')
  })
  .strict();

function cronAuth(secretProvider) {
  return (req, res, next) => {
    const expected = secretProvider();
    const supplied = req.get('X-AI-QA-Token');
    const configured = typeof expected === 'string' && expected.length >= 32;
    const valid =
      configured &&
      typeof supplied === 'string' &&
      Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!valid)
      return res.status(401).json({
        success: false,
        error: { code: 'QA_CRON_UNAUTHORIZED', message: 'Invalid cron credentials.' }
      });
    next();
  };
}

function createRouter({
  getService,
  auth = authMiddleware,
  cronSecret = () => process.env.AI_QA_CRON_SECRET
}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const route =
    (fn, status = 200) =>
    async (req, res, next) => {
      try {
        res.status(status).json({ success: true, data: await fn(getService(), req) });
      } catch (error) {
        if (error instanceof z.ZodError)
          return res.status(400).json({
            success: false,
            error: {
              code: 'QA_INVALID_REQUEST',
              message: error.issues[0]?.message || 'Invalid QA request.'
            }
          });
        if (error instanceof QaError || error instanceof ReviewError)
          return res
            .status(error.status)
            .json({ success: false, error: { code: error.code, message: error.message } });
        // Do not send Prisma errors containing connection details or query values.
        if (error.code?.startsWith('P'))
          return res.status(503).json({
            success: false,
            error: {
              code: 'QA_STORAGE_UNAVAILABLE',
              message:
                'AI review storage is unavailable. Check the backend QA database configuration and migration.'
            }
          });
        next(error);
      }
    };
  // The service token can enqueue/process only. It never authorizes admin reads
  // or decisions, and dashboard JWTs alone cannot invoke this route.
  router.post(
    '/cron',
    cronAuth(cronSecret),
    route((service, req) => service.cron(contracts.cron.parse(req.body)))
  );
  router.post(
    '/cron/drain',
    cronAuth(cronSecret),
    route((service, req) => {
      z.object({}).strict().parse(req.body);
      return service.drain();
    })
  );
  router.get(
    '/cron/health',
    cronAuth(cronSecret),
    route((service) => service.health())
  );
  router.use(auth.authenticateJWT, auth.requireAccess(CAPS.ADMIN, { fresh: true }));
  router.get(
    '/health',
    route((service) => service.health())
  );
  router.get(
    '/config',
    route((service) => service.config())
  );
  router.get(
    '/summary',
    route((service) => service.summary())
  );
  router.get(
    '/runs',
    route((service) => service.runs())
  );
  router.post(
    '/runs',
    route((service, req) => service.create(contracts.run.parse(req.body), req.user), 202)
  );
  router.get(
    '/runs/:id/status',
    route((service, req) => service.status(runId.parse(req.params.id)))
  );
  router.post(
    '/runs/:id/process',
    route((service, req) => {
      z.object({}).strict().parse(req.body);
      return service.processRun(runId.parse(req.params.id));
    })
  );
  router.get(
    '/runs/:id/warehouses',
    route((service, req) => service.list(runId.parse(req.params.id), listQuery.parse(req.query)))
  );
  router.get(
    '/runs/:id/export',
    route((service, req) => service.export(runId.parse(req.params.id)))
  );
  router.get(
    '/runs/:id/warehouses/:whid',
    route((service, req) =>
      service.detail(runId.parse(req.params.id), warehouseId.parse(req.params.whid), req.user)
    )
  );
  for (const [operation, contract] of Object.entries(contracts.mutations)) {
    router.post(
      '/runs/:id/warehouses/:whid/' + operation,
      route((service, req) =>
        service.mutate(
          runId.parse(req.params.id),
          warehouseId.parse(req.params.whid),
          operation,
          contract.parse(req.body),
          req.user
        )
      )
    );
  }
  return router;
}
module.exports = { createRouter, cronAuth };

// Opt-in real-backend browser fixture. Every warehouse, user and write lives in
// a disposable schema guarded by testDatabaseUrl. Never reads the live .env.
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');
require('dotenv').config = () => ({ parsed: {} });
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/warehouse_qa';
const { PrismaClient } = require('@prisma/client');
const { createSchema } = require('./fieldReviewDatabase');
const { migrate: migrateReviews } = require('../../scripts/migrateFieldReview');
const { migrate: migrateQa } = require('../../scripts/migrateWarehouseQa');
const { FieldReviewService } = require('../../src/fieldReview/service');
const { QaRepository } = require('../../src/warehouseQa/repository');
const { QaSource } = require('../../src/warehouseQa/source');
const { QaService } = require('../../src/warehouseQa/service');
const { QaWorker } = require('../../src/warehouseQa/worker');
const { result } = require('../fixtures/warehouseQa');
const { completePptForm } = require('../fixtures/pptForm');
const jwt = require('jsonwebtoken');
const express = require('express');
const base = require('./testDatabaseUrl')(process.env.TEST_DATABASE_URL);
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const root = new PrismaClient({ datasourceUrl: base, log: [] });
const db = new PrismaClient({ datasourceUrl: base + '?schema=' + schema, log: [] });
let created = false, server, worker;
async function cleanup() {
  if (server) await new Promise(resolve => server.close(resolve));
  if (worker) await worker.stop();
  await db.$disconnect();
  if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await root.$disconnect();
}
async function main() {
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  await createSchema(db);
  await migrateReviews(db, true);
  await migrateQa(db, true);
  await db.verifiedNumber.createMany({ data: [
    { id: 1, name: 'QA test admin', email: 'qa-test-admin@wareongo.com', phone_number: 'fixture-admin', is_active: true, adminAccess: true },
    { id: 2, name: 'QA test employee', email: 'qa-test-employee@wareongo.com', phone_number: 'fixture-employee', is_active: true,
      dashboardAccess: true, viewOwnWarehouseEntries: true, viewAllWarehouseEntries: true }
  ] });
  const { warehouseData, ...form } = completePptForm();
  for (const id of [4821, 4822]) await db.warehouse.create({ data: {
    ...form, id, uploadedBy: 'QA test employee', zone: 'North', handoverDate: new Date(form.handoverDate),
    builtup_area: '10000 sq ft', carpet_area: '9000 sq ft',
    WarehouseData: { create: { ...warehouseData, powerKva: '5' } }
  } });
  const repository = new QaRepository(db);
  const source = new QaSource({ repository, sourceDb: () => db, mode: 'warehouse' });
  const fieldReviews = new FieldReviewService(db);
  const service = new QaService({ repository, source, worker: { drain: async () => {} }, fieldReviews, handoffMode: 'field-review' });
  const run = await service.create({ request_id: randomUUID(), warehouse_ids: [4821, 4822], mode: 'BACKFILL', model: 'gpt-6.2-sol' },
    { id: 1, email: 'qa-test-admin@wareongo.com', name: 'QA test admin' });
  for (let index = 0; index < 2; index++) {
    const item = await repository.claim();
    await repository.finish(item, { result: result(item.snapshot) });
  }
  // Saved QA evidence deliberately survives deletion; its neighbor stays usable.
  await db.warehouse.delete({ where: { id: 4822 } });
  worker = new QaWorker({ repository, inference: {
    evaluate: async snapshot => ({ result: result(snapshot) })
  } });
  // No timer or cron: the admin UI must drive subsequent manual batches.
  service.worker = worker;
  const auth = {
    authenticateJWT: (req, res, next) => {
      try { req.user = jwt.verify(req.get('Authorization')?.slice(7), 'disposable-browser-fixture', { issuer: 'warehouse-api', audience: 'warehouse-frontend' }); next(); }
      catch { res.sendStatus(401); }
    },
    requireAccess: capability => (req, res, next) =>
      req.user.isAdmin || req.user.capabilities?.[capability] ? next() : res.sendStatus(403)
  };
  const app = express();
  app.use(require('cors')({ origin: true }));
  app.use(express.json());
  app.use('/api/ai-qa', require('../../src/routes/warehouseQa').createRouter({ getService: () => service, auth }));
  app.use('/api/field-reviews', require('../../src/routes/fieldReviews').createRouter(fieldReviews, auth));
  app.get('/api/auth/me', auth.authenticateJWT, (req, res) => res.json({ success: true, user: req.user }));
  app.get('/api/warehouses', auth.authenticateJWT, async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Number.isInteger);
    const rows = await db.warehouse.findMany({ where: { id: { in: ids } }, include: { WarehouseData: true } });
    res.json({ success: true, data: rows });
  });
  app.get('/api/auth/health', (_req, res) => res.json({ success: true, data: { healthy: true } }));
  app.use((_req, res) => res.status(404).json({ success: false, error: 'Unknown fixture endpoint' }));
  app.use((error, _req, res, _next) => { console.error('Fixture error', { name: error.name, code: error.code }); res.status(500).json({ success: false, error: 'Fixture failed' }); });
  server = app.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], JSON.stringify({ port: server.address().port, run_id: run.id, schema }), { mode: 0o600 }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => cleanup().then(() => process.exit(0)));
}
main().catch(async error => { console.error('Fixture failed', { name: error.name, code: error.code }); await cleanup(); process.exitCode = 1; });

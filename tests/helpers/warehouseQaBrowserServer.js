// Opt-in browser/real-model smoke fixture. It uses the production QA router,
// service, queue and PostgreSQL repository, with a disposable local schema.
// This helper is excluded from deployment images and never loads live DB env.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('./testDatabaseUrl');
const { migrate } = require('../../scripts/migrateWarehouseQa');
const { importPilot } = require('../../scripts/importWarehouseQaPilot');
const { QaRepository } = require('../../src/warehouseQa/repository');
const { QaSource } = require('../../src/warehouseQa/source');
const { QaInference } = require('../../src/warehouseQa/inference');
const { QaWorker } = require('../../src/warehouseQa/worker');
const { QaService } = require('../../src/warehouseQa/service');
const express = require('express');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
// A few legacy auth modules call config() at import time. Block that behavior
// in this fixture; only the explicitly opted-in API key is read below.
dotenv.config = () => ({ parsed: {} });
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/warehouse_qa';

async function start() {
  const url = testDatabaseUrl(process.env.TEST_DATABASE_URL);
  const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
  const admin = new PrismaClient({ datasourceUrl: url, log: [] });
  const db = new PrismaClient({ datasourceUrl: url + '?schema=' + schema, log: [] });
  let created = false;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    await migrate(db, true);
    await importPilot(db, JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), true);
  } catch (error) {
    await db.$disconnect();
    if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
    throw error;
  }
  let apiKey = '';
  if (process.env.QA_SMOKE_REAL_OPENAI === 'true') {
    apiKey = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../../.env'))).OPENAI_API_KEY;
  }
  // Authentication fixtures cannot be mistaken for production JWT credentials.
  process.env.JWT_SECRET = 'disposable-browser-fixture';
  process.env.ALLOWED_DOMAIN = 'wareongo.com';
  const repository = new QaRepository(db);
  const source = new QaSource({
    repository,
    mode: 'pilot',
    sourceDb: () => {
      throw new Error('Live source access is disabled in this fixture.');
    }
  });
  const worker = new QaWorker({
    repository,
    inference: new QaInference({ repository, apiKey: () => apiKey })
  });
  const service = new QaService({ repository, source, worker, pilotAssignees: [{ id: 1, name: "Sandbox assignee A" }, { id: 2, name: "Sandbox assignee B" }] });
  const auth = {
    authenticateJWT: (req, res, next) => {
      try {
        req.user = jwt.verify(req.get('Authorization')?.slice(7), process.env.JWT_SECRET, {
          issuer: 'warehouse-api',
          audience: 'warehouse-frontend'
        });
        next();
      } catch {
        res.sendStatus(401);
      }
    },
    requireAccess: () => (req, res, next) => (req.user.isAdmin === true ? next() : res.sendStatus(403))
  };
  const app = express();
  app.use(require('cors')({ origin: true }));
  app.use(express.json());
  app.use(
    '/api/ai-qa',
    require('../../src/routes/warehouseQa').createRouter({
      getService: () => service,
      auth,
      cronSecret: () => 'disposable-browser-cron-secret-at-least-32-characters'
    })
  );
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Fixture request failed.' }));
  const server = app.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(
      process.argv[3],
      JSON.stringify({ port: server.address().port, schema, localOnly: true }),
      { mode: 0o600 }
    );
  });
  async function stop() {
    server.close();
    await worker.stop();
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
    process.exit(0);
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
start().catch((error) => {
  console.error('QA fixture failed', { name: error.name, code: error.code });
  process.exitCode = 1;
});

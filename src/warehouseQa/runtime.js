const { PrismaClient } = require('@prisma/client');
const database = require('../utils/database');
const { QaRepository } = require('./repository');
const { QaSource } = require('./source');
const { QaInference } = require('./inference');
const { QaWorker } = require('./worker');
const { QaService } = require('./service');
const { fail } = require('./common');
const { handoffMode } = require('./configuration');

let runtime;
function getService({ fieldReviews = null } = {}) {
  if (process.env.AI_QA_ENABLED !== 'true')
    fail(503, 'QA_DISABLED', 'AI flags have not been enabled in this backend.');
  if (runtime) return runtime.service;
  const sourceMode = process.env.AI_QA_SOURCE || 'pilot';
  if (!['pilot', 'warehouse'].includes(sourceMode))
    fail(503, 'QA_CONFIGURATION', 'AI_QA_SOURCE must be pilot or warehouse.');
  // Require an explicit destination, even when it is the main application's DB.
  // This prevents a local pilot from silently persisting in production.
  if (!process.env.AI_QA_DATABASE_URL)
    fail(503, 'QA_CONFIGURATION', 'The QA database has not been configured.');
  let qaUrl;
  try {
    qaUrl = new URL(process.env.AI_QA_DATABASE_URL);
  } catch {
    fail(503, 'QA_CONFIGURATION', 'The QA database configuration is invalid.');
  }
  if (!['postgresql:', 'postgres:'].includes(qaUrl.protocol))
    fail(503, 'QA_CONFIGURATION', 'QA storage must use PostgreSQL.');
  const localStorage = ['127.0.0.1', 'localhost', '[::1]'].includes(qaUrl.hostname);
  if (sourceMode === 'pilot' && !localStorage)
    fail(503, 'QA_CONFIGURATION', 'Pilot mode requires a local QA database.');
  if (localStorage && ['host', 'hostaddr', 'options'].some((key) => qaUrl.searchParams.has(key)))
    fail(503, 'QA_CONFIGURATION', 'Local QA storage cannot override its database host.');
  const mode = handoffMode(process.env);
  if (sourceMode === 'warehouse' && !fieldReviews)
    fail(503, 'QA_CONFIGURATION', 'The field-review service must be supplied by the backend container.');
  const sharedDatabase = mode === 'field-review';
  const maxConcurrency = Number(process.env.AI_QA_MAX_CONCURRENCY || 2);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20)
    fail(503, 'QA_CONFIGURATION', 'AI_QA_MAX_CONCURRENCY must be an integer from 1 to 20.');
  const db = sharedDatabase
    ? fieldReviews.db
    : new PrismaClient({ datasourceUrl: process.env.AI_QA_DATABASE_URL, log: [] });
  const repository = new QaRepository(db, { maxConcurrency });
  const source = new QaSource({ repository, sourceDb: () => database.getClient(), mode: sourceMode });
  const inference = new QaInference({ repository, apiKey: () => process.env.OPENAI_API_KEY });
  const runBy = process.env.AI_QA_RUN_BY || 'Raghav';
  const worker = new QaWorker({ repository, inference, runBy });
  const service = new QaService({
    repository,
    source,
    worker,
    runBy,
    localStorage,
    fieldReviews,
    handoffMode: mode,
    forwardStart: process.env.AI_QA_FORWARD_START_AT
  });
  runtime = { db, service, worker, sharedDatabase };
  return service;
}

function start(resolveService = getService) {
  if (process.env.AI_QA_ENABLED !== 'true') return;
  try {
    resolveService();
    runtime.worker.start();
  } catch {
    // An optional QA configuration error must not take down warehouse CRUD.
    console.error('Warehouse QA is unavailable; check its backend configuration.');
  }
}
async function stopWorkers() {
  if (!runtime) return;
  await runtime.worker.stop();
}
async function stop() {
  if (!runtime) return;
  await stopWorkers();
  if (!runtime.sharedDatabase) await runtime.db.$disconnect();
  runtime = undefined;
}
module.exports = { getService, start, stopWorkers, stop };

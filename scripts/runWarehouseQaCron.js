// Operational HTTP client for the native QA API. Does not access either database.
// Invoke under flock (see deploy/warehouse-qa-cron.service) so the checkpoint has
// exactly one writer. Interrupted invocations resume their saved request ID.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const stateSchema = z
  .object({
    version: z.literal(1),
    api_url: z.string().url(),
    phase: z.enum(['idle', 'scan', 'drain']),
    request: z
      .object({
        request_id: z.uuid(),
        limit: z.literal(100),
        since: z.iso.datetime({ offset: true }).optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine((state) => state.phase !== 'scan' || !!state.request);
const failure = (code) => Object.assign(new Error(code), { code });

async function drive({
  apiUrl,
  since,
  readState,
  saveState,
  request,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxMs = 3300000
}) {
  let state = await readState();
  if (state) {
    state = stateSchema.parse(state);
    if (state.api_url !== apiUrl) throw failure('QA_CRON_STATE_TARGET_CHANGED');
  }
  if (!state || state.phase === 'idle') {
    state = {
      version: 1,
      api_url: apiUrl,
      phase: 'scan',
      request: { request_id: randomUUID(), limit: 100, ...(since ? { since } : {}) }
    };
    stateSchema.parse(state);
    await saveState(state);
  }
  const deadline = now() + maxMs;
  const invoke = async (endpoint, body) => {
    while (now() < deadline) {
      try {
        return await request(endpoint, body);
      } catch (error) {
        if (error.permanent) throw error;
        await sleep(10000);
      }
    }
    throw failure('QA_CRON_DEADLINE');
  };
  const preflight = await invoke('/cron/health');
  if (!preflight.model_configured || preflight.worker_stopping) throw failure('QA_CRON_NOT_CONFIGURED');
  while (now() < deadline) {
    if (state.phase === 'scan') {
      const page = await invoke('/cron', state.request);
      if (typeof page.has_more !== 'boolean') throw failure('QA_CRON_INVALID_PAGE_RESPONSE');
      state = page.has_more
        ? { ...state, request: { request_id: randomUUID(), limit: 100 } }
        : { version: 1, api_url: apiUrl, phase: 'drain' };
      await saveState(state);
    } else {
      const health = await invoke('/cron/drain', {});
      if (!health.queue || !Number.isInteger(health.queue.queued) || !Number.isInteger(health.queue.running))
        throw failure('QA_CRON_INVALID_HEALTH_RESPONSE');
      if (health.queue.queued === 0 && health.queue.running === 0) {
        await saveState({ version: 1, api_url: apiUrl, phase: 'idle' });
        return health;
      }
      // Backoff lets delayed retries become eligible without busy polling.
      await sleep(10000);
    }
  }
  throw failure('QA_CRON_DEADLINE');
}

async function main(env = process.env) {
  const url = new URL(env.AI_QA_API_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw failure('QA_CRON_INVALID_URL');
  const apiUrl = url.toString().replace(/\/$/, '');
  if (
    !env.AI_QA_CRON_SECRET ||
    env.AI_QA_CRON_SECRET.length < 32 ||
    !env.AI_QA_CRON_STATE_FILE ||
    !path.isAbsolute(env.AI_QA_CRON_STATE_FILE)
  )
    throw failure('QA_CRON_MISSING_CONFIGURATION');
  const filename = env.AI_QA_CRON_STATE_FILE;
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const health = await drive({
    apiUrl,
    since: env.AI_QA_FORWARD_START_AT,
    readState: async () => {
      try {
        return JSON.parse(await fs.readFile(filename, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    saveState: async (state) => {
      const temporary = filename + '.' + randomUUID() + '.tmp';
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(state) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, filename);
      const directory = await fs.open(path.dirname(filename), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    request: async (endpoint, body) => {
      let response;
      try {
        response = await fetch(apiUrl + endpoint, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(105000),
          headers: { 'X-AI-QA-Token': env.AI_QA_CRON_SECRET, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch {
        throw failure('QA_CRON_TRANSPORT');
      }
      if (!response.ok)
        throw Object.assign(failure('QA_CRON_HTTP_' + response.status), {
          permanent: response.status >= 400 && response.status < 500 && response.status !== 429
        });
      const responseBody = await response.json();
      if (!responseBody.success || !responseBody.data) throw failure('QA_CRON_INVALID_RESPONSE');
      return responseBody.data;
    }
  });
  process.stdout.write(JSON.stringify({ ready: health.ready, queue: health.queue }) + '\n');
  if (!health.ready) process.exitCode = 2;
}
module.exports = { drive, main };
if (require.main === module)
  main().catch((error) => {
    // Do not print headers, URLs, connection strings or remote response bodies.
    console.error('Warehouse QA cron failed', {
      code: /^QA_CRON_[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'QA_CRON_CONFIGURATION_OR_STATE'
    });
    process.exitCode = 1;
  });

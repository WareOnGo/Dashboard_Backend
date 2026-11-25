const { drive } = require('../../scripts/runWarehouseQaCron');
const apiUrl = 'https://qa.example.invalid/api/ai-qa';
const healthy = {
  ready: true,
  model_configured: true,
  worker_stopping: false,
  queue: { queued: 0, running: 0, failed: 0 }
};
const setup = () => {
  let state = null,
    clock = 0;
  return {
    apiUrl,
    readState: async () => state,
    saveState: async (value) => {
      state = structuredClone(value);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    maxMs: 100000
  };
};
test('lost responses reuse the page ID, continuation creates a new ID, and draining is explicit', async () => {
  const options = setup();
  const pages = [];
  let drains = 0;
  const request = jest.fn(async (endpoint, body) => {
    if (endpoint === '/cron/health') return healthy;
    if (endpoint === '/cron') {
      expect((await options.readState()).request).toEqual(body); // durable before network I/O
      pages.push(structuredClone(body));
      if (pages.length === 1) throw new Error('Response lost');
      return { has_more: pages.length === 2 };
    }
    drains++;
    return drains === 1 ? { ...healthy, queue: { queued: 1, running: 1 } } : healthy;
  });
  expect(await drive({ ...options, request })).toEqual(healthy);
  expect(pages).toHaveLength(3);
  expect(pages[0].request_id).toBe(pages[1].request_id);
  expect(pages[2].request_id).not.toBe(pages[1].request_id);
  expect(drains).toBe(2);
  expect((await options.readState()).phase).toBe('idle');
});
test('process interruption resumes the checkpoint instead of enqueuing a different invocation', async () => {
  const options = setup();
  const interrupted = Object.assign(new Error('Interrupted'), { permanent: true });
  await expect(
    drive({
      ...options,
      request: async (endpoint) => {
        if (endpoint === '/cron/health') return healthy;
        throw interrupted;
      }
    })
  ).rejects.toBe(interrupted);
  const pending = structuredClone(await options.readState());
  const request = jest.fn(async (endpoint) => (endpoint === '/cron' ? { has_more: false } : healthy));
  await drive({ ...options, request });
  expect(request).toHaveBeenCalledWith('/cron', pending.request);
});
test('exhausted evaluations report degraded health but do not prevent the next hourly scan', async () => {
  const options = setup();
  const failed = { ...healthy, ready: false, queue: { queued: 0, running: 0, failed: 1 } };
  const request = async (endpoint) => (endpoint === '/cron' ? { has_more: false } : failed);
  expect((await drive({ ...options, request })).ready).toBe(false);
  expect((await options.readState()).phase).toBe('idle');
});
test('a deadline preserves the pending request and a changed API destination fails closed', async () => {
  const options = setup();
  await expect(
    drive({
      ...options,
      maxMs: 1,
      request: async () => {
        throw new Error('Offline');
      }
    })
  ).rejects.toMatchObject({ code: 'QA_CRON_DEADLINE' });
  expect((await options.readState()).phase).toBe('scan');
  await expect(
    drive({ ...options, apiUrl: 'https://other.example.invalid/api/ai-qa', request: jest.fn() })
  ).rejects.toMatchObject({ code: 'QA_CRON_STATE_TARGET_CHANGED' });
});

const LookupCache = require('../../src/utils/lookupCache');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let cache;
beforeEach(() => { jest.useFakeTimers(); cache = new LookupCache(1000); });
afterEach(() => jest.useRealTimers());

test('a cold concurrent burst shares one lookup and one completed value', async () => {
  const db = deferred();
  const lookup = jest.fn(() => db.promise);
  const pending = Array.from({ length: 100 }, () => cache.get('user', lookup));
  await Promise.resolve();
  expect(lookup).toHaveBeenCalledTimes(1);
  db.resolve({ allowed: true });
  const results = await Promise.all(pending);
  expect(results).toEqual(Array(100).fill({ allowed: true }));
  expect(await cache.get('user', lookup)).toEqual({ allowed: true });
  expect(lookup).toHaveBeenCalledTimes(1);
});
test('TTL starts at lookup completion and expires at the boundary', async () => {
  const db = deferred();
  const lookup = jest.fn().mockReturnValueOnce(db.promise).mockResolvedValue('new');
  const pending = cache.get('user', lookup);
  jest.advanceTimersByTime(5000);
  db.resolve('old');
  await pending;
  jest.advanceTimersByTime(999);
  expect(await cache.get('user', lookup)).toBe('old');
  jest.advanceTimersByTime(1);
  expect(await cache.get('user', lookup)).toBe('new');
  expect(lookup).toHaveBeenCalledTimes(2);
});
test('a failed burst rejects all callers and the next lookup retries', async () => {
  const db = deferred();
  const lookup = jest.fn().mockReturnValueOnce(db.promise).mockResolvedValue('recovered');
  const results = Promise.allSettled(Array.from({ length: 30 }, () => cache.get('user', lookup)));
  db.reject(new Error('outage'));
  expect((await results).every(r => r.status === 'rejected' && r.reason.message === 'outage')).toBe(true);
  expect(await cache.get('user', lookup)).toBe('recovered');
  expect(lookup).toHaveBeenCalledTimes(2);
});
test.each(['key', 'all'])('%s invalidation during a lookup prevents stale grants, including waiting callers', async mode => {
  const db = deferred();
  const lookup = jest.fn().mockReturnValueOnce(db.promise).mockResolvedValue(false);
  const pending = Array.from({ length: 30 }, () => cache.get('user', lookup));
  await Promise.resolve();
  cache.clear(mode === 'key' ? 'user' : undefined);
  db.resolve(true);
  expect(await Promise.all(pending)).toEqual(Array(30).fill(false));
  expect(await cache.get('user', lookup)).toBe(false);
  expect(lookup).toHaveBeenCalledTimes(2);
});
test('finishing an invalidated lookup does not delete the replacement lookup', async () => {
  const old = deferred(), fresh = deferred();
  const lookup = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = cache.get('user', lookup);
  await Promise.resolve();
  cache.clear('user');
  const second = cache.get('user', lookup);
  await Promise.resolve();
  old.resolve('stale');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const third = cache.get('user', lookup);
  fresh.resolve('current');
  expect(await Promise.all([first, second, third])).toEqual(['current', 'current', 'current']);
  expect(lookup).toHaveBeenCalledTimes(2);
});
test('keys are independent and per-key invalidation preserves other entries', async () => {
  const lookup = jest.fn().mockResolvedValue('value');
  await Promise.all(['a', 'b'].map(key => cache.get(key, lookup)));
  cache.clear('a');
  await cache.get('b', lookup);
  expect(lookup).toHaveBeenCalledTimes(2);
  await cache.get('a', lookup);
  expect(lookup).toHaveBeenCalledTimes(3);
  cache.clear();
  await cache.get('b', lookup);
  expect(lookup).toHaveBeenCalledTimes(4);
});
test('uncacheable values are shared in flight but retried on a later request', async () => {
  cache = new LookupCache(1000, Boolean);
  const lookup = jest.fn().mockResolvedValueOnce(null).mockResolvedValue('granted');
  expect(await Promise.all([cache.get('user', lookup), cache.get('user', lookup)])).toEqual([null, null]);
  expect(await cache.get('user', lookup)).toBe('granted');
  expect(lookup).toHaveBeenCalledTimes(2);
});

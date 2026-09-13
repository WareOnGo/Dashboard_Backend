// This is intentionally narrow: no fallback to DATABASE_URL, no production hosts,
// no query parameters that could override the target or load external services.
function testDatabaseUrl(value, { allowSchema = false } = {}) {
  const fail = () => { throw new Error('Integration tests require TEST_DATABASE_URL for warehouse_test:warehouse_test on 127.0.0.1:<port>/warehouse_qa'); };
  let url;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1'
    || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
    || url.username !== 'warehouse_test' || url.password !== 'warehouse_test'
    || url.pathname !== '/warehouse_qa' || url.hash) return fail();
  for (const [key, value] of url.searchParams) {
    if (!allowSchema || key !== 'schema' || !/^behavior_qa_[a-f0-9]{16}$/.test(value)) return fail();
  }
  if (url.searchParams.getAll('schema').length > 1) return fail();
  return url.toString();
}
module.exports = testDatabaseUrl;

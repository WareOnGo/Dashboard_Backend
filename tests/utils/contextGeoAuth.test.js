const { generateKeyPairSync } = require('node:crypto');
const { fixture } = require('../fixtures/contextGeo');
const { authenticate, configuration, revalidate } = require('../../src/utils/contextGeoAuth');

test('valid dedicated signature binds exact request bytes and employee identity', () => {
    const f = fixture();
    expect(authenticate(f.request(), f.env, f.now).claims).toMatchObject({ sub: '7', email: 'synthetic@wareongo.com', scopes: ['geo:points:create'] });
});
test.each([
    ['wrong method', req => { req.method = 'PUT'; }],
    ['query suffix', req => { req.originalUrl += '?debug=true'; }],
    ['browser origin', req => { req.headers.origin = 'https://dashboard.invalid'; }],
    ['compressed body', req => { req.headers['content-encoding'] = 'gzip'; }],
    ['wrong content type', req => { req.headers['content-type'] = 'text/plain'; }],
    ['missing token', req => { delete req.headers.authorization; }],
    ['browser token scheme', req => { req.headers.authorization = req.headers.authorization.replace('ContextEngine ', 'Bearer '); }],
    ['Ramesh token scheme', req => { req.headers.authorization = req.headers.authorization.replace('ContextEngine ', 'Ramesh '); }],
    ['tampered text', req => { req.body = Buffer.from(req.body.toString().replace('scouting', 'tampered')); }],
    ['parsed instead of raw body', req => { req.body = JSON.parse(req.body); }],
    ['oversized body', req => { req.body = Buffer.alloc(32769); }],
])('rejects %s before reaching storage', (_name, modify) => {
    const f = fixture(), req = f.request(); modify(req);
    expect(() => authenticate(req, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
});
test.each([
    ['other audience', { aud: 'https://context.invalid/mcp/ramesh' }],
    ['other URL', { htu: 'https://other.invalid/path' }],
    ['read scope', { scopes: ['warehouses:read'] }],
    ['caller-specific phone', { phone: '+919800000001' }],
    ['invalid employee', { sub: '2147483648' }],
    ['invalid email', { email: 'not-an-email' }],
    ['unnormalized email', { email: 'Synthetic@wareongo.com' }],
    ['long token life', { exp: Math.floor(Date.now() / 1000) + 120 }],
    ['expired token', { iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }],
    ['future token', { iat: Math.floor(Date.now() / 1000) + 20 }],
    ['unknown claim', { admin: true }],
])('rejects %s claims', (_name, claims) => {
    const f = fixture();
    expect(() => authenticate(f.request(f.point, { claims }), f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
});
test.each([
    { typ: 'ramesh-request+jwt' }, { alg: 'HS256' }, { kid: 'unknown-key' }, { jku: 'https://attacker.invalid/key' },
])('rejects unsupported headers %j', header => {
    const f = fixture();
    expect(() => authenticate(f.request(f.point, { header }), f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
});
test('rejects attacker signature, malformed token, disabled and malformed configuration', () => {
    const f = fixture(), other = generateKeyPairSync('ed25519');
    expect(() => authenticate(f.request(f.point, { privateKey: other.privateKey }), f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    const req = f.request(); req.headers.authorization = 'ContextEngine e30.e30.AAAA';
    expect(() => authenticate(req, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    expect(() => configuration({})).toThrow('CONTEXT_GEO_DISABLED');
    expect(() => configuration({ ...f.env, WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON: '[bad' })).toThrow('CONTEXT_GEO_CONFIGURATION');
    expect(() => configuration({ ...f.env, WAG_CONTEXT_GEO_URL: f.url.replace('https:', 'http:') })).toThrow('CONTEXT_GEO_CONFIGURATION');
});
test('key expiry, removal and configuration changes revoke an already verified request', () => {
    const f = fixture(), auth = f.auth();
    expect(() => revalidate(auth, f.env, f.now)).not.toThrow();
    expect(() => revalidate(auth, f.env, f.now + 61000)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    f.env.WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON = JSON.stringify([{ ...f.key, kid: 'rotated' }]);
    expect(() => revalidate(auth, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    f.env.WAG_CONTEXT_GEO_ENABLED = 'false';
    expect(() => revalidate(auth, f.env, f.now)).toThrow('CONTEXT_GEO_DISABLED');
});
test('rollback authority is explicit, action-bound and revocable independently', () => {
    const f = fixture(), body = { operationId: f.point.operationId, originalOperationId: '22222222-2222-4222-8222-222222222222' };
    const req = f.request(body, { rollback: true });
    expect(() => authenticate(req, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    f.key.scopes.push('geo:points:rollback'); f.env.WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON = JSON.stringify([f.key]);
    const auth = authenticate(req, f.env, f.now);
    expect(auth.claims.scopes).toEqual(['geo:points:rollback']);
    expect(() => revalidate(auth, f.env, f.now)).not.toThrow();
    req.originalUrl = '/api/integrations/context-engine/geo/points';
    expect(() => authenticate(req, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
    f.key.scopes = ['geo:points:create']; f.env.WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON = JSON.stringify([f.key]);
    expect(() => revalidate(auth, f.env, f.now)).toThrow('CONTEXT_GEO_UNAUTHORIZED');
});

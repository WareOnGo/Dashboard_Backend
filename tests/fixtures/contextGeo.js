const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const { PATH, ISSUER, TYPE, SCOPE, digest, authenticate } = require('../../src/utils/contextGeoAuth');

function fixture() {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    const url = `https://dashboard.invalid${PATH}`;
    const key = { kid: 'synthetic-key', publicKey: pair.publicKey.export({ format: 'jwk' }),
        scopes: [SCOPE], expiresAt: new Date(now + 86400000).toISOString() };
    const env = { WAG_CONTEXT_GEO_ENABLED: 'true', WAG_CONTEXT_GEO_URL: url,
        WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON: JSON.stringify([key]) };
    const point = { operationId: randomUUID(), name: 'Synthetic scouting site', category: 'POTENTIAL_WAREHOUSE',
        lat: 12.9, lng: 77.6, notes: 'Synthetic access notes', city: 'Synthetic city' };
    function request(body = point, { claims: override = {}, header = {}, privateKey = pair.privateKey, serialized } = {}) {
        const raw = serialized ?? JSON.stringify(body);
        const payload = { iss: ISSUER, aud: url, sub: '7', email: 'synthetic@wareongo.com', htm: 'POST', htu: url,
            body_sha256: digest(raw), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, jti: randomUUID(), scopes: [SCOPE], ...override };
        const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: TYPE, kid: key.kid, ...header })).toString('base64url');
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const token = `${head}.${encoded}.${sign(null, Buffer.from(`${head}.${encoded}`), privateKey).toString('base64url')}`;
        return { method: 'POST', originalUrl: PATH, headers: { authorization: `ContextEngine ${token}`, 'content-type': 'application/json' }, body: Buffer.from(raw) };
    }
    const auth = (body = point, options) => authenticate(request(body, options), env, now);
    return { pair, now, url, key, env, point, request, auth };
}
module.exports = { fixture };

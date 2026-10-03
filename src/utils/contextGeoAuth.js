const { createHash, createPublicKey, verify } = require('node:crypto');
const { z } = require('zod');

const PATH = '/api/integrations/context-engine/geo/points';
const ISSUER = 'wareongo:context-engine';
const TYPE = 'context-geo-write+jwt';
const SCOPE = 'geo:points:create';
const digest = value => createHash('sha256').update(value).digest('base64url');
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/);
const scopes = z.tuple([z.literal(SCOPE)]);
const registration = z.object({
    kid: identifier,
    publicKey: z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
    scopes, expiresAt: z.string().datetime(),
}).strict();
const registry = z.array(registration).min(1).max(3).refine(keys => new Set(keys.map(key => key.kid)).size === keys.length);
const claimsSchema = z.object({
    iss: z.literal(ISSUER), aud: z.string(), sub: z.string().regex(/^[1-9]\d{0,9}$/),
    email: z.email().max(254).refine(value => value === value.trim().toLowerCase()),
    htm: z.literal('POST'), htu: z.string(), body_sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    iat: z.number().int().positive(), exp: z.number().int().positive(), jti: z.string().uuid(), scopes,
}).strict();

class ContextGeoError extends Error {
    constructor(status, code) { super(code); this.name = 'ContextGeoError'; this.status = status; this.code = code; }
}
const denied = () => new ContextGeoError(401, 'CONTEXT_GEO_UNAUTHORIZED');

function configuration(env = process.env) {
    if (env.WAG_CONTEXT_GEO_ENABLED !== 'true') throw new ContextGeoError(503, 'CONTEXT_GEO_DISABLED');
    try {
        const endpoint = new URL(env.WAG_CONTEXT_GEO_URL);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
            || endpoint.pathname !== PATH || endpoint.toString() !== env.WAG_CONTEXT_GEO_URL) throw new Error();
        return { endpoint: endpoint.toString(), keys: registry.parse(JSON.parse(env.WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON || '')) };
    } catch { throw new ContextGeoError(503, 'CONTEXT_GEO_CONFIGURATION'); }
}
function decode(value) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw denied();
    return JSON.parse(bytes.toString('utf8'));
}

/** Verifies original request bytes; an MCP read assertion cannot authorize this endpoint. */
function authenticate(req, env = process.env, now = Date.now()) {
    const config = configuration(env);
    if (req.method !== 'POST' || req.originalUrl !== PATH || req.headers.origin !== undefined
        || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
        || req.headers['content-encoding'] !== undefined || !Buffer.isBuffer(req.body) || req.body.length > 32768) throw denied();
    const token = /^ContextEngine ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token || token.length > 4096) throw denied();
    try {
        const [head, payload, signature] = token.split('.');
        const header = z.object({ alg: z.literal('EdDSA'), typ: z.literal(TYPE), kid: identifier }).strict().parse(decode(head));
        const key = config.keys.find(item => item.kid === header.kid);
        if (!key || Date.parse(key.expiresAt) <= now) throw denied();
        const bytes = Buffer.from(signature, 'base64url');
        if (bytes.length !== 64 || bytes.toString('base64url') !== signature
            || !verify(null, Buffer.from(`${head}.${payload}`), createPublicKey({ key: key.publicKey, format: 'jwk' }), bytes)) throw denied();
        const claims = claimsSchema.parse(decode(payload));
        const seconds = Math.floor(now / 1000);
        if (Number(claims.sub) > 2147483647 || claims.aud !== config.endpoint || claims.htu !== config.endpoint
            || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 60
            || claims.iat > seconds + 5 || claims.iat < seconds - 60 || claims.body_sha256 !== digest(req.body)) throw denied();
        return { claims, kid: key.kid, keyFingerprint: digest(JSON.stringify(key)), endpoint: config.endpoint };
    } catch { throw denied(); }
}

/** Recheck a rotated/disabled key and expiry after waiting for the write transaction. */
function revalidate(auth, env = process.env, now = Date.now()) {
    const config = configuration(env);
    const key = config.keys.find(item => item.kid === auth.kid);
    if (!key || config.endpoint !== auth.endpoint || Date.parse(key.expiresAt) <= now
        || auth.claims.exp * 1000 <= now || digest(JSON.stringify(key)) !== auth.keyFingerprint) throw denied();
}

module.exports = { PATH, ISSUER, TYPE, SCOPE, digest, configuration, authenticate, revalidate, ContextGeoError };

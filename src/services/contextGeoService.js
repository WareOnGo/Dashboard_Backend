const { z } = require('zod');
const GeoService = require('./geoService');
const { isAdmin } = require('../utils/admin');
const { ISSUER, SCOPE, ROLLBACK_SCOPE, digest, revalidate, ContextGeoError } = require('../utils/contextGeoAuth');

const payloadSchema = z.object({
    operationId: z.string().uuid(), name: z.string().trim().min(1).max(200),
    category: z.enum(GeoService.POI_CATEGORIES), lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180), notes: z.string().max(5000).nullable().optional(),
    city: z.string().trim().max(200).nullable().optional(),
}).strict();
const rollbackSchema = z.object({ operationId: z.string().uuid(), originalOperationId: z.string().uuid() }).strict();
const forbidden = () => new ContextGeoError(403, 'CONTEXT_GEO_FORBIDDEN');
class ContextGeoService {
    constructor(prisma, { env = process.env, now = Date.now } = {}) {
        this.prisma = prisma; this.env = env; this.now = now;
        this.geo = new GeoService(null);
    }
    async create(body, auth) {
        const parsed = payloadSchema.safeParse(body);
        if (!parsed.success) throw new ContextGeoError(400, 'CONTEXT_GEO_INVALID_POINT');
        const { operationId: rawOperationId, ...point } = parsed.data;
        const operationId = rawOperationId.toLowerCase();
        const accepted = this.geo.validatePoiPayload(point);
        // Authentication covers raw bytes. Idempotency covers the normalized accepted
        // point, so serialization/key order changes do not turn a safe retry into conflict.
        const bodyHash = digest(JSON.stringify({ name: accepted.name, category: accepted.category,
            lat: accepted.lat, lng: accepted.lng, notes: accepted.notes ?? null, city: accepted.city ?? null }));
        return this.transact(auth, SCOPE, [operationId], async (tx, employee, email) => {
            const rollbackCollision = await tx.$queryRaw`SELECT 1 FROM "ContextGeoRollback"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "operationId"=${operationId}::uuid`;
            if (rollbackCollision.length) throw new ContextGeoError(409, 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT');
            const existing = await tx.$queryRaw`SELECT "bodyHash",result FROM "ContextGeoWrite"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "operationId"=${operationId}::uuid`;
            if (existing.length) {
                if (existing[0].bodyHash !== bodyHash) throw new ContextGeoError(409, 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT');
                revalidate(auth, this.env, this.now());
                return { operationId, replayed: true, data: existing[0].result };
            }
            revalidate(auth, this.env, this.now());
            const data = { ...accepted, createdBy: email };
            const created = await tx.pointOfInterest.create({ data });
            const result = { id: created.id, ...data, notes: data.notes ?? null, city: data.city ?? null,
                createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString() };
            await tx.$executeRaw`INSERT INTO "ContextGeoWrite" (issuer,"employeeId","operationId","bodyHash","pointId",result)
                VALUES (${ISSUER},${employee.id},${operationId}::uuid,${bodyHash},${created.id},${JSON.stringify(result)}::jsonb)`;
            revalidate(auth, this.env, this.now());
            return { operationId, replayed: false, data: result };
        });
    }

    async rollback(body, auth) {
        const parsed = rollbackSchema.safeParse(body);
        if (!parsed.success) throw new ContextGeoError(400, 'CONTEXT_GEO_INVALID_ROLLBACK');
        const operationId = parsed.data.operationId.toLowerCase();
        const originalOperationId = parsed.data.originalOperationId.toLowerCase();
        if (operationId === originalOperationId) throw new ContextGeoError(400, 'CONTEXT_GEO_INVALID_ROLLBACK');
        return this.transact(auth, ROLLBACK_SCOPE, [operationId, originalOperationId], async (tx, employee) => {
            const previous = await tx.$queryRaw`SELECT "originalOperationId",result FROM "ContextGeoRollback"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "operationId"=${operationId}::uuid`;
            if (previous.length) {
                if (previous[0].originalOperationId !== originalOperationId) throw new ContextGeoError(409, 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT');
                revalidate(auth, this.env, this.now());
                return { operationId, replayed: true, data: previous[0].result };
            }
            const collisions = await tx.$queryRaw`SELECT 1 FROM "ContextGeoWrite"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "operationId"=${operationId}::uuid`;
            if (collisions.length) throw new ContextGeoError(409, 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT');
            const original = await tx.$queryRaw`SELECT "pointId",result FROM "ContextGeoWrite"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "operationId"=${originalOperationId}::uuid`;
            if (original.length !== 1) throw new ContextGeoError(404, 'CONTEXT_GEO_ORIGINAL_NOT_FOUND');
            const consumed = await tx.$queryRaw`SELECT 1 FROM "ContextGeoRollback"
                WHERE issuer=${ISSUER} AND "employeeId"=${employee.id} AND "originalOperationId"=${originalOperationId}::uuid`;
            if (consumed.length) throw new ContextGeoError(409, 'CONTEXT_GEO_ALREADY_ROLLED_BACK');
            // Lock the actual resource, not only the receipt, so browser updates/deletes serialize.
            // Geography is derived from lat/lng; every persisted editable/version field is compared.
            const rows = await tx.$queryRaw`SELECT id,name,category,lat,lng,notes,city,"createdBy","createdAt","updatedAt"
                FROM point_of_interest WHERE id=${original[0].pointId} FOR UPDATE`;
            if (rows.length !== 1) throw new ContextGeoError(409, 'CONTEXT_GEO_POINT_CHANGED');
            const row = rows[0], before = original[0].result;
            const keys = ['id','name','category','lat','lng','notes','city','createdBy'];
            if (!before || keys.some(key => row[key] !== before[key])
                || row.createdAt.toISOString() !== before.createdAt || row.updatedAt.toISOString() !== before.updatedAt)
                throw new ContextGeoError(409, 'CONTEXT_GEO_POINT_CHANGED');
            revalidate(auth, this.env, this.now());
            const result = { originalOperationId, pointId: row.id, before, after: null };
            await tx.pointOfInterest.delete({ where: { id: row.id } });
            await tx.$executeRaw`INSERT INTO "ContextGeoRollback" (issuer,"employeeId","operationId","originalOperationId","pointId",result)
                VALUES (${ISSUER},${employee.id},${operationId}::uuid,${originalOperationId}::uuid,${row.id},${JSON.stringify(result)}::jsonb)`;
            revalidate(auth, this.env, this.now());
            return { operationId, replayed: false, data: result };
        });
    }

    async transact(auth, actionScope, operationIds, work) {
        if (auth.claims.scopes[0] !== actionScope) throw forbidden();
        return this.prisma.$transaction(async tx => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
            revalidate(auth, this.env, this.now());
            const rows = await tx.$queryRaw`
                SELECT id,email,is_active,"dashboardAccess","adminAccess" FROM "VerifiedNumber"
                WHERE lower(btrim(email))=${auth.claims.email}
                LIMIT 2 FOR SHARE`;
            const employee = rows[0];
            if (rows.length !== 1 || employee.id !== Number(auth.claims.sub) || employee.is_active !== true
                || typeof employee.email !== 'string'
                || !z.email().safeParse(employee.email.trim()).success) throw forbidden();
            const email = employee.email.trim().toLowerCase();
            if (email !== auth.claims.email || !(employee.dashboardAccess === true || employee.adminAccess === true || isAdmin(email))) throw forbidden();
            // Serializes duplicate operations across workers. The row lock above also prevents
            // a concurrent roster revocation from racing the write itself.
            for (const id of [...new Set(operationIds)].sort()) {
                const operationKey = `${ISSUER}|${employee.id}|${id}`;
                await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 719044))::text AS locked`;
            }
            revalidate(auth, this.env, this.now());
            const nonceHash = digest(`${ISSUER}|${auth.kid}|${auth.claims.jti}`);
            await tx.$executeRaw`DELETE FROM "ContextGeoNonce" WHERE hash IN (
                SELECT hash FROM "ContextGeoNonce" WHERE "expiresAt" <= clock_timestamp() ORDER BY "expiresAt" LIMIT 1000)`;
            const nonces = await tx.$queryRaw`INSERT INTO "ContextGeoNonce" (hash,"expiresAt")
                VALUES (${nonceHash},${new Date(auth.claims.exp * 1000)}) ON CONFLICT DO NOTHING RETURNING hash`;
            if (nonces.length !== 1) throw new ContextGeoError(401, 'CONTEXT_GEO_UNAUTHORIZED');
            return work(tx, employee, email);
        }, { maxWait: 2000, timeout: 8000 });
    }
}


module.exports = ContextGeoService;

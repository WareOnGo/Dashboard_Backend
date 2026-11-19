const { Prisma } = require('@prisma/client');
const { fields, handoverKeys, availabilityKeys } = require('./fields');

const auditKeys = Object.fromEntries(fields.flatMap(({ key }) => {
  const parts = key === 'handover' ? handoverKeys : key === 'availabilityReview' ? availabilityKeys : [];
  return [key, ...parts].map(part => [part, key]);
}));

// One bounded result for the whole confirmation, including fields whose last
// edit predates field tracking. Never fetch audit snapshots into the response.
// Tracked revisions win over asynchronously written audit timestamps, which
// can put an older warehouse update's audit after a more recent field edit.
async function lastEditors(tx, warehouseId, fieldKeys = fields.map(field => field.key)) {
  const selected = new Set(fieldKeys);
  const selectedAuditKeys = Object.fromEntries(Object.entries(auditKeys).filter(([, key]) => selected.has(key)));
  if (selected.has('media')) selectedAuditKeys.photos = 'media';
  const rows = await tx.$queryRaw(Prisma.sql`
    WITH keys AS (
      SELECT key AS part, value AS field FROM jsonb_each_text(${JSON.stringify(selectedAuditKeys)}::jsonb)
    ), tracked AS (
      SELECT DISTINCT ON ("fieldKey") "fieldKey", NULLIF(btrim("actorEmail"), '') AS editor
      FROM "WarehouseFieldEdit"
      WHERE "warehouseId" = ${warehouseId}
        AND "fieldKey" IN (SELECT field FROM keys)
        -- Initial actorless WarehouseData snapshots can be creation inserts,
        -- not edits. Use UPDATE audits for those ambiguous first writes. All
        -- subsequent edits remain authoritative even if their actor is missing.
        AND NOT ("actorEmail" IS NULL AND source = 'Warehouse edit'
          AND "fieldKey" LIKE 'warehouseData.%' AND version IS NOT DISTINCT FROM 1 AND "oldValue" = 'null'::jsonb)
      ORDER BY "fieldKey", version DESC NULLS LAST, "createdAt" DESC, id DESC
    ), audited AS (
      SELECT DISTINCT ON (keys.field) keys.field AS "fieldKey",
        COALESCE(NULLIF(btrim(log."userEmail"), ''), NULLIF(btrim(log."userName"), '')) AS editor
      FROM audit_logs log
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(log.metadata->'changes') = 'array' THEN log.metadata->'changes'
          WHEN jsonb_typeof(log.metadata->'updatedFields') = 'array' THEN log.metadata->'updatedFields'
          ELSE '[]'::jsonb END
      ) change
      JOIN keys ON keys.part = CASE WHEN jsonb_typeof(change) = 'string' THEN change #>> '{}'
        ELSE change->>'field' END
      WHERE log.entity = 'warehouse' AND log."entityId" = ${String(warehouseId)} AND log.action = 'UPDATE'
      ORDER BY keys.field, log."createdAt" DESC, log.id DESC
    )
    SELECT "fieldKey", editor FROM tracked
    UNION ALL
    SELECT "fieldKey", editor FROM audited
    WHERE NOT EXISTS (SELECT 1 FROM tracked WHERE tracked."fieldKey" = audited."fieldKey")
  `);
  // Do not confuse an existing edit with a missing actor with an untouched field.
  return new Map(rows.map(row => [row.fieldKey, row.editor]));
}

module.exports = { lastEditors };

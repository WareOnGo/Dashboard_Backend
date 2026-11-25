const { registry, profileHash } = require('./engine');
const { clone, hash, fail } = require('./common');
const { exclusion } = require('./eligibility');

const compoundFields = {
  availabilityReview: ['availability', 'availabilityLastReviewedOn'],
  handover: ['handoverType', 'handoverDate', 'handoverLeadValue', 'handoverLeadUnit']
};
const select = { id: true, createdAt: true, status_updated_at: true, WarehouseData: { select: {} } };
for (const key of Object.keys(registry)) {
  if (key.startsWith('warehouseData.')) select.WarehouseData.select[key.split('.')[1]] = true;
  else for (const column of compoundFields[key] || [key]) select[column] = true;
}

function snapshot(warehouse, versions, mode, capturedAt) {
  const fields = Object.fromEntries(
    Object.keys(registry).map((key) => [
      key,
      key.startsWith('warehouseData.')
        ? (warehouse.WarehouseData?.[key.split('.')[1]] ?? null)
        : compoundFields[key]
          ? Object.fromEntries(compoundFields[key].map((column) => [column, warehouse[column] ?? null]))
          : (warehouse[key] ?? null)
    ])
  );
  const plainFields = clone(fields);
  return {
    warehouse_id: warehouse.id,
    city: warehouse.city,
    state: warehouse.state,
    warehouse_type: warehouse.warehouseType,
    fields: plainFields,
    source_field_versions: versions,
    mode,
    snapshot_id: hash({ warehouse_id: warehouse.id, fields: plainFields, versions }),
    source_captured_at_utc: capturedAt,
    source_created_at: warehouse.createdAt?.toISOString() || null,
    as_of_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(capturedAt)),
    source: 'WAREHOUSE'
  };
}

class QaSource {
  constructor({ repository, sourceDb, mode }) {
    this.repository = repository;
    this.sourceDb = sourceDb;
    this.mode = mode;
  }

  read(fn) {
    return this.sourceDb().$transaction(
      async (tx) => {
        // Enforce the source boundary in PostgreSQL, not only in application code.
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 }
    );
  }

  async load(ids, mode) {
    if (this.mode === 'pilot') {
      const keys = ids.map((id) => 'pilot:warehouse:' + id);
      const saved = await this.repository.caches(keys);
      const rows = keys.map((key) => saved.get(key));
      if (rows.some((row) => !row))
        fail(400, 'QA_UNKNOWN_PILOT_ID', 'Use warehouse IDs from the imported pilot snapshots.');
      return rows.map((row) => ({ ...clone(row), mode }));
    }
    // Read fields and their revision counters from the same source DB snapshot.
    return this.read((tx) => this.loadTx(tx, ids, mode));
  }

  async loadTx(tx, ids, mode) {
    const warehouses = await tx.warehouse.findMany({ where: { id: { in: ids } }, select });
    if (warehouses.length !== ids.length)
      fail(404, 'QA_WAREHOUSE_NOT_FOUND', 'One or more warehouse IDs were not found.');
    const versions = await tx.warehouseFieldVersion.findMany({
      where: { warehouseId: { in: ids }, fieldKey: { in: Object.keys(registry) } },
      select: { warehouseId: true, fieldKey: true, version: true }
    });
    const capturedAt = new Date().toISOString();
    return warehouses.map((warehouse) =>
      snapshot(
        warehouse,
        Object.fromEntries(
          versions.filter((v) => v.warehouseId === warehouse.id).map((v) => [v.fieldKey, v.version])
        ),
        mode,
        capturedAt
      )
    );
  }

  async scan(window, limit) {
    if (this.mode !== 'warehouse')
      fail(
        409,
        'QA_PILOT_SCAN_DISABLED',
        'The pilot accepts saved IDs. Forward scanning requires the warehouse source.'
      );
    const lower = window.after
      ? {
          OR: [
            { createdAt: { gt: new Date(window.after.createdAt) } },
            { createdAt: new Date(window.after.createdAt), id: { gt: window.after.id } }
          ]
        }
      : { createdAt: { gte: new Date(window.start) } };
    return this.read((tx) =>
      tx.warehouse.findMany({
        where: { AND: [lower, { createdAt: { lt: new Date(window.end) } }] },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit
      })
    );
  }
}

const forwardKey = (row) => hash({ warehouseId: row.warehouse_id, profileHash, mode: 'NEW_SUBMISSION' });
module.exports = { QaSource, snapshot, select, exclusion, forwardKey };

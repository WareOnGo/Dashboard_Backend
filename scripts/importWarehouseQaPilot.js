// One-time data import, not an application worker. No live warehouse connection.
const fs = require('node:fs');
const { z } = require('zod');
const { QaRepository } = require('../src/warehouseQa/repository');
const { hash } = require('../src/warehouseQa/common');
const { acceptAi } = require('../src/warehouseQa/engine');

function localUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username !== 'warehouse_test' ||
    url.password !== 'warehouse_test' ||
    url.pathname !== '/warehouse_qa' ||
    url.search ||
    url.hash
  )
    throw new Error('Pilot import requires the isolated local warehouse_qa database.');
  return url.toString();
}

async function importPilot(db, input, apply = false) {
  const data = z
    .object({
      runs: z.array(z.object({ id: z.string(), data: z.record(z.string(), z.unknown()) })),
      items: z.array(
        z.object({
          run_id: z.string(),
          snapshot: z.record(z.string(), z.unknown()),
          result: z.record(z.string(), z.unknown()),
          artifact: z.record(z.string(), z.unknown()).nullable()
        })
      ),
      events: z.array(z.record(z.string(), z.unknown())),
      requests: z.array(z.record(z.string(), z.unknown()))
    })
    .strict()
    .parse(input);
  for (const item of data.items) {
    if (
      item.snapshot.warehouse_id !== item.result.warehouse_id ||
      item.snapshot.snapshot_id !== item.result.snapshot_id
    )
      throw new Error('Pilot snapshot does not match the reviewed result.');
    if (item.artifact) acceptAi(item.snapshot, item.artifact.request, item.artifact.raw_output);
  }
  if (!apply)
    return {
      mode: 'dry-run',
      runs: data.runs.length,
      warehouses: data.items.length,
      events: data.events.length,
      requests: data.requests.length
    };
  const repository = new QaRepository(db);
  return repository.transaction(async (repo) => {
    await repo.lock('qa-pilot-import');
    for (const run of data.runs) {
      // Re-running the importer must not reset subsequent admin decisions.
      if (await repo.run(run.id)) continue;
      const actor = { id: 'legacy-pilot-import', name: 'Raghav via Codex' };
      await repo.insertRun(run.id, hash(run.data), actor, {
        ...run.data,
        source: 'pilot',
        imported_legacy_run: true
      });
      for (const item of data.items.filter((item) => item.run_id === run.id)) {
        await repo.putCache('pilot:warehouse:' + item.snapshot.warehouse_id, item.snapshot);
        await repo.insertItem(run.id, item.snapshot, {
          status: item.result.coverage.ai_status === 'FAILED' ? 'FAILED' : 'COMPLETED',
          result: item.result,
          artifact: item.artifact
        });
      }
      for (const event of data.events.filter((event) => event.run_id === run.id)) {
        await repo.event({
          runId: run.id,
          warehouseId: event.whid || null,
          actor: { id: 'legacy:' + event.actor, name: event.actor },
          action: event.action,
          payload: {
            ...event.payload,
            original_created_at: event.created_at,
            legacy_event_id: event.id,
            imported: true
          }
        });
      }
      // Legacy replay keys used a different fingerprint algorithm and identities.
      // Preserve them for audit, without claiming they are new API replay keys.
      await repo.event({
        runId: run.id,
        actor,
        action: 'LEGACY_PILOT_IMPORTED',
        payload: {
          runBy: 'Raghav',
          production_writes: 0,
          legacy_requests: data.requests,
          scope: 'RUN_IMPORT'
        }
      });
    }
    return { mode: 'apply', runs: data.runs.length, warehouses: data.items.length, production_writes: 0 };
  });
}
module.exports = { importPilot, localUrl };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args[0] || args.slice(1).some((arg) => arg !== '--apply'))
    throw new Error('Usage: node scripts/importWarehouseQaPilot.js <export.json> [--apply]');
  const url = localUrl(process.env.AI_QA_DATABASE_URL);
  const db = new (require('@prisma/client').PrismaClient)({ datasourceUrl: url, log: [] });
  importPilot(db, JSON.parse(fs.readFileSync(args[0], 'utf8')), args.includes('--apply'))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error('Pilot import failed', { code: error.code, name: error.name });
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}

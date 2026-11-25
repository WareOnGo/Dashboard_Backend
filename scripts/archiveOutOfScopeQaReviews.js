// Explicit maintenance of the isolated QA review state; never warehouse CRUD.
const { PrismaClient } = require('@prisma/client');
const { QaRepository } = require('../src/warehouseQa/repository');
const { exclusion } = require('../src/warehouseQa/eligibility');
const { profile, profileHash } = require('../src/warehouseQa/engine');
const { clone, hash, fail } = require('../src/warehouseQa/common');
const { localUrl } = require('./importWarehouseQaPilot');

const actor = { id: 'qa-scope-maintenance', name: 'Raghav via Codex' };

async function archiveOutOfScopeReviews(repository, runId, { apply = false } = {}) {
  return repository.transaction(async (repo) => {
    await repo.lock('qa-scope-archive:' + runId);
    if (!(await repo.run(runId))) fail(404, 'QA_RUN_NOT_FOUND', 'QA run not found.');
    const items = await repo.items(runId);
    const archived = [];
    for (const candidate of items) {
      if (candidate.result?.stage !== 'AI_REVIEW' || !exclusion(candidate.snapshot)) continue;
      const item = apply ? await repo.item(runId, candidate.warehouseId, true) : candidate;
      const reason = exclusion(item.snapshot);
      if (item.result?.stage !== 'AI_REVIEW' || !reason) continue;
      if (['QUEUED', 'RUNNING'].includes(item.status))
        fail(409, 'QA_EVALUATION_PENDING', 'Wait for queued evaluations to stop before archiving reviews.');

      const entry = {
        run_id: runId,
        warehouse_id: item.warehouseId,
        warehouse_type: item.snapshot.fields.warehouseType ?? null,
        previous_stage: item.result.stage,
        previous_version: item.result.version,
        reason,
        candidate_count: item.result.candidates.length,
        original_result_hash: hash(item.result)
      };
      if (apply) {
        const at = new Date().toISOString();
        const updated = clone(item.result);
        updated.stage = 'OUT_OF_SCOPE';
        updated.version++;
        updated.last_modified_at = at;
        updated.scope_archive = {
          reason,
          policy_version: profile.policy_version,
          profile_hash: profileHash,
          archived_at: at,
          archived_by: actor,
          previous_stage: item.result.stage,
          previous_version: item.result.version
        };
        await repo.saveResult(runId, item.warehouseId, updated);
        await repo.event({
          runId,
          warehouseId: item.warehouseId,
          actor,
          action: 'QA_REVIEW_REMOVED_FROM_SCOPE',
          payload: {
            scope: 'PER_WHID',
            runBy: 'Raghav',
            executedBy: actor,
            script: 'scripts/archiveOutOfScopeQaReviews.js',
            reason,
            policy_version: profile.policy_version,
            original_result_hash: entry.original_result_hash,
            stage_before: item.result.stage,
            stage_after: updated.stage,
            version_before: item.result.version,
            version_after: updated.version,
            findings_and_notes_preserved: true,
            warehouse_writes: 0
          }
        });
        entry.stage_after = updated.stage;
        entry.version_after = updated.version;
      }
      archived.push(entry);
    }
    return {
      mode: apply ? 'apply' : 'dry-run',
      run_id: runId,
      reviews: archived,
      runBy: 'Raghav',
      warehouse_writes: 0,
      production_writes: 0
    };
  });
}

module.exports = { archiveOutOfScopeReviews };

if (require.main === module) {
  const [runId, ...flags] = process.argv.slice(2);
  if (!runId || runId.startsWith('--') || flags.some((flag) => flag !== '--apply') || flags.length > 1)
    throw new Error('Usage: node scripts/archiveOutOfScopeQaReviews.js <run-id> [--apply]');
  // Deliberately no dotenv or DATABASE_URL fallback: only the existing isolated
  // loopback QA database is authorized by this maintenance command.
  const db = new PrismaClient({ datasourceUrl: localUrl(process.env.AI_QA_DATABASE_URL), log: [] });
  archiveOutOfScopeReviews(new QaRepository(db), runId, { apply: flags.includes('--apply') })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error('QA scope archive failed', { name: error.name, code: error.code });
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}

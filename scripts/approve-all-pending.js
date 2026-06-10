// scripts/approve-all-pending.js
// One-off: approve every PENDING staged submission via the normal service path
// (strict validation + atomic promote to Warehouse + APPROVE audit entry).
// Rows that fail strict validation are reported and left PENDING.
//
//   node scripts/approve-all-pending.js
const container = require('../src/container');
const database = require('../src/utils/database');

const REVIEWER = { email: 'raghav@wareongo.com', name: 'Bulk Approve' };

async function main() {
    const stagingService = container.resolve('stagingService');
    const stagedWarehouseModel = container.resolve('stagedWarehouseModel');

    // Snapshot all pending IDs first (paginate) so approvals don't disturb iteration.
    const ids = [];
    const PAGE = 200;
    for (let skip = 0; ; skip += PAGE) {
        const rows = await stagedWarehouseModel.findAll({ reviewStatus: 'PENDING', skip, take: PAGE });
        if (!rows || rows.length === 0) break;
        ids.push(...rows.map((r) => r.id));
        if (rows.length < PAGE) break;
    }

    console.log(`Found ${ids.length} PENDING submission(s).`);

    let approved = 0;
    const failed = [];
    for (const id of ids) {
        try {
            await stagingService.approveSubmission(id, REVIEWER);
            approved += 1;
            console.log(`  ✓ approved ${id}`);
        } catch (error) {
            failed.push({ id, name: error.name, message: error.message });
            console.log(`  ✗ skipped ${id} — ${error.name}: ${error.message}`);
        }
    }

    console.log(`\nDone. Approved ${approved}/${ids.length}. Left PENDING: ${failed.length}.`);
    if (failed.length) {
        console.log('Left PENDING (need manual fixes):');
        for (const f of failed) console.log(`  - ${f.id}: ${f.name} — ${f.message}`);
    }
}

main()
    .catch((err) => {
        console.error('Bulk approve failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        try { await database.disconnect(); } catch { /* ignore */ }
    });

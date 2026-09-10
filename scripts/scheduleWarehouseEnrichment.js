/**
 * Retarget the existing 15-minute job after deploying /api/enrichment/sweep.
 * Default is read-only: node -r dotenv/config scripts/scheduleWarehouseEnrichment.js
 * Apply after deploy: node -r dotenv/config scripts/scheduleWarehouseEnrichment.js --apply
 * The apply path first verifies the deployed endpoint with dryRun=true.
 */
const { PrismaClient } = require('@prisma/client');
const { JOB_NAME, planMigration, secretFromCommand } = require('../src/utils/enrichmentSchedule');

async function migrate(prisma, { apply = false, http = fetch } = {}) {
    const [job] = await prisma.$queryRaw`
        SELECT jobid, jobname, schedule, active, command FROM cron.job WHERE jobname = ${JOB_NAME}`;
    if (!job) throw new Error('Existing warehouse image-label cron job not found');
    const plan = planMigration(job);
    // Never print the command: it contains the shared secret.
    const { command, ...summary } = plan;
    console.log(JSON.stringify({ ...summary, jobid: String(summary.jobid), apply }));
    if (!apply || !plan.changed) return summary;

    const response = await http(plan.url, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secretFromCommand(job.command) },
        body: JSON.stringify({ dryRun: true }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Deployment readiness check returned HTTP ${response.status}; cron unchanged`);
    const payload = await response.json();
    if (payload.data?.status !== 'DRY_RUN' || !payload.data?.stages?.images
        || !payload.data?.stages?.proximity || !payload.data?.configured?.images || !payload.data?.configured?.proximity) {
        throw new Error('Deployment readiness check did not confirm both configured stages; cron unchanged');
    }
    // Serializable isolation catches concurrent edits without SELECT FOR UPDATE,
    // which requires direct UPDATE privileges Supabase does not grant on cron.job.
    await prisma.$transaction(async tx => {
        const [current] = await tx.$queryRaw`SELECT command FROM cron.job WHERE jobid = ${job.jobid}`;
        if (current?.command !== job.command) throw new Error('Cron command changed during readiness check; retry migration');
        await tx.$executeRaw`SELECT cron.alter_job(${job.jobid}::bigint, command := ${command})`;
    }, { isolationLevel: 'Serializable' });
    console.log('Existing cron job now calls warehouse enrichment; schedule and active state preserved.');
    return summary;
}

module.exports = { migrate };
if (require.main === module) {
    const prisma = new PrismaClient();
    migrate(prisma, { apply: process.argv.includes('--apply') })
        .catch(error => {
            // Database errors may embed command parameters. Report only an error
            // code for Prisma errors, never a command containing the cron secret.
            console.error(error.code || (error.name?.startsWith('Prisma') ? error.name : error.message));
            process.exitCode = 1;
        }).finally(() => prisma.$disconnect());
}

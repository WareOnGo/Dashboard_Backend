const { JOB_NAME, planMigration, secretFromCommand } = require('../src/utils/enrichmentSchedule');
const { MODEL, VERSION } = require('../src/utils/websiteImagePolicy.cjs');

async function verify(prisma, { run = false, http = fetch } = {}) {
    const [job] = await prisma.$queryRaw`SELECT jobid, jobname, schedule, active, command FROM cron.job WHERE jobname = ${JOB_NAME}`;
    if (!job) throw new Error('Scheduled enrichment job missing');
    const plan = planMigration(job);
    if (plan.changed) throw new Error('Scheduled job is not using the combined enrichment endpoint');
    // Read the actual scheduled credential into the request; never print it.
    const response = await http(plan.url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secretFromCommand(job.command) },
        body: JSON.stringify({ dryRun: !run }), signal: AbortSignal.timeout(85000) });
    const payload = await response.json();
    const data = payload.data || {};
    const keys = ['status','model','version','processed','assessed','labelled','failed','deferred','backlog','remaining','decisions'];
    const stages = Object.fromEntries(Object.entries(data.stages || {}).map(([name, result]) =>
        [name, Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]))]));
    const website = stages.websiteImages;
    const ready = Boolean(job.active && website?.model === MODEL && website?.version === VERSION
        && (run ? ['SUCCESS','PARTIAL'].includes(website.status) : website.status === 'DRY_RUN' && data.configured?.websiteImages));
    return { ready, mode: run ? 'run' : 'dry-run', http: response.status, status: data.status,
        cron: { jobid: String(job.jobid), schedule: job.schedule, active: job.active,
            timeoutMs: Number(job.command.match(/timeout_milliseconds\s*(?::=|=>)\s*(\d+)/i)?.[1]) || null },
        configured: data.configured, stages };
}
module.exports = { verify };
if (require.main === module) {
    require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--run')) throw new Error('Only --run is supported; default is dry-run');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    verify(prisma, { run: process.argv.includes('--run') }).then(result => {
        console.log(JSON.stringify(result)); if (!result.ready) process.exitCode = 2;
    }).catch(error => { console.error(JSON.stringify({ name: error.name, code: error.code })); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}

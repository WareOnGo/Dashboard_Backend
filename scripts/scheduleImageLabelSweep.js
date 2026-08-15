/**
 * Manage the pg_cron job that drives the image-label forward-fill.
 *
 * The sweep endpoint is bounded and idempotent, so the schedule is just a poke:
 * every run labels whatever is unlabelled and returns. Keeping the job
 * definition here (rather than as a one-off psql command) means the schedule,
 * timeout and target URL are reviewable and re-appliable.
 *
 * IMPORTANT — pg_net's default timeout is 5000ms, and a full sweep can take ~35s
 * at the 150-image cap. This job sets timeout_milliseconds explicitly. Without
 * it, pg_cron still reports "succeeded" (the SQL ran) while the HTTP response is
 * recorded in net._http_response as a NULL/timeout, leaving you blind to whether
 * the endpoint actually worked.
 *
 * Usage:
 *   node -r dotenv/config scripts/scheduleImageLabelSweep.js <command> [flags]
 *
 *   status                    show the job, recent runs and recent HTTP responses
 *   create --secret=...       create/replace the job (staged INACTIVE by default)
 *   activate                  turn the job on
 *   deactivate                turn the job off
 *   remove                    unschedule the job entirely
 *
 * Flags for `create`:
 *   --secret=<value>     REQUIRED. Must match CRON_SECRET in the API environment.
 *   --url=<url>          sweep endpoint (default: the App Runner backend)
 *   --schedule=<cron>    cron expression (default every 15 minutes)
 *   --timeout=<ms>       pg_net HTTP timeout (default 120000)
 *   --active             create it enabled instead of staged-inactive
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const COMMAND = process.argv[2];
const JOB_NAME = 'sweep-warehouse-image-labels';
const DEFAULT_URL = 'https://u3yrpp3726.ap-south-1.awsapprunner.com/api/image-labels/sweep';
const DEFAULT_SCHEDULE = '*/15 * * * *';
const DEFAULT_TIMEOUT_MS = 120000;

const mask = (text, secret) => (secret ? text.split(secret).join('<CRON_SECRET>') : text);

async function status() {
    const jobs = await prisma.$queryRaw`
        SELECT jobid, jobname, schedule, active, database, username, command
        FROM cron.job WHERE jobname = ${JOB_NAME}
    `;
    if (!jobs.length) {
        console.log(`no pg_cron job named "${JOB_NAME}"`);
        return;
    }
    const j = jobs[0];
    console.log(`[${j.jobid}] ${j.jobname}`);
    console.log(`  schedule : ${j.schedule}`);
    console.log(`  active   : ${j.active}`);
    console.log(`  db/user  : ${j.database} / ${j.username}`);
    // Never print the secret back out.
    console.log(`  command  : ${j.command.replace(/'[a-f0-9]{32,}'/gi, "'<CRON_SECRET>'").replace(/\s+/g, ' ').trim()}`);

    const runs = await prisma.$queryRaw`
        SELECT status, start_time, end_time, return_message
        FROM cron.job_run_details WHERE jobid = ${j.jobid}
        ORDER BY start_time DESC LIMIT 5
    `;
    console.log(`\n  recent pg_cron runs (${runs.length}):`);
    for (const r of runs) {
        console.log(`    ${new Date(r.start_time).toISOString()}  ${r.status}  ${r.return_message || ''}`);
    }
    if (!runs.length) console.log('    (none yet)');

    // pg_cron "succeeded" only means the SQL ran. The real outcome is here.
    try {
        const resp = await prisma.$queryRaw`
            SELECT status_code, error_msg, created FROM net._http_response
            WHERE created > now() - interval '1 day'
            ORDER BY created DESC LIMIT 5
        `;
        console.log(`\n  recent pg_net HTTP responses (all jobs, last day):`);
        for (const r of resp) {
            console.log(`    ${new Date(r.created).toISOString()}  status=${r.status_code ?? 'NULL'}  ${String(r.error_msg || '').slice(0, 90)}`);
        }
        if (!resp.length) console.log('    (none retained)');
    } catch (err) {
        console.log(`  (could not read net._http_response: ${err.message.split('\n')[0]})`);
    }
}

async function create() {
    const secret = arg('secret', null);
    if (!secret) {
        console.error('--secret=<value> is required, and must match CRON_SECRET in the API environment.');
        process.exit(1);
    }
    const url = arg('url', DEFAULT_URL);
    const schedule = arg('schedule', DEFAULT_SCHEDULE);
    const timeout = Number(arg('timeout', DEFAULT_TIMEOUT_MS));
    const active = process.argv.includes('--active');

    const command = `SELECT net.http_post(
    url := '${url}',
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret','${secret}'),
    body := '{}'::jsonb,
    timeout_milliseconds := ${timeout}
);`;

    // cron.schedule upserts by name in pg_cron 1.6, so this is safe to re-run.
    const rows = await prisma.$queryRaw`
        SELECT cron.schedule(${JOB_NAME}, ${schedule}, ${command}) AS jobid
    `;
    console.log(`scheduled "${JOB_NAME}" (jobid ${rows[0].jobid})`);
    console.log(`  url      : ${url}`);
    console.log(`  schedule : ${schedule}`);
    console.log(`  timeout  : ${timeout}ms`);

    if (!active) {
        // cron.schedule() creates the job enabled, so stage it off explicitly.
        await prisma.$executeRaw`SELECT cron.alter_job(${rows[0].jobid}::bigint, active := false)`;
        console.log('  active   : false  (staged — run `activate` once the API is deployed)');
    } else {
        console.log('  active   : true');
    }
    console.log(`\n  stored command:\n${mask(command, secret).split('\n').map((l) => '    ' + l).join('\n')}`);
}

/**
 * Toggle the job. Supabase denies direct UPDATE on cron.job (42501), so this
 * goes through cron.alter_job(), which is the supported path.
 */
async function setActive(value) {
    const rows = await prisma.$queryRaw`
        SELECT jobid FROM cron.job WHERE jobname = ${JOB_NAME}
    `;
    if (!rows.length) {
        console.error(`no job named "${JOB_NAME}" — run \`create\` first.`);
        process.exit(1);
    }
    // alter_job returns void, which $queryRaw cannot deserialize.
    await prisma.$executeRaw`SELECT cron.alter_job(${rows[0].jobid}::bigint, active := ${value}::boolean)`;
    const after = await prisma.$queryRaw`
        SELECT active FROM cron.job WHERE jobname = ${JOB_NAME}
    `;
    console.log(`"${JOB_NAME}" active = ${after[0].active}`);
}

async function remove() {
    await prisma.$queryRaw`SELECT cron.unschedule(${JOB_NAME})`;
    console.log(`unscheduled "${JOB_NAME}"`);
}

const COMMANDS = { status, create, activate: () => setActive(true), deactivate: () => setActive(false), remove };

(async () => {
    const fn = COMMANDS[COMMAND];
    if (!fn) {
        console.error(`usage: node -r dotenv/config scripts/scheduleImageLabelSweep.js <${Object.keys(COMMANDS).join('|')}> [flags]`);
        process.exit(1);
    }
    await fn();
})()
    .catch((err) => { console.error('ERR:', err.message); process.exit(1); })
    .finally(() => prisma.$disconnect());

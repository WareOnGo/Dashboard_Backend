const JOB_NAME = 'sweep-warehouse-image-labels';
const OLD_PATH = '/api/image-labels/sweep';
const NEW_PATH = '/api/enrichment/sweep';

/** Preserve the existing job/secret/schedule; change only its endpoint path. */
function planMigration(job) {
    const match = job.command.match(/\burl\s*(?::=|=>)\s*'((?:''|[^'])*)'/i);
    if (!match) throw new Error('Unsupported cron command: no literal endpoint URL');
    const current = match[1].replace(/''/g, "'");
    const url = new URL(current);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || ![OLD_PATH, NEW_PATH].includes(url.pathname)) {
        throw new Error('Expected the existing HTTPS warehouse sweep endpoint');
    }
    url.pathname = NEW_PATH;
    const next = url.toString();
    const command = job.command.replace(match[0], match[0].replace(match[1], next));
    return { jobid: job.jobid, jobname: job.jobname, schedule: job.schedule, active: job.active,
        url: next, changed: current !== next, command };
}

function secretFromCommand(command) {
    const match = command.match(/'x-webhook-secret'\s*,\s*'((?:''|[^'])*)'/i);
    if (!match) throw new Error('Unsupported cron secret format');
    return match[1].replace(/''/g, "'");
}

module.exports = { JOB_NAME, planMigration, secretFromCommand };

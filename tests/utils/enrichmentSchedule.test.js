const { planMigration } = require('../../src/utils/enrichmentSchedule');
const { migrate } = require('../../scripts/scheduleWarehouseEnrichment');
const job = { jobid: 8n, jobname: 'sweep-warehouse-image-labels', schedule: '*/15 * * * *', active: true,
    command: "SELECT net.http_post(url := 'https://example.test/api/image-labels/sweep', headers := jsonb_build_object('x-webhook-secret', 'test-secret'), body := '{}'::jsonb, timeout_milliseconds := 120000);" };
const ready = { data: { status: 'DRY_RUN', stages: { images: {}, proximity: {} }, configured: { images: true, proximity: true } } };
function setup() {
    const tx = { $queryRaw: jest.fn(async () => [{ command: job.command }]), $executeRaw: jest.fn(async () => 1) };
    const prisma = { $queryRaw: jest.fn(async () => [job]), $transaction: jest.fn(async fn => fn(tx)) };
    const http = jest.fn(async () => ({ ok: true, json: async () => ready }));
    return { tx, prisma, http };
}
test('changes only the endpoint path, retaining credentials, schedule, id and active state', () => {
    const plan = planMigration(job);
    expect(plan.command).toBe(job.command.replace('/api/image-labels/sweep', '/api/enrichment/sweep'));
    expect(plan).toMatchObject({ jobid: 8n, active: true, schedule: '*/15 * * * *' });
});
test('preview is read-only and does not contact the API', async () => {
    const { prisma, http } = setup();
    await migrate(prisma, { http });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
});
test.each([
    { ok: false, status: 404 },
    { ok: true, json: async () => ({ data: { ...ready.data, configured: { images: true, proximity: false } } }) },
])('does not switch cron before deployment is ready', async response => {
    const { prisma, http } = setup();
    http.mockResolvedValue(response);
    await expect(migrate(prisma, { apply: true, http })).rejects.toThrow(/cron unchanged/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('apply checks dry run before changing the existing job, with no redirects', async () => {
    const { prisma, http, tx } = setup();
    await migrate(prisma, { apply: true, http });
    expect(http).toHaveBeenCalledWith('https://example.test/api/enrichment/sweep', expect.objectContaining({
        body: '{"dryRun":true}', redirect: 'error', headers: expect.objectContaining({ 'x-webhook-secret': 'test-secret' }),
    }));
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
});
test('an intervening operator edit aborts the change', async () => {
    const { prisma, http, tx } = setup();
    tx.$queryRaw.mockResolvedValue([{ command: 'changed' }]);
    await expect(migrate(prisma, { apply: true, http })).rejects.toThrow(/changed during/);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
});
test('rerunning an applied migration makes no additional calls or changes', async () => {
    const { prisma, http } = setup();
    prisma.$queryRaw.mockResolvedValue([{ ...job, command: planMigration(job).command }]);
    await migrate(prisma, { apply: true, http });
    expect(http).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

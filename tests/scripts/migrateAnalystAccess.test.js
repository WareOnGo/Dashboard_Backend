const { migrate } = require('../../scripts/migrateAnalystAccess');
const id = { column_name: 'id', data_type: 'integer' };
const column = { column_name: 'analystAccess', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' };
const database = rows => ({ $queryRaw: jest.fn().mockResolvedValue(rows), $executeRawUnsafe: jest.fn().mockResolvedValue(0), $transaction: jest.fn(async values => Promise.all(values)) });

test('inspection does not mutate the roster', async () => {
    const prisma = database([id]);
    expect(await migrate(prisma)).toMatchObject({ mode: 'dry-run', exists: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
});
test('adds only a default-false capability in a bounded transaction', async () => {
    const prisma = database([id]);
    prisma.$queryRaw.mockResolvedValueOnce([id]).mockResolvedValueOnce([id, column]);
    expect(await migrate(prisma, true)).toMatchObject({ added: true, exists: true });
    const sql = prisma.$executeRawUnsafe.mock.calls.map(([text]) => text).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "analystAccess" boolean NOT NULL DEFAULT false');
    expect(sql).toContain('lock_timeout');
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});
test('repeated application is a verified no-op', async () => {
    const prisma = database([id, column]);
    expect(await migrate(prisma, true)).toMatchObject({ added: false, exists: true });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
});
test.each([[], [id, { ...column, data_type: 'text' }], [id, { ...column, is_nullable: 'YES' }], [id, { ...column, column_default: 'true' }]].map(rows => [rows]))('rejects an unexpected schema before writing (%#)', async rows => {
    const prisma = database(rows);
    await expect(migrate(prisma, true)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

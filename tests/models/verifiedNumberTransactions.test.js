const VerifiedNumberModel = require('../../src/models/verifiedNumberModel');

function client(locked) {
    const tx = { verifiedNumber: {}, $queryRaw: jest.fn(async () => [{ locked }]) };
    const prisma = { verifiedNumber: {}, $transaction: jest.fn(async operation => operation(tx)) };
    return { tx, prisma, model: new VerifiedNumberModel(prisma) };
}

test('roster checks use the transaction client with a bounded transaction-scoped lock', async () => {
    const { model, prisma, tx } = client(true);
    const result = await model.withRosterEdit(async scoped => {
        expect(scoped.prisma).toBe(tx);
        expect(scoped.model).toBe(tx.verifiedNumber);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        return 'saved';
    });
    expect(result).toBe('saved');
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ maxWait: 2000, timeout: 5000, isolationLevel: 'ReadCommitted' });
});

test.each([false, undefined])('a busy or malformed lock result %s never runs the edit', async locked => {
    const { model } = client(locked);
    const edit = jest.fn();
    await expect(model.withRosterEdit(edit)).rejects.toMatchObject({ statusCode: 409 });
    expect(edit).not.toHaveBeenCalled();
});

const { EventEmitter } = require('node:events');
const createAuditMiddleware = require('../../src/middleware/auditMiddleware');

test.each([
    [{ id: 'user-7', email: ' editor@example.test ' }, 'editor@example.test', 'user-7'],
    [{ id: 'user-7', email: ' ' }, 'user-7', 'user-7'],
    [{ id: 0 }, '0', '0'],
    [{ id: {} }, 'anonymous', null],
])('audits preserve authenticated identity and a recoverable ID: %j', (user, expected, actorUserId) => {
    const log = jest.fn();
    const req = { user, ip: '127.0.0.1' }, res = new EventEmitter();
    createAuditMiddleware({ log })(req, res, jest.fn());
    req.audit('UPDATE', 'warehouse', 1, 'Edited warehouse', { actorUserId: 'spoofed', changeCount: 1 });
    res.emit('finish');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
        userEmail: expected, metadata: { actorUserId, changeCount: 1 },
    }));
});

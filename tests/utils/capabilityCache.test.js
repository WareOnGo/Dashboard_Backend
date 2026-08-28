/**
 * The capability cache in utils/access.js.
 *
 * Every gated request resolves capabilities, and once the main dashboard is gated
 * that is one DB round trip in front of every page load. The cache exists to remove
 * that, but it sits directly on the authorization path, so three properties matter
 * more than the hit rate: a revoke must not linger, a DB failure must not be pinned
 * as "no access" for the whole TTL, and the env allowlist must keep working when the
 * database is unreachable.
 */
const mockFindFirst = jest.fn();
jest.mock('../../src/utils/database', () => ({
    getClient: () => ({ verifiedNumber: { findFirst: mockFindFirst } }),
}));

const GRANTED = {
    adminAccess: false, callDashboardAccess: false, dashboardAccess: true, reviewerAccess: false,
};

let access;

beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    mockFindFirst.mockReset();
    delete process.env.ADMIN_EMAILS;
    // Re-require so each test starts with an empty module-level cache.
    access = require('../../src/utils/access');
});

afterEach(() => {
    jest.useRealTimers();
});

describe('capability caching', () => {
    it('reads the database once for repeated lookups of the same user', async () => {
        mockFindFirst.mockResolvedValue(GRANTED);

        await access.resolveCapabilities('asha@wareongo.com');
        await access.resolveCapabilities('asha@wareongo.com');
        await access.resolveCapabilities('asha@wareongo.com');

        expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it('treats the email case-insensitively, as the lookup itself does', async () => {
        mockFindFirst.mockResolvedValue(GRANTED);

        await access.resolveCapabilities('asha@wareongo.com');
        await access.resolveCapabilities('ASHA@wareongo.com');

        expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it('re-reads once the entry has expired', async () => {
        mockFindFirst.mockResolvedValue(GRANTED);

        await access.resolveCapabilities('asha@wareongo.com');
        jest.advanceTimersByTime(31 * 1000);
        await access.resolveCapabilities('asha@wareongo.com');

        expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });

    it('applies a revoke immediately when the entry is invalidated', async () => {
        mockFindFirst.mockResolvedValue(GRANTED);
        const before = await access.resolveCapabilities('asha@wareongo.com');
        expect(before.DASHBOARD).toBe(true);

        mockFindFirst.mockResolvedValue({ ...GRANTED, dashboardAccess: false });
        access.invalidateCapabilities('ASHA@wareongo.com'); // case must not matter

        const after = await access.resolveCapabilities('asha@wareongo.com');
        expect(after.DASHBOARD).toBe(false);
        expect(mockFindFirst).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed lookup, so a blip retries on the next request', async () => {
        mockFindFirst.mockRejectedValueOnce(new Error('pooler is having a moment'));
        const denied = await access.resolveCapabilities('asha@wareongo.com');
        expect(denied.DASHBOARD).toBe(false); // fails closed

        mockFindFirst.mockResolvedValue(GRANTED);
        const recovered = await access.resolveCapabilities('asha@wareongo.com');
        expect(recovered.DASHBOARD).toBe(true);
    });

    it('caches a missing row, which is a legitimate answer', async () => {
        mockFindFirst.mockResolvedValue(null);

        const caps = await access.resolveCapabilities('stranger@wareongo.com');
        await access.resolveCapabilities('stranger@wareongo.com');

        expect(caps.DASHBOARD).toBe(false);
        expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    it('never consults the database for an env-allowlisted admin', async () => {
        process.env.ADMIN_EMAILS = 'boss@wareongo.com';
        mockFindFirst.mockRejectedValue(new Error('database is down'));

        const caps = await access.resolveCapabilities('boss@wareongo.com');

        expect(caps.ADMIN).toBe(true);
        expect(caps.DASHBOARD).toBe(true);
        expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('keeps users separate', async () => {
        mockFindFirst.mockResolvedValueOnce(GRANTED).mockResolvedValueOnce(null);

        const asha = await access.resolveCapabilities('asha@wareongo.com');
        const stranger = await access.resolveCapabilities('stranger@wareongo.com');

        expect(asha.DASHBOARD).toBe(true);
        expect(stranger.DASHBOARD).toBe(false);
    });
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBackfill, collisionKeys, differences, failureReason } = require('../../scripts/backfillWebpVariants');

const freshReport = () => ({ scanned: 0, updated: 0, uploaded: 0, reused: 0, bytes: 0,
    stale: 0, skipped: 0, failed: 0, results: [], errors: [] });

test('pre-cutover backfill only claims the WebP stage and survives a bad original', async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const failed = [];
    const repository = {
        async claim(stage, options) {
            assert.equal(stage, 'webp');
            assert.deepEqual(options, { limit: 1 });
            return rows.length ? [rows.shift()] : [];
        },
        async fail(stage, row, reason, options) { failed.push({ stage, id: row.id, reason, options }); },
        register() { assert.fail('Must not create placeholder rows before compatible backends deploy'); },
        reconcile() { assert.fail('Must not reconcile before compatible backends deploy'); },
        projectLegacy() { assert.fail('Must not rewrite Warehouse values'); },
    };
    const report = freshReport();
    await runBackfill({ repository, store: {}, existing: new Set(), collisions: new Set(),
        signal: new AbortController().signal, limit: 10, report, checkpoint: async () => {},
        compressOne: async row => {
            if (row.id === 2) throw new Error('source_http_404');
            return { updated: 1, uploaded: row.id === 1 ? 1 : 0, reused: row.id === 3 ? 1 : 0,
                bytes: row.id === 1 ? 200 : 0, stale: 0 };
        } });
    assert.equal(report.passComplete, true);
    assert.equal(report.scanned, 3);
    assert.equal(report.updated, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.uploaded, 1);
    assert.equal(report.reused, 1);
    assert.equal(report.bytes, 200);
    assert.deepEqual(failed, [{ stage: 'webp', id: 2, reason: 'source_http_404', options: { deferred: false } }]);
});

test('memory pressure returns the current claim for a later attempt and stops the run', async () => {
    const report = freshReport(), failures = [];
    const error = Object.assign(new Error('memory'), { code: 'WEBP_MEMORY_PRESSURE' });
    await assert.rejects(runBackfill({
        repository: { claim: async () => [{ id: 9 }], fail: async (...args) => failures.push(args) },
        store: {}, existing: new Set(), collisions: new Set(), signal: new AbortController().signal,
        limit: 10, report, checkpoint: async () => {}, compressOne: async () => { throw error; },
    }), { code: 'WEBP_MEMORY_PRESSURE' });
    assert.equal(report.scanned, 1);
    assert.equal(failures[0][0], 'webp');
    assert.deepEqual(failures[0][3], { deferred: true });
});

test('legacy collision inventory covers sources without label rows', () => {
    const target = url => ({ key: url.replace(/\.(jpg|png)$/, '.webp') });
    assert.deepEqual([...collisionKeys(['a.jpg', 'a.jpg', 'a.png', 'b.jpg'], target, '')], ['a.webp']);
});

test('preservation checks distinguish changed, deleted and newly inserted rows', () => {
    assert.deepEqual(differences([{ id: 1, digest: 'a' }, { id: 2, digest: 'b' }, { id: 3, digest: 'c' }],
        [{ id: 1, digest: 'a' }, { id: 2, digest: 'different' }, { id: 4, digest: 'd' }]),
    { changed: [2], removed: [3], added: 1 });
    assert.equal(failureReason(new Error('url or credentials should never be logged')), 'conversion_or_storage_failed');
});

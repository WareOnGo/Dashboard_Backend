const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|avif|gif|tiff?|bmp)$/i;

// Only these fields may be changed by the backfill. Scene labels and captions
// are never rewritten, and no placeholder label rows are inserted.
const FIELDS = [
    'storageBucket', 'originalObjectKey', 'compressedImageUrl',
    'compressedObjectKey', 'compressedBytes', 'compressedAt',
    'compressionStatus', 'compressionError', 'compressionVersion',
];

function warehouseImageUrls(warehouses, publicBase) {
    const urls = new Set();
    for (const warehouse of warehouses) {
        let media = warehouse.media;
        if (typeof media === 'string') { try { media = JSON.parse(media); } catch { media = null; } }
        for (const url of Array.isArray(media?.images) ? media.images : []) {
            if (typeof url === 'string' && url) urls.add(url);
        }
        let photos = warehouse.photos;
        if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch { /* legacy CSV */ } }
        for (const entry of Array.isArray(photos) ? photos : [photos]) {
            if (typeof entry !== 'string') continue;
            for (const raw of entry.split(/,\s*(?=https?:\/\/)/i)) {
                const url = raw.trim();
                try {
                    if (/\.(?:jpe?g|png|webp|avif|gif|tiff?|bmp|svg|heic|heif)$/i.test(new URL(url).pathname)
                        || sourceTarget(url, publicBase)) urls.add(url);
                } catch { /* non-image entry */ }
            }
        }
    }
    return urls;
}

function sourceTarget(imageUrl, publicBase) {
    try {
        const url = new URL(imageUrl);
        const base = new URL(publicBase);
        if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password) return null;
        const originalKey = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!originalKey || originalKey.endsWith('/') || (/\.[^/.]+$/.test(originalKey) && !IMAGE_EXTENSIONS.test(originalKey))) return null;
        const compressedKey = `webp/${originalKey.replace(IMAGE_EXTENSIONS, '')}.webp`;
        return {
            originalKey, compressedKey,
            compressedUrl: `${base.origin}/${compressedKey.split('/').map(encodeURIComponent).join('/')}`,
        };
    } catch { return null; }
}

function normalize(field, value) {
    if (value == null) return field === 'compressionStatus' ? 'PENDING' : null;
    if (field === 'compressedBytes') return String(value);
    if (field === 'compressedAt') return new Date(value).toISOString();
    return value;
}

function metadata(row) {
    return Object.fromEntries(FIELDS.map(field => [field, normalize(field, row[field])]));
}

function sameMetadata(left, right) {
    return FIELDS.every(field => normalize(field, left[field]) === normalize(field, right[field]));
}

function buildPlan(rows, inventory, { publicBase, bucket, additionalOriginalUrls = [] }) {
    const targets = new Map();
    const originalsByKey = new Map();
    for (const row of rows) {
        const target = sourceTarget(row.imageUrl, publicBase);
        targets.set(row.id, target);
        if (!target) continue;
        if (!originalsByKey.has(target.compressedKey)) originalsByKey.set(target.compressedKey, new Set());
        originalsByKey.get(target.compressedKey).add(target.originalKey);
    }
    // An unlabelled original can also collide with a labelled one's legacy key.
    for (const imageUrl of additionalOriginalUrls) {
        const target = sourceTarget(imageUrl, publicBase);
        if (!target) continue;
        if (!originalsByKey.has(target.compressedKey)) originalsByKey.set(target.compressedKey, new Set());
        originalsByKey.get(target.compressedKey).add(target.originalKey);
    }
    const collisions = new Set([...originalsByKey].filter(([, keys]) => keys.size > 1).map(([key]) => key));
    const changes = [];
    const summary = { total: rows.length, ready: 0, pending: 0, unsupported: 0, ambiguous: 0, runningSkipped: 0, managedSkipped: 0, unchanged: 0, wouldUpdate: 0 };
    for (const row of rows) {
        // A future worker owns RUNNING rows. Re-running a historical backfill
        // must not reset an active job or clear the result it is publishing.
        if (row.compressionStatus === 'RUNNING') { summary.runningSkipped++; continue; }
        // A versioned result belongs to the new processor, which may use a
        // different object layout. Never replace it with a legacy WebP.
        if (row.compressionVersion) { summary.managedSkipped++; continue; }
        const target = targets.get(row.id);
        const before = metadata(row);
        const after = Object.fromEntries(FIELDS.map(field => [field, null]));
        after.compressionStatus = 'PENDING';
        if (!target) {
            after.compressionStatus = 'UNSUPPORTED';
            after.compressionError = 'Original URL is outside the configured bucket or has an unsupported image path';
            summary.unsupported++;
        } else {
            after.storageBucket = bucket;
            after.originalObjectKey = target.originalKey;
            if (collisions.has(target.compressedKey)) {
                after.compressionStatus = 'FAILED';
                after.compressionError = 'Multiple original paths map to the same legacy WebP key';
                summary.ambiguous++;
            } else {
                const object = inventory.get(target.compressedKey);
                if (object && Number(object.bytes) > 0) {
                    after.compressedImageUrl = target.compressedUrl;
                    after.compressedObjectKey = target.compressedKey;
                    after.compressedBytes = String(object.bytes);
                    after.compressedAt = object.lastModified ? new Date(object.lastModified).toISOString() : null;
                    after.compressionStatus = 'READY';
                    summary.ready++;
                } else summary.pending++;
            }
        }
        if (sameMetadata(before, after) && row.compressionCheckedAt) summary.unchanged++;
        else changes.push({ id: row.id, imageUrl: row.imageUrl, before, after });
    }
    summary.wouldUpdate = changes.length;
    return { changes, summary };
}

async function readInventory(client, Command, bucket, signal) {
    const inventory = new Map();
    let continuation;
    const seen = new Set();
    do {
        const page = await client.send(new Command({ Bucket: bucket, Prefix: 'webp/', MaxKeys: 1000, ContinuationToken: continuation }), { abortSignal: signal });
        for (const object of page.Contents || []) {
            if (object.Key && Number(object.Size) > 0) inventory.set(object.Key, { bytes: object.Size, lastModified: object.LastModified || null });
        }
        const next = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!next || seen.has(next))) throw new Error('R2 inventory pagination did not complete');
        if (next) seen.add(next);
        continuation = next;
    } while (continuation);
    return inventory;
}

module.exports = { FIELDS, warehouseImageUrls, sourceTarget, metadata, sameMetadata, buildPlan, readInventory };

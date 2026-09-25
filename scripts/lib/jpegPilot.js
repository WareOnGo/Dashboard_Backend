const sharp = require('sharp');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const JPEG_VERSION = 'jpeg-1920-q82-progressive-420-v1';
const JPEG_FIELDS = ['jpegUrl', 'jpegBytes', 'jpegAt', 'jpegVersion', 'jpegStatus', 'jpegError'];
const MAX_BYTES = 20 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function parsePilotArgs(args) {
    let ids, apply = false;
    for (const arg of args) {
        if (arg === '--apply') apply = true;
        else if (arg.startsWith('--ids=') && ids === undefined) {
            const entries = arg.slice(6).split(',');
            if (entries.some(value => !/^[1-9]\d*$/.test(value))) throw new Error('Invalid warehouse IDs');
            ids = [...new Set(entries.map(Number))];
        } else throw new Error('Usage: node scripts/pilotJpegVariants.js --ids=1,2,3,4 [--apply]');
    }
    if (!ids?.length || ids.length > 4 || ids.some(id => !Number.isSafeInteger(id))) {
        throw new Error('A JPEG pilot requires 1–4 explicit warehouse IDs');
    }
    return { ids, apply };
}

async function downloadImage(url, publicBase) {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(publicBase).origin || parsed.protocol !== 'https:'
        || parsed.username || parsed.password) throw new Error('image_origin_not_allowed');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel();
        throw new Error(`image_http_${response.status}`);
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error('image_too_large');
        chunks.push(chunk);
    }
    if (!bytes) throw new Error('image_empty');
    return Buffer.concat(chunks);
}

async function compressJpeg(original) {
    const started = performance.now();
    const { data, info } = await sharp(original, { limitInputPixels: 16_000_000, sequentialRead: true, failOn: 'error' })
        .timeout({ seconds: 15 }).rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#fff' })
        .jpeg({ quality: 82, progressive: true, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true });
    const metadata = await sharp(data).metadata();
    if (metadata.format !== 'jpeg' || !info.size || info.width > 1920 || info.height > 1920
        || metadata.orientation && metadata.orientation !== 1) throw new Error('invalid_jpeg_output');
    return { data, bytes: info.size, width: info.width, height: info.height, encodeMs: performance.now() - started };
}

function jpegTarget(originalUrl, original, publicBase) {
    const key = `jpeg/images/${sha(originalUrl)}/${JPEG_VERSION}/${sha(original)}.jpg`;
    return { key, url: `${new URL(publicBase).origin}/${key}` };
}

// Publication is the only success write. Prove all other fields survive within
// the same row lock, without competing with concurrent label/WebP processing.
async function publishJpeg(prisma, row, ids, result) {
    return prisma.$transaction(async tx => {
        const [before] = await tx.$queryRawUnsafe(`SELECT l."jpegUrl", l."jpegVersion",
          md5((to_jsonb(l) - $3::text[])::text) AS digest FROM labeled_warehouse_images l
          WHERE l.id=$1 AND l."imageUrl"=$2 AND EXISTS (
            SELECT 1 FROM "Warehouse" w WHERE w.id IN (SELECT jsonb_array_elements_text($4::jsonb)::int)
            AND l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))) FOR UPDATE OF l`,
        row.id, row.imageUrl, JPEG_FIELDS, JSON.stringify(ids));
        if (!before) throw new Error('image_no_longer_referenced_by_pilot');
        if (before.jpegUrl !== row.jpegUrl || before.jpegVersion !== row.jpegVersion) {
            throw new Error('jpeg_changed_during_pilot');
        }
        const [after] = await tx.$queryRawUnsafe(`UPDATE labeled_warehouse_images l SET
          "jpegUrl"=$2,"jpegBytes"=$3::bigint,"jpegAt"=now(),"jpegVersion"=$4,
          "jpegStatus"='READY',"jpegError"=NULL WHERE id=$1
          RETURNING md5((to_jsonb(l) - $5::text[])::text) AS digest`,
        row.id, result.url, result.bytes, JPEG_VERSION, JPEG_FIELDS);
        if (before.digest !== after.digest) throw new Error('Non-JPEG preservation check failed');
        return { nonJpegFieldsPreserved: true };
    }, { maxWait: 10000, timeout: 15000 });
}

module.exports = { JPEG_VERSION, JPEG_FIELDS, MAX_BYTES, sha, parsePilotArgs, downloadImage, compressJpeg, jpegTarget, publishJpeg };

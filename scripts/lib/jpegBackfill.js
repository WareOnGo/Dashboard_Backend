const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { JPEG_FIELDS } = require('./jpegPilot');

const SMALL_BYTES = 200 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const PHOTO_VERSION = 'jpeg-1280-q82-progressive-420-v1';
const DOCUMENT_VERSION = 'jpeg-1920-q82-progressive-420-v1';
const REUSE_VERSION = 'jpeg-original-reuse-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const maxEdge = row => row.classification === 'DOCUMENT' ? 1920 : 1280;
const versionFor = row => maxEdge(row) === 1920 ? DOCUMENT_VERSION : PHOTO_VERSION;
const jpegPath = url => /\.jpe?g([?#].*)?$/i.test(url);

function reusable(metadata, bytes, edge, url, { smallOnly = true } = {}) {
    return metadata.format === 'jpeg' && jpegPath(url) && bytes > 0
        && (!smallOnly || bytes <= SMALL_BYTES)
        && metadata.width > 0 && metadata.height > 0
        && metadata.width <= edge && metadata.height <= edge
        && (!metadata.orientation || metadata.orientation === 1)
        && (!metadata.space || ['srgb', 'b-w'].includes(metadata.space))
        && (!metadata.pages || metadata.pages === 1);
}

function complete(row) {
    return row.jpegStatus === 'READY' && row.jpegUrl && (
        row.jpegVersion === versionFor(row)
        || (row.jpegVersion === REUSE_VERSION && row.jpegUrl === row.imageUrl));
}

function targetFor(row, sourceHash, publicBase) {
    const key = `jpeg/images/${sha(row.imageUrl)}/${versionFor(row)}/${sourceHash}.jpg`;
    return { key, url: `${new URL(publicBase).origin}/${key}` };
}

async function pool(items, concurrency, work, signal) {
    let next = 0, failure;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length && !failure && !signal?.aborted) {
            const item = items[next++];
            try { await work(item); } catch (error) { failure ||= error; }
        }
    }));
    if (failure) throw failure;
    signal?.throwIfAborted();
}

function semaphore(limit) {
    let active = 0;
    const waiting = [];
    return async work => {
        if (active >= limit) await new Promise(resolve => waiting.push(resolve));
        else active++;
        try { return await work(); }
        finally { if (waiting.length) waiting.shift()(); else active--; }
    };
}

async function checkMemory() {
    const text = await fs.readFile('/proc/meminfo', 'utf8');
    const available = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1] || 0) * 1024;
    if (available < 1536 * 1024 * 1024 || process.memoryUsage().rss > 512 * 1024 * 1024) {
        throw new Error('jpeg_memory_pressure');
    }
}

// Stream into a per-image file: there is never an in-memory catalogue of originals.
async function download(url, file, publicBase, signal) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.origin !== new URL(publicBase).origin
        || parsed.username || parsed.password) throw new Error('source_origin_not_allowed');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel(); throw new Error(`source_http_${response.status}_or_size_limit`);
    }
    const handle = await fs.open(file, 'w', 0o600);
    let bytes = 0;
    const hash = createHash('sha256');
    try {
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) throw new Error('source_too_large');
            hash.update(chunk); await handle.writeFile(chunk);
        }
        if (!bytes) throw new Error('source_empty');
    } finally { await handle.close(); }
    return { bytes, hash: hash.digest('hex') };
}

function decoder(input, output, mode, edge, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=64', path.join(__dirname, 'jpegBackfillWorker.cjs'), input, output, mode, String(edge)], {
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { PATH: process.env.PATH, LANG: 'C.UTF-8', UV_THREADPOOL_SIZE: '1', MALLOC_ARENA_MAX: '2' },
        });
        let stdout = '', failure, closed = false, checking = false;
        const stop = error => { if (!closed) { failure ||= error; child.kill('SIGKILL'); } };
        const abort = () => stop(new Error('operator_interrupted'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const timeout = setTimeout(() => stop(new Error('source_decode_timeout')), 30000);
        const memory = setInterval(async () => {
            if (closed || checking || !child.pid) return;
            checking = true;
            try {
                const text = await fs.readFile(`/proc/${child.pid}/status`, 'utf8');
                if (Number(/VmRSS:\s+(\d+)/.exec(text)?.[1] || 0) > 256 * 1024) stop(new Error('source_decoder_memory_limit'));
            } catch (error) { if (error.code !== 'ENOENT') stop(new Error('source_memory_check_failed')); }
            finally { checking = false; }
        }, 100);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4096) stop(new Error('source_decoder_invalid_response')); });
        child.on('error', () => { failure ||= new Error('source_decoder_start_failed'); });
        child.on('close', code => {
            closed = true; clearTimeout(timeout); clearInterval(memory); signal.removeEventListener('abort', abort);
            if (failure) return reject(failure);
            let result; try { result = JSON.parse(stdout); } catch { /* Crash: fail this image only. */ }
            if (code === 0 && result?.ok === true) return resolve(result);
            reject(new Error(/^source_[a-z_]+$/.test(result?.reason || '') ? result.reason : 'source_decode_failed'));
        });
    });
}

// A single atomic statement checks ownership and the old JPEG result. The final
// division forces rollback if a trigger unexpectedly changes any non-JPEG field.
async function publish(prisma, row, result) {
    const rows = await prisma.$queryRawUnsafe(`WITH current AS MATERIALIZED (
      SELECT l.id,md5((to_jsonb(l)-$9::text[])::text) AS digest FROM labeled_warehouse_images l
      WHERE l.id=$1 AND l."imageUrl"=$2
        AND l."jpegUrl" IS NOT DISTINCT FROM $3 AND l."jpegVersion" IS NOT DISTINCT FROM $4
        AND l."jpegStatus"=$5 AND l."jpegAt" IS NOT DISTINCT FROM $6::timestamptz
        AND l.classification::text IS NOT DISTINCT FROM $12
        AND EXISTS (SELECT 1 FROM "Warehouse" w WHERE w.id=ANY($7::int[])
          AND l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))) FOR UPDATE OF l
    ) UPDATE labeled_warehouse_images l SET "jpegUrl"=$8,"jpegBytes"=$10::bigint,
      "jpegAt"=now(),"jpegVersion"=$11,"jpegStatus"='READY',"jpegError"=NULL FROM current c
      WHERE l.id=c.id RETURNING l.id,
      1 / CASE WHEN md5((to_jsonb(l)-$9::text[])::text)=c.digest THEN 1 ELSE 0 END AS preserved`,
    row.id, row.imageUrl, row.jpegUrl, row.jpegVersion, row.jpegStatus, row.jpegAt,
    row.warehouseIds, result.url, JPEG_FIELDS, result.bytes, result.version, row.classification);
    return rows.length === 1;
}

// Group a handful of ready results into one database round trip without increasing
// the connection pool. Each row still has its own reference/CAS/preservation guards.
async function publishBatch(prisma, entries) {
    if (!entries.length) return new Set();
    if (entries.length > 8 || new Set(entries.map(entry=>entry.row.id)).size !== entries.length) throw new Error('invalid_jpeg_batch');
    const payload=entries.map(({row,result})=>({id:row.id,imageUrl:row.imageUrl,oldUrl:row.jpegUrl,
        oldVersion:row.jpegVersion,oldStatus:row.jpegStatus,oldAt:row.jpegAt,classification:row.classification,
        warehouseIds:row.warehouseIds,url:result.url,bytes:result.bytes,version:result.version}));
    const rows=await prisma.$queryRawUnsafe(`WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id int,"imageUrl" text,"oldUrl" text,
        "oldVersion" text,"oldStatus" text,"oldAt" timestamptz,classification text,"warehouseIds" int[],url text,bytes bigint,version text)
    ), current AS MATERIALIZED (
      SELECT l.id,i.url,i.bytes,i.version,md5((to_jsonb(l)-$2::text[])::text) AS digest
      FROM labeled_warehouse_images l JOIN input i ON l.id=i.id AND l."imageUrl"=i."imageUrl"
      WHERE l."jpegUrl" IS NOT DISTINCT FROM i."oldUrl" AND l."jpegVersion" IS NOT DISTINCT FROM i."oldVersion"
        AND l."jpegStatus"=i."oldStatus" AND l."jpegAt" IS NOT DISTINCT FROM i."oldAt"
        AND l.classification::text IS NOT DISTINCT FROM i.classification
        AND EXISTS (SELECT 1 FROM "Warehouse" w WHERE w.id=ANY(i."warehouseIds")
          AND l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos)))
      ORDER BY l.id FOR UPDATE OF l
    ) UPDATE labeled_warehouse_images l SET "jpegUrl"=c.url,"jpegBytes"=c.bytes,
      "jpegAt"=now(),"jpegVersion"=c.version,"jpegStatus"='READY',"jpegError"=NULL FROM current c
      WHERE l.id=c.id RETURNING l.id,
      1 / CASE WHEN md5((to_jsonb(l)-$2::text[])::text)=c.digest THEN 1 ELSE 0 END AS preserved`,
    JSON.stringify(payload),JPEG_FIELDS);
    return new Set(rows.map(row=>row.id));
}

function batchPublisher(prisma, size=8, waitMs=400) {
    let pending=[],timer;
    async function flush(){
        clearTimeout(timer);timer=undefined;
        const batch=pending;pending=[];
        if(!batch.length)return;
        try{
            const updated=await publishBatch(prisma,batch);
            for(const item of batch)item.resolve(updated.has(item.row.id));
        }catch(error){for(const item of batch)item.reject(error);}
    }
    return (row,result)=>new Promise((resolve,reject)=>{
        pending.push({row,result,resolve,reject});
        if(pending.length>=size)void flush();
        else timer??=setTimeout(flush,waitMs);
    });
}

module.exports = { SMALL_BYTES, MAX_BYTES, PHOTO_VERSION, DOCUMENT_VERSION, REUSE_VERSION,
    maxEdge, versionFor, reusable, complete, targetFor, sha, pool, semaphore, checkMemory, download, decoder, publish,
    publishBatch,batchPublisher };

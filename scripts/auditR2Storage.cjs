// Read-only R2 account inventory. Never uploads, modifies, or deletes an object.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');
const { S3Client, ListBucketsCommand, ListObjectsV2Command, ListMultipartUploadsCommand,
    ListPartsCommand, GetBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');
const workspace = path.resolve(__dirname, '../../..');
const envFiles = [
    'WAG_Dashboard/Backend_Repository/.env', 'Autoware/apps/backend/.env',
    'exotel_experiments/exotel-call-service/.env', 'EmployeeReimbursementPortal/.env',
    'panoramic_mvp_viewer/.env', 'website_combined/wareongo-cms/.env',
];
const errorInfo = error => ({ name: error.name, code: error.code, httpStatus: error.$metadata?.httpStatusCode });
function configurations() {
    return envFiles.filter(file => fs.existsSync(path.join(workspace, file))).map(file => {
        const env = dotenv.parse(fs.readFileSync(path.join(workspace, file)));
        return { file, env, account: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET_NAME || env.R2_BUCKET,
            publicBase: (env.R2_PUBLIC_URL || env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '') };
    }).filter(row => row.account && row.env.R2_ACCESS_KEY_ID && row.env.R2_SECRET_ACCESS_KEY);
}
function clientFor(row) {
    return new S3Client({ region: 'auto', endpoint: `https://${row.account}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: row.env.R2_ACCESS_KEY_ID, secretAccessKey: row.env.R2_SECRET_ACCESS_KEY },
        maxAttempts: 2, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}
function add(map, key, bytes) {
    const value = map[key] ||= { objects: 0, bytes: 0 }; value.objects++; value.bytes += bytes;
}
function fileType(key) {
    const ext = path.extname(key).toLowerCase().slice(1) || '(none)';
    if (/^(jpg|jpeg|png|gif|webp|avif|heic|heif|bmp|tif|tiff|svg)$/.test(ext)) return 'image';
    if (/^(mp4|mov|avi|webm|mkv|m4v|3gp)$/.test(ext)) return 'video';
    if (/^(mp3|wav|m4a|ogg|aac|flac|opus|amr)$/.test(ext)) return 'audio';
    if (/^(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt)$/.test(ext)) return 'document';
    return 'other';
}
async function main() {
    const startedAt = new Date().toISOString();
    const directory = path.resolve(__dirname, '../tools/r2-audit', startedAt.replace(/[:.]/g, '-'));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const configs = configurations();
    const report = { startedAt, readOnly: true, directory, accounts: [], buckets: [], requests: {} };
    const save = () => fs.writeFileSync(path.join(directory, 'inventory-summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    async function send(client, command) {
        const name = command.constructor.name; report.requests[name] = (report.requests[name] || 0) + 1;
        return client.send(command, { abortSignal: AbortSignal.timeout(45000) });
    }
    for (const account of [...new Set(configs.map(row => row.account))]) {
        const accountTag = createHash('sha256').update(account).digest('hex').slice(0, 10);
        const candidates = configs.filter(row => row.account === account);
        const accountReport = { accountTag, bucketListingComplete: false, errors: [] };
        report.accounts.push(accountReport);
        const bucketNames = new Set(candidates.map(row => row.bucket).filter(Boolean));
        let adminClient;
        const triedKeys = new Set();
        for (const config of candidates) {
            if (triedKeys.has(config.env.R2_ACCESS_KEY_ID)) continue;
            triedKeys.add(config.env.R2_ACCESS_KEY_ID);
            const client = clientFor(config);
            try {
                let continuation;
                do {
                    const page = await send(client, new ListBucketsCommand(continuation ? { ContinuationToken: continuation } : {}));
                    for (const bucket of page.Buckets || []) bucketNames.add(bucket.Name);
                    const next = page.ContinuationToken;
                    if (next && next === continuation) throw new Error('repeated_bucket_page');
                    continuation = next;
                } while (continuation);
                accountReport.bucketListingComplete = true; adminClient = client; break;
            } catch (error) { accountReport.errors.push({ source: config.file, ...errorInfo(error) }); client.destroy(); }
        }
        accountReport.bucketNames = [...bucketNames].sort(); save();
        console.log(JSON.stringify({ phase: 'buckets', accountTag, ...accountReport }));
        for (const bucket of [...bucketNames].sort()) {
            const own = candidates.find(row => row.bucket === bucket);
            const clients = [...new Set([adminClient, own && clientFor(own)].filter(Boolean))];
            const data = { name: bucket, accountTag, publicBases: [...new Set(candidates.filter(row => row.bucket === bucket).map(row => row.publicBase).filter(Boolean))],
                configuredBy: candidates.filter(row => row.bucket === bucket).map(row => row.file),
                complete: false, objects: 0, bytes: 0, pages: 0, byPrefix: {}, byExtension: {}, byType: {}, byMonth: {}, byStorageClass: {}, largest: [], errors: [] };
            report.buckets.push(data); save();
            let selected, first;
            for (const client of clients) {
                try { first = await send(client, new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 })); selected = client; break; }
                catch (error) { data.errors.push({ operation: 'ListObjectsV2', ...errorInfo(error) }); }
            }
            if (!selected) { save(); continue; }
            const fd = fs.openSync(path.join(directory, `${bucket}.objects.ndjson`), 'w', 0o600);
            try {
                let page = first, previousToken;
                while (true) {
                    const lines = [];
                    for (const object of page.Contents || []) {
                        const item = { key: object.Key, bytes: Number(object.Size), modifiedAt: object.LastModified?.toISOString(),
                            etag: object.ETag?.replace(/"/g, ''), storageClass: object.StorageClass || 'STANDARD' };
                        lines.push(JSON.stringify(item)); data.objects++; data.bytes += item.bytes;
                        add(data.byPrefix, item.key.includes('/') ? item.key.split('/')[0] + '/' : '(root)', item.bytes);
                        add(data.byExtension, path.extname(item.key).toLowerCase() || '(none)', item.bytes);
                        add(data.byType, fileType(item.key), item.bytes);
                        add(data.byMonth, item.modifiedAt?.slice(0, 7) || 'unknown', item.bytes);
                        add(data.byStorageClass, item.storageClass, item.bytes);
                        data.largest.push(item); data.largest.sort((a, b) => b.bytes - a.bytes); data.largest.length = Math.min(15, data.largest.length);
                    }
                    if (lines.length) fs.writeSync(fd, lines.join('\n') + '\n');
                    data.pages++; save();
                    if (data.pages % 10 === 0) console.log(JSON.stringify({ phase: 'objects', bucket, objects: data.objects, GB: data.bytes / 1e9, pages: data.pages }));
                    if (!page.IsTruncated) { data.complete = true; break; }
                    const next = page.NextContinuationToken;
                    if (!next || next === previousToken) throw new Error('incomplete_object_listing');
                    previousToken = next;
                    page = await send(selected, new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: next }));
                }
            } catch (error) { data.errors.push({ operation: 'ListObjectsV2', ...errorInfo(error) }); }
            finally { fs.closeSync(fd); }
            try {
                const lifecycle = await send(selected, new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
                data.lifecycle = lifecycle.Rules || [];
            } catch (error) { data.lifecycleError = errorInfo(error); }
            data.multipart = { uploads: [], bytes: 0, parts: 0, complete: false };
            try {
                let keyMarker, uploadIdMarker;
                do {
                    const page = await send(selected, new ListMultipartUploadsCommand({ Bucket: bucket, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }));
                    for (const upload of page.Uploads || []) {
                        const entry = { key: upload.Key, initiatedAt: upload.Initiated?.toISOString(), parts: 0, bytes: 0 };
                        let partMarker;
                        do {
                            const parts = await send(selected, new ListPartsCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId, PartNumberMarker: partMarker }));
                            for (const part of parts.Parts || []) { entry.parts++; entry.bytes += Number(part.Size); }
                            partMarker = parts.IsTruncated ? parts.NextPartNumberMarker : undefined;
                        } while (partMarker);
                        data.multipart.uploads.push(entry); data.multipart.bytes += entry.bytes; data.multipart.parts += entry.parts;
                    }
                    if (!page.IsTruncated) { data.multipart.complete = true; break; }
                    if (!page.NextKeyMarker || (page.NextKeyMarker === keyMarker && page.NextUploadIdMarker === uploadIdMarker)) throw new Error('incomplete_multipart_listing');
                    keyMarker = page.NextKeyMarker; uploadIdMarker = page.NextUploadIdMarker;
                } while (true);
            } catch (error) { data.multipart.error = errorInfo(error); }
            save();
            console.log(JSON.stringify({ phase: 'bucket_complete', bucket, complete: data.complete, objects: data.objects, GB: data.bytes / 1e9,
                byType: data.byType, multipartBytes: data.multipart.bytes, errors: data.errors }));
            for (const client of clients) if (client !== adminClient) client.destroy();
        }
        adminClient?.destroy();
    }
    report.finishedAt = new Date().toISOString();
    report.totals = { objects: report.buckets.reduce((sum, row) => sum + row.objects, 0), bytes: report.buckets.reduce((sum, row) => sum + row.bytes, 0),
        multipartBytes: report.buckets.reduce((sum, row) => sum + (row.multipart?.bytes || 0), 0) };
    save(); console.log(JSON.stringify({ phase: 'finished', ...report.totals, report: path.join(directory, 'inventory-summary.json') }));
}
module.exports = { configurations, clientFor, fileType };
if (require.main === module) main().catch(error => { console.error('R2 inventory failed', errorInfo(error)); process.exitCode = 1; });

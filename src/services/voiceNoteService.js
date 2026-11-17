const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { LIMITS, uploadSchema, referencesSchema, baseType, fail, metadata } = require('../utils/voiceNotes');
const { normalizeVoiceNote } = require('../utils/voiceNoteMedia');

const DAY = 86400000;
const UPLOAD_PREFIX = 'scout-voice-note-uploads/';
// Bound downloads and native decoders across service instances in this process.
// Excess requests retry from their existing local recording; do not queue blobs.
let activeVerifications = 0;
const MAX_VERIFICATIONS = 2;
class VoiceNoteService {
    constructor(prisma, options = {}) {
        this.prisma = prisma;
        this.options = options;
    }
    get assets() { return this.prisma.scoutVoiceNoteAsset; }
    get bucket() { return this.options.bucket || process.env.R2_BUCKET_NAME; }
    get storage() { return this.options.storage || require('../utils/s3Client').getClient(); }
    get configuration() {
        return {
            enabled: Boolean(this.bucket && process.env.SCOUT_VOICE_NOTES_ENABLED === 'true'),
            ...LIMITS,
        };
    }
    requireEnabled() {
        if (!this.configuration.enabled) throw fail('Voice recording is currently unavailable. You can still write notes.', 503);
    }
    requireBucket() {
        if (!this.bucket) {
            throw fail('The warehouse media bucket must be configured.', 503);
        }
    }
    async send(command) {
        return this.storage.send(command, { abortSignal: AbortSignal.timeout(60000) });
    }
    async sign(command, expiresIn, options = {}) {
        this.requireBucket();
        return (this.options.sign || getSignedUrl)(this.storage, command, { ...options, expiresIn });
    }
    async ownAsset(id, scout) {
        let asset = await this.assets.findUnique({ where: { id } });
        if (!asset || asset.scoutId !== scout.id) throw fail('Recording not found.', 404);
        if (['CLAIMED', 'VERIFYING'].includes(asset.state) && asset.leaseUntil < new Date()) {
            await this.assets.updateMany({ where: { id, state: asset.state, operationToken: asset.operationToken, leaseUntil: { lt: new Date() } },
                data: { state: asset.state === 'CLAIMED' ? 'READY' : 'UPLOADING', operationToken: null, leaseUntil: null } });
            asset = await this.assets.findUnique({ where: { id } });
        }
        return asset;
    }
    async begin(input, scout) {
        this.requireEnabled();
        const parsed = uploadSchema.safeParse(input);
        if (!parsed.success) throw fail(parsed.error.issues[0]?.message || 'Invalid recording.');
        const data = parsed.data;
        const identity = { scoutId: scout.id, clientRecordingId: data.clientRecordingId };
        let asset = await this.assets.findUnique({ where: { scoutId_clientRecordingId: identity } });
        if (!asset) {
            const pending = await this.assets.count({
                where: { scoutId: scout.id, state: { in: ['UPLOADING', 'VERIFYING'] }, expiresAt: { gt: new Date() } },
            });
            if (pending >= 30) throw fail('Too many pending recordings. Finish or delete an existing recording first.', 429);
            const id = crypto.randomUUID();
            try {
                asset = await this.assets.create({ data: {
                    ...identity, id, draftId: data.draftId, contentType: data.contentType,
                    expectedSize: data.sizeBytes, uploadKey: UPLOAD_PREFIX + id + '/original',
                    expiresAt: new Date(Date.now() + 7 * DAY),
                } });
            } catch (error) {
                if (error.code !== 'P2002') throw error;
                asset = await this.assets.findUnique({ where: { scoutId_clientRecordingId: identity } });
            }
        }
        if (asset.draftId !== data.draftId || asset.expectedSize !== data.sizeBytes || asset.contentType !== data.contentType) {
            throw fail('This recording changed. Please record a new note.', 409);
        }
        asset = await this.ownAsset(asset.id, scout);
        if (['VERIFYING', 'CLAIMED', 'DELETING'].includes(asset.state)) {
            throw fail('This recording is being processed. Please retry shortly.', 409);
        }
        if (asset.state === 'READY') {
            const renewed = await this.assets.updateMany({ where: { id: asset.id, state: 'READY' },
                data: { expiresAt: new Date(Date.now() + 7 * DAY) } });
            if (!renewed.count) throw fail('Please retry this recording.', 409);
            return { note: metadata(asset) };
        }
        if (['DELETED', 'ABANDONED'].includes(asset.state)) {
            // A restored draft may outlive the abandoned server upload.
            const reset = await this.assets.updateMany({ where: { id: asset.id, state: asset.state }, data: {
                state: 'UPLOADING', uploadKey: UPLOAD_PREFIX + asset.id + '/' + crypto.randomUUID(),
                storageKey: null, sizeBytes: null, durationMs: null, operationToken: null, leaseUntil: null,
                expiresAt: new Date(Date.now() + 7 * DAY),
            } });
            if (!reset.count) throw fail('Please retry this recording.', 409);
            asset = await this.assets.findUnique({ where: { id: asset.id } });
        }
        // Renew before signing, including retries near expiry. Cleanup must not
        // delete this asset while a newly issued PUT URL is still usable.
        const renewed = await this.assets.updateMany({ where: { id: asset.id, state: 'UPLOADING', uploadKey: asset.uploadKey },
            data: { expiresAt: new Date(Date.now() + 7 * DAY) } });
        if (!renewed.count) throw fail('Please retry this recording.', 409);
        const uploadUrl = await this.sign(new PutObjectCommand({
            Bucket: this.bucket, Key: asset.uploadKey, ContentType: asset.contentType, ContentLength: asset.expectedSize,
        }), 360, { signableHeaders: new Set(['content-type', 'content-length']) });
        return { id: asset.id, uploadUrl, contentType: asset.contentType, expiresIn: 360 };
    }
    async complete(id, scout) {
        this.requireEnabled();
        if (activeVerifications >= MAX_VERIFICATIONS) throw fail('Audio processing is busy. Please retry shortly.', 503);
        activeVerifications += 1;
        try { return await this.completeUpload(id, scout); }
        finally { activeVerifications -= 1; }
    }
    async completeUpload(id, scout) {
        const asset = await this.ownAsset(id, scout);
        if (asset.state === 'READY') return metadata(asset);
        const token = crypto.randomUUID();
        const claim = await this.assets.updateMany({ where: {
            id, scoutId: scout.id, expiresAt: { gt: new Date() },
            OR: [{ state: 'UPLOADING' }, { state: 'VERIFYING', leaseUntil: { lt: new Date() } }],
        }, data: { state: 'VERIFYING', operationToken: token, leaseUntil: new Date(Date.now() + 5 * 60000) } });
        if (!claim.count) throw fail('This recording is still processing or has expired. Please retry shortly.', 409);
        const key = 'scout-voice-notes/' + id + '/' + token + '.m4a';
        try {
            const head = await this.send(new HeadObjectCommand({ Bucket: this.bucket, Key: asset.uploadKey }));
            if (!head.ContentLength || head.ContentLength !== asset.expectedSize || head.ContentLength > LIMITS.maxSizeBytes
                || baseType(head.ContentType) !== baseType(asset.contentType)) {
                throw fail('The upload is incomplete or has the wrong format. Please retry.');
            }
            const response = await this.send(new GetObjectCommand({ Bucket: this.bucket, Key: asset.uploadKey }));
            const chunks = [];
            let total = 0;
            // SDK send() resolves at headers; also bound consumption of the body.
            const readDeadline = setTimeout(() => response.Body?.destroy?.(fail('Audio download timed out.', 503)), 60000);
            readDeadline.unref?.();
            try {
                for await (const chunk of response.Body) {
                    total += chunk.length;
                    if (total > LIMITS.maxSizeBytes) throw fail('This recording is too large.');
                    chunks.push(chunk);
                }
            } finally { clearTimeout(readDeadline); response.Body?.destroy?.(); }
            if (total !== asset.expectedSize) throw fail('The upload is incomplete. Please retry.');
            const normalized = await (this.options.normalize || normalizeVoiceNote)(Buffer.concat(chunks));
            // Remember the key before PUT, so interrupted processing is cleanable.
            const active = await this.assets.updateMany({ where: { id, operationToken: token, state: 'VERIFYING' }, data: { storageKey: key } });
            if (!active.count) throw fail('This recording was deleted.', 409);
            await this.send(new PutObjectCommand({
                Bucket: this.bucket, Key: key, Body: normalized.bytes, ContentType: 'audio/mp4',
                CacheControl: 'private, max-age=300',
            }));
            const fields = { state: 'READY', storageKey: key, durationMs: normalized.durationMs,
                sizeBytes: normalized.bytes.length, operationToken: null, leaseUntil: null };
            const completed = await this.assets.updateMany({ where: { id, operationToken: token, state: 'VERIFYING' }, data: fields });
            if (!completed.count) {
                await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
                throw fail('This recording was deleted.', 409);
            }
            // The original key remains tracked until cleanup; a PUT URL can be
            // reused until it expires, so deleting it immediately is insufficient.
            return metadata({ ...asset, ...fields });
        } catch (error) {
            await this.assets.updateMany({ where: { id, operationToken: token, state: 'VERIFYING' },
                data: { state: 'UPLOADING', operationToken: null, leaseUntil: null } });
            if (error.name === 'VoiceNoteError') throw error;
            throw fail('The recording could not be processed. Please retry.', 503);
        }
    }
    async references(id) {
        const where = { scoutVoiceNotes: { array_contains: [{ id }] } };
        const [staged, warehouse] = await Promise.all([
            this.prisma.stagedWarehouse.findFirst({ where }),
            this.prisma.warehouse.findFirst({ where, select: { id: true } }),
        ]);
        return { staged, warehouse };
    }
    async withAttachments(notes, scout, save, submission) {
        if (!notes?.length) return save([]);
        this.requireEnabled();
        const parsed = referencesSchema.safeParse(notes);
        if (!parsed.success) throw fail(parsed.error.issues[0]?.message || 'Invalid voice notes.');
        const token = crypto.randomUUID();
        const claimed = [];
        try {
            for (const note of notes) {
                const asset = await this.ownAsset(note.id, scout);
                if (claimed.length && claimed[0].draftId !== asset.draftId) throw fail('Voice notes belong to different drafts.', 403);
                const claim = await this.assets.updateMany({ where: {
                    id: asset.id, scoutId: scout.id, state: 'READY', expiresAt: { gt: new Date() },
                }, data: { state: 'CLAIMED', operationToken: token, leaseUntil: new Date(Date.now() + 10 * 60000) } });
                if (!claim.count) throw fail('A voice note is not ready. Please retry its upload.', 409);
                claimed.push(asset);
            }
            // A lost submission response must not duplicate a voice-note submission.
            const refs = await this.references(claimed[0].id);
            if (refs.staged) {
                const ids = (refs.staged.scoutVoiceNotes || []).map(note => note.id).sort().join(',');
                const comparable = value => JSON.parse(JSON.stringify({
                    ...value, scoutVoiceNotes: (value.scoutVoiceNotes || []).map(note => ({ id: note.id })),
                }));
                if (ids === claimed.map(asset => asset.id).sort().join(',') &&
                    (!submission || isDeepStrictEqual(comparable(submission), comparable(refs.staged.rawPayload || {})))) return refs.staged;
                throw fail('A voice note has already been submitted.', 409);
            }
            for (const asset of claimed.slice(1)) {
                const refs = await this.references(asset.id);
                if (refs.staged || refs.warehouse) throw fail('A voice note has already been submitted.', 409);
            }
            if (refs.warehouse) throw fail('A voice note has already been submitted.', 409);
            return await save(claimed.map(metadata));
        } finally {
            // Parent references protect committed files even if this release fails.
            if (claimed.length) await this.assets.updateMany({ where: { operationToken: token, state: 'CLAIMED' },
                data: { state: 'READY', operationToken: null, leaseUntil: null } });
        }
    }
    async abandon(id, scout) {
        const asset = await this.ownAsset(id, scout);
        if (asset.state === 'DELETED') return;
        const refs = await this.references(id);
        if (refs.staged || refs.warehouse) throw fail('This voice note has already been submitted.', 409);
        const changed = await this.assets.updateMany({ where: { id, state: { in: ['UPLOADING', 'VERIFYING', 'READY', 'ABANDONED'] } },
            data: { state: 'ABANDONED', operationToken: null, leaseUntil: null, expiresAt: new Date(Date.now() + 10 * 60000) } });
        if (!changed.count) throw fail('This voice note is being saved. Please retry shortly.', 409);
    }
    async playback(recordId, noteId, staged = false) {
        if (!this.bucket) throw fail('Voice-note playback is temporarily unavailable.', 503);
        const table = staged ? this.prisma.stagedWarehouse : this.prisma.warehouse;
        const row = await table.findUnique({ where: { id: recordId }, select: { scoutVoiceNotes: true } });
        const note = row?.scoutVoiceNotes?.find(note => note.id === noteId);
        if (!note?.storageKey) throw fail('Voice note not found.', 404);
        const url = await this.sign(new GetObjectCommand({
            Bucket: this.bucket, Key: note.storageKey, ResponseContentType: 'audio/mp4',
            ResponseCacheControl: 'private, max-age=300',
        }), 600);
        return { url, expiresAt: new Date(Date.now() + 600000).toISOString() };
    }
    async ownPlayback(id, scout) {
        this.requireBucket();
        const asset = await this.ownAsset(id, scout);
        if (asset.state !== 'READY' || !asset.storageKey || asset.expiresAt < new Date()) {
            throw fail('This recording is unavailable. Please retry its upload.', 404);
        }
        const refs = await this.references(id);
        if (refs.staged || refs.warehouse) throw fail('Recording not found.', 404);
        const url = await this.sign(new GetObjectCommand({ Bucket: this.bucket, Key: asset.storageKey,
            ResponseContentType: 'audio/mp4', ResponseCacheControl: 'private, max-age=300' }), 600);
        return { url, expiresAt: new Date(Date.now() + 600000).toISOString() };
    }
    async cleanup({ limit = 100 } = {}) {
        this.requireBucket();
        const now = new Date();
        const candidates = await this.assets.findMany({ where: {
            state: { not: 'DELETED' }, expiresAt: { lt: now },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        }, take: limit, orderBy: { expiresAt: 'asc' } });
        let deleted = 0;
        let failed = 0;
        for (const asset of candidates) {
            const token = crypto.randomUUID();
            const locked = await this.assets.updateMany({ where: {
                id: asset.id, state: asset.state, updatedAt: asset.updatedAt, expiresAt: { lt: now },
                OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
            }, data: { state: 'DELETING', operationToken: token, leaseUntil: new Date(Date.now() + 5 * 60000) } });
            if (!locked.count) continue;
            try {
                const deleteSend = async command => {
                    // A large prefix or slow storage can outlive the initial
                    // lease. Renew ownership before each bounded storage call;
                    // an old worker must stop if another sweep took its claim.
                    const renewed = await this.assets.updateMany({ where: {
                        id: asset.id, state: 'DELETING', operationToken: token, leaseUntil: { gt: new Date() },
                    }, data: { leaseUntil: new Date(Date.now() + 5 * 60000) } });
                    if (!renewed.count) throw fail('Voice-note cleanup lease expired.', 409);
                    return this.send(command);
                };
                const refs = await this.references(asset.id);
                const referenced = refs.staged || refs.warehouse;
                // Include superseded upload/normalization attempts left by a
                // process interruption. Every prefix belongs to this asset alone.
                for (const prefix of [UPLOAD_PREFIX + asset.id + '/', 'scout-voice-notes/' + asset.id + '/']) {
                    let continuation;
                    do {
                        const page = await deleteSend(new ListObjectsV2Command({
                            Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuation,
                        }));
                        for (const object of page.Contents || []) {
                            if (referenced && object.Key === asset.storageKey) continue;
                            await deleteSend(new DeleteObjectCommand({ Bucket: this.bucket, Key: object.Key }));
                        }
                        continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
                    } while (continuation);
                }
                if (referenced) {
                    // Remove the temporary original only after its upload URL expired.
                    await deleteSend(new DeleteObjectCommand({ Bucket: this.bucket, Key: asset.uploadKey }));
                    await this.assets.updateMany({ where: { id: asset.id, operationToken: token },
                        data: { state: 'READY', operationToken: null, leaseUntil: null, expiresAt: new Date(Date.now() + 7 * DAY) } });
                    continue;
                }
                for (const key of new Set([asset.uploadKey, asset.storageKey].filter(Boolean))) {
                    await deleteSend(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
                }
                await this.assets.updateMany({ where: { id: asset.id, operationToken: token },
                    data: { state: 'DELETED', operationToken: null, leaseUntil: null } });
                deleted += 1;
            } catch (error) {
                // Keep the deletion claim for a later run; don't make a partially
                // deleted object attachable again.
                console.error('Voice-note cleanup failed', { id: asset.id, name: error.name });
                failed += 1;
            }
        }
        return { checked: candidates.length, deleted, failed };
    }
}
module.exports = VoiceNoteService;

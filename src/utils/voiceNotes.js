const { z } = require('zod');

const LIMITS = Object.freeze({ maxRecordings: 1, maxDurationMs: 5 * 60 * 1000, maxSizeBytes: 10 * 1024 * 1024 });
const TYPES = new Set(['audio/webm', 'audio/mp4', 'audio/ogg']);
const baseType = value => String(value || '').split(';')[0].trim().toLowerCase();
const referencesSchema = z.array(z.object({ id: z.string().uuid() }).passthrough())
    .max(LIMITS.maxRecordings, 'Only one voice recording is allowed')
    .refine(notes => new Set(notes.map(note => note.id)).size === notes.length, 'Duplicate voice notes are not allowed');
const uploadSchema = z.object({
    clientRecordingId: z.string().uuid(),
    draftId: z.string().uuid(),
    contentType: z.string().max(120).refine(value => TYPES.has(baseType(value)), 'Unsupported recording format'),
    sizeBytes: z.number().int().positive().max(LIMITS.maxSizeBytes),
});
const fail = (message, statusCode = 400) => Object.assign(new Error(message), {
    name: statusCode === 404 ? 'NotFoundError' : statusCode === 403 ? 'ForbiddenError' : 'VoiceNoteError',
    statusCode,
});
const metadata = asset => ({
    id: asset.id, storageKey: asset.storageKey, contentType: 'audio/mp4',
    durationMs: asset.durationMs, sizeBytes: asset.sizeBytes,
    createdAt: new Date(asset.createdAt).toISOString(),
});

// Editors can retain or remove existing notes, but cannot attach a different
// record's audio or overwrite canonical metadata supplied by the upload service.
function retainVoiceNotes(payload, existing = {}) {
    if (!Object.hasOwn(payload, 'scoutVoiceNotes')) return payload;
    const requested = payload.scoutVoiceNotes || [];
    const current = new Map((existing.scoutVoiceNotes || []).map(note => [note.id, note]));
    payload.scoutVoiceNotes = requested.map(note => {
        if (!current.has(note.id)) throw fail('This voice note is not attached to this record.', 403);
        return current.get(note.id);
    });
    return payload;
}

module.exports = { LIMITS, TYPES, baseType, referencesSchema, uploadSchema, fail, metadata, retainVoiceNotes };

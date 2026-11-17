const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { LIMITS, fail } = require('./voiceNotes');
const run = promisify(execFile);

// Work only on the bounded, downloaded bytes; a later PUT to the temporary R2
// object cannot change the content that we validate and publish.
async function normalizeVoiceNote(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.maxSizeBytes) {
        throw fail('This recording is empty or too large.');
    }
    const dir = await mkdtemp(join(tmpdir(), 'scout-voice-'));
    try {
        const input = join(dir, 'recording');
        const output = join(dir, 'recording.m4a');
        await writeFile(input, bytes);
        const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
            '-v', 'error', '-max_alloc', '33554432', '-threads', '1', '-protocol_whitelist', 'file,pipe',
            '-format_whitelist', 'matroska,webm,mov,ogg',
            '-show_entries', 'format=duration:stream=codec_type,codec_name:packet=pts_time,duration_time',
            '-show_packets', '-of', 'json', input,
        ], { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
        const probe = JSON.parse(stdout);
        if (probe.streams?.length !== 1 || probe.streams.some(stream => stream.codec_type !== 'audio')) {
            throw fail('Please record an audio-only voice note.');
        }
        let start = Infinity;
        let end = -Infinity;
        for (const packet of probe.packets || []) {
            const timestamp = Number(packet.pts_time);
            if (!Number.isFinite(timestamp)) continue;
            start = Math.min(start, timestamp);
            end = Math.max(end, timestamp + (Number(packet.duration_time) || 0));
        }
        const durationMs = Math.round(Math.max(Number(probe.format?.duration) || 0, end - start) * 1000);
        // Codec padding can extend a recording slightly beyond the UI's timer.
        if (durationMs < 100 || durationMs > LIMITS.maxDurationMs + 1000) {
            throw fail(`Voice notes must contain audio and be no longer than ${LIMITS.maxDurationMs / 60000} minutes.`);
        }
        await run(process.env.FFMPEG_PATH || 'ffmpeg', [
            '-v', 'error', '-nostdin', '-max_alloc', '33554432', '-threads', '1',
            '-filter_threads', '1', '-filter_complex_threads', '1', '-protocol_whitelist', 'file,pipe',
            '-format_whitelist', 'matroska,webm,mov,ogg', '-i', input,
            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'aac', '-threads', '1',
            '-b:a', '64k', '-t', String(LIMITS.maxDurationMs / 1000), '-movflags', '+faststart', '-y', output,
        ], { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
        const normalized = await readFile(output);
        if (!normalized.length || normalized.length > LIMITS.maxSizeBytes) throw fail('The recording could not be prepared. Please record it again.');
        return { bytes: normalized, durationMs: Math.min(durationMs, LIMITS.maxDurationMs) };
    } catch (error) {
        if (error.name === 'VoiceNoteError') throw error;
        if (error.code === 'ENOENT') throw fail('Voice recording processing is unavailable. Please try again later.', 503);
        throw fail('This recording could not be read. Please record it again.');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
module.exports = { normalizeVoiceNote };

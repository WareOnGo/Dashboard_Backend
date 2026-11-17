const { execFileSync } = require('node:child_process');
const { normalizeVoiceNote } = require('../../src/utils/voiceNoteMedia');
const { readFileSync } = require('node:fs');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test.each(['chrome-opus.mp4', 'chrome-opus.webm'])('accepts actual browser capture %s', async filename => {
    const input = readFileSync(path.join(__dirname, '../fixtures/voice-notes', filename));
    const result = await normalizeVoiceNote(input);
    expect(result.durationMs).toBeGreaterThan(1000);
    expect(result.durationMs).toBeLessThan(4000);
    expect(result.bytes.length).toBeGreaterThan(0);
});

test.each(['webm', 'mp4'])('normalizes real %s recordings to seekable mono AAC', async format => {
    const input = execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:a', format === 'webm' ? 'libopus' : 'aac',
        ...(format === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov'] : []),
        '-f', format, 'pipe:1',
    ]);
    const normalized = await normalizeVoiceNote(input);
    expect(normalized.durationMs).toBeGreaterThanOrEqual(900);
    expect(normalized.durationMs).toBeLessThan(1200);
    const output = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels:format=duration', '-of', 'json', 'pipe:0'], { input: normalized.bytes }).toString());
    expect(output.streams[0]).toMatchObject({ codec_name: 'aac', channels: 1 });
    expect(Number(output.format.duration)).toBeGreaterThan(0);
});
test('rejects a non-audio payload despite its declared audio MIME type', async () => {
    await expect(normalizeVoiceNote(Buffer.from('<html>not audio</html>'))).rejects.toThrow('could not be read');
});
test('rejects recordings over the duration limit from actual media timing', async () => {
    const input = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=302', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
    await expect(normalizeVoiceNote(input)).rejects.toThrow('no longer than 5 minutes');
}, 30000);
test('preserves the full five-minute recording when normalizing playback audio', async () => {
    const input = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
    const normalized = await normalizeVoiceNote(input);
    expect(normalized.durationMs).toBe(300000);
    // Fast-start metadata lets ffprobe exit before a large stdin pipe is drained.
    // A file also exercises the seekable output as a real player would read it.
    const dir = await mkdtemp(path.join(tmpdir(), 'scout-voice-duration-test-'));
    try {
        const filename = path.join(dir, 'five-minutes.m4a');
        await writeFile(filename, normalized.bytes);
        const output = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filename]).toString());
        expect(Number(output.format.duration)).toBeGreaterThanOrEqual(299.9);
        expect(Number(output.format.duration)).toBeLessThanOrEqual(300.1);
    } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

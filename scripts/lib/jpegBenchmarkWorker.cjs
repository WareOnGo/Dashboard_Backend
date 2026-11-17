// Local-only benchmark. Produces no remote writes and inherits no credentials.
const sharp = require('sharp');
const { performance } = require('node:perf_hooks');
sharp.cache(false);
sharp.concurrency(1);
const [input, outputBase] = process.argv.slice(2);
const presets = [
    { name: 'jpeg-1280-q80', width: 1280, quality: 80, format: 'jpeg' },
    { name: 'jpeg-1920-q82', width: 1920, quality: 82, format: 'jpeg' },
    { name: 'jpeg-2560-q85', width: 2560, quality: 85, format: 'jpeg' },
    { name: 'webp-1280-q75', width: 1280, quality: 75, format: 'webp' },
];
(async () => {
    const options = { limitInputPixels: 16000000, sequentialRead: true, failOn: 'error' };
    const metadata = await sharp(input, options).metadata();
    const variants = [];
    for (const preset of presets) {
        const started = performance.now();
        let pipeline = sharp(input, options).timeout({ seconds: 15 }).rotate()
            .resize({ width: preset.width, height: preset.width, fit: 'inside', withoutEnlargement: true });
        if (preset.format === 'jpeg') pipeline = pipeline.flatten({ background: '#fff' })
            .jpeg({ quality: preset.quality, progressive: true, chromaSubsampling: '4:2:0' });
        else pipeline = pipeline.webp({ quality: preset.quality });
        const file = `${outputBase}-${preset.name}.${preset.format === 'jpeg' ? 'jpg' : 'webp'}`;
        const info = await pipeline.toFile(file);
        const encodeMs = performance.now() - started;
        // Validate the actual produced bytes rather than counting a buffer alone.
        const check = await sharp(file).metadata();
        if (check.format !== preset.format || !info.size || info.width > preset.width || info.height > preset.width) {
            throw new Error('invalid_output');
        }
        variants.push({ ...preset, bytes: info.size, encodeMs,
            outputWidth: info.width, outputHeight: info.height });
    }
    console.log(JSON.stringify({ ok: true, bytes: variants.reduce((sum, result) => sum + result.bytes, 0),
        peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
        original: { format: metadata.format, width: metadata.width, height: metadata.height,
            orientation: metadata.orientation ?? 1, hasAlpha: metadata.hasAlpha }, variants }));
})().catch(error => {
    console.log(JSON.stringify({ ok: false, reason: /pixel limit/i.test(error.message) ? 'source_too_many_pixels' : 'source_benchmark_failed' }));
    process.exitCode = 1;
});

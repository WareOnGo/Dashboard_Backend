// Manual recovery only: accept JPEG decoder warnings but reject errors,
// truncated pixel data and invalid metadata. The normal service stays strict.
// The parent runs this in its usual isolated, memory-limited child process.
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
const [input, output, rawWidth, rawQuality] = process.argv.slice(2);
(async () => {
    const width = Number(rawWidth), quality = Number(rawQuality);
    if (!input || !output || !Number.isInteger(width) || width < 320 || width > 2560
        || !Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('invalid_options');
    const options = { failOn: 'error', limitInputPixels: 16000000, sequentialRead: true };
    if ((await sharp(input, options).metadata()).format !== 'jpeg') throw new Error('not_jpeg');
    const result = await sharp(input, options).timeout({ seconds: 15 }).rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality }).toFile(output);
    console.log(JSON.stringify({ ok: true, bytes: result.size, peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
})().catch(() => {
    console.log(JSON.stringify({ ok: false, reason: 'source_jpeg_recovery_failed' }));
    process.exitCode = 1;
});

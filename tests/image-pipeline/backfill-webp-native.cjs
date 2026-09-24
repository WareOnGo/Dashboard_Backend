const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const sharp = require('sharp');
const site = process.env.IMAGE_PIPELINE_WEBSITE_ROOT || path.resolve(__dirname, '../../../../website_combined/WareOnGo-Website-Backend');
const workerPath = path.resolve(__dirname, '../../scripts/lib/webpJpegRecoveryWorker.cjs');

test('manual JPEG recovery accepts a scan warning and still rejects truncation and other formats', async () => {
    const { convertImageFile } = await import(pathToFileURL(path.join(site, 'services/webpImageProcess.js')));
    const directory = await mkdtemp(path.join(tmpdir(), 'webp-recovery-test-'));
    const input = path.join(directory, 'source'), output = path.join(directory, 'output.webp');
    const signal = new AbortController().signal, config = { width: 1280, quality: 75 };
    const convert = () => convertImageFile(input, output, config, signal, { workerPath });
    try {
        const jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3,
            background: { r: 80, g: 100, b: 160 } } }).jpeg({ progressive: false }).toBuffer();
        const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
        assert.ok(scan > 0);
        const parameters = scan + 5 + 2 * jpeg[scan + 4];
        assert.equal(jpeg[parameters + 1], 63);
        // Sequential JPEG convention is Ss=0, Se=63. Some encoders emit Se=0,
        // causing the recoverable warning observed in two existing originals.
        jpeg[parameters + 1] = 0;
        await writeFile(input, jpeg);
        await assert.rejects(convertImageFile(input, output, config, signal), /source_conversion_failed/);
        await convert();
        const metadata = await sharp(output).metadata();
        assert.equal(metadata.format, 'webp');
        assert.equal(metadata.width, 1280);
        assert.equal(metadata.height, 720);
        await writeFile(input, jpeg.subarray(0, jpeg.length - 20));
        await assert.rejects(convert(), /source_jpeg_recovery_failed/);
        await writeFile(input, await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer());
        await assert.rejects(convert(), /source_jpeg_recovery_failed/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

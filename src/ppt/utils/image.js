const axios = require('axios');

// sharp is a native (libvips) module used to bake EXIF orientation into the
// pixels. Load it lazily and tolerate its absence: if the binary ever fails to
// resolve (e.g. a musl/Alpine build hiccup), we fall back to embedding the raw
// bytes — exactly the pre-normalisation behaviour — so a deploy can never be
// bricked by the image-rotation feature.
const sharp = (() => {
    try { return require('sharp'); } catch (_) { return null; }
})();

// Decode pixel dimensions from the file's own header bytes. pptxgenjs's
// `sizing.cover` path uses the addImage call's top-level w/h as the *source*
// image dimensions when computing the crop rect — so if we pass the box w/h at
// the top level (matching `sizing.w/h`), every crop percentage works out to
// zero and the image stretches instead of cropping. Reading the real source
// dimensions lets us pass the true aspect ratio at the top level while still
// pinning the placement via `sizing`.
const readImageDimensions = (buf) => {
    if (!buf || buf.length < 24) return null;
    // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF: width/height at offset 6, little-endian uint16.
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // WebP (VP8/VP8L/VP8X) inside RIFF container.
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        const fourCC = buf.slice(12, 16).toString('ascii');
        if (fourCC === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3FFF, h: buf.readUInt16LE(28) & 0x3FFF };
        if (fourCC === 'VP8L') {
            const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
            return { w: 1 + (((b1 & 0x3F) << 8) | b0), h: 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)) };
        }
        if (fourCC === 'VP8X') return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    }
    // JPEG: walk markers until SOF (0xC0–0xCF, excluding DHT/DAC/DRI), read 16-bit height then width.
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let i = 2;
        while (i < buf.length - 9) {
            if (buf[i] !== 0xFF) return null;
            const marker = buf[i + 1];
            if (marker === 0xD8 || marker === 0xD9) return null;
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
    }
    return null;
};

// Cheap EXIF Orientation read — scans the JPEG APP1/Exif segment for tag 0x0112
// without decoding any pixels. Returns 1..8, or null when absent / not a JPEG.
// (Only JPEGs from cameras/phones carry this; PNG/WebP here effectively never do.)
const readExifOrientation = (buf) => {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i < buf.length - 4) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD9 || marker === 0xDA) break; // EOI or start of scan
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xE1) { // APP1
            const seg = buf.slice(i + 4, i + 2 + len);
            if (seg.slice(0, 6).toString('ascii') === 'Exif\0\0') {
                const tiff = seg.slice(6);
                const le = tiff.slice(0, 2).toString('ascii') === 'II';
                const rd16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
                const rd32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
                try {
                    const ifd0 = rd32(4);
                    const n = rd16(ifd0);
                    for (let e = 0; e < n; e++) {
                        const off = ifd0 + 2 + e * 12;
                        if (rd16(off) === 0x0112) return rd16(off + 8);
                    }
                } catch (_) { return null; }
                return null;
            }
        }
        i += 2 + len;
    }
    return null;
};

// Turn raw image bytes into a base64 data URI, baking in EXIF orientation when
// present. Phone field-uploads (e.g. "scout_" photos) store landscape pixels
// plus an EXIF Orientation tag telling viewers to rotate; PowerPoint and
// LibreOffice ignore that tag, so the image renders sideways. We re-encode ONLY
// when the tag actually calls for it (orientation 2..8), so the common
// already-upright case is never decoded/re-encoded. Returns { data, dims },
// where dims reflects the corrected (rotated) dimensions.
const normalizeImageBuffer = async (buffer, url = '') => {
    let mime = url.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
    const orientation = mime === 'image/jpeg' ? readExifOrientation(buffer) : null;
    if (sharp && orientation && orientation !== 1) {
        try {
            // .rotate() with no angle auto-applies EXIF orientation and strips the
            // tag; the re-encoded buffer then reports its corrected dimensions,
            // which also fixes the cover-crop aspect ratio downstream.
            buffer = await sharp(buffer).rotate().jpeg({ quality: 85 }).toBuffer();
            mime = 'image/jpeg';
        } catch (_) { /* keep the original bytes if normalisation fails */ }
    }
    return { data: `data:${mime};base64,${buffer.toString('base64')}`, dims: readImageDimensions(buffer) };
};

// Download a remote image and return its orientation-normalised data URI + dims.
// `axiosOptions` is merged into the request (callers can pass timeout/headers).
const fetchImage = async (url, axiosOptions = {}) => {
    const response = await axios.get(url, { responseType: 'arraybuffer', ...axiosOptions });
    return normalizeImageBuffer(Buffer.from(response.data), url);
};

module.exports = { fetchImage, normalizeImageBuffer, readImageDimensions, readExifOrientation };

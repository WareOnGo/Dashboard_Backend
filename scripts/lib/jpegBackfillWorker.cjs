// Isolated native decoder; receives paths and settings, never application credentials.
const sharp = require('sharp');
const fs = require('node:fs/promises');
sharp.cache(false); sharp.concurrency(1);
const [input, output, mode, rawEdge] = process.argv.slice(2);
const edge = Number(rawEdge);
(async () => {
    if (![1280,1920].includes(edge) || !['inspect','compress'].includes(mode)) throw new Error('source_invalid_options');
    const options = { limitInputPixels: 16000000, sequentialRead: true, failOn: 'error' };
    const m = await sharp(input, options).metadata();
    const metadata = { format:m.format,width:m.width,height:m.height,orientation:m.orientation,space:m.space,pages:m.pages };
    if ((m.pages || 1) > 1) throw new Error('source_animated_or_multipage');
    const bytes = (await fs.stat(input)).size;
    if (mode === 'inspect') {
        // Only likely passthrough files need a full decode during the first pass.
        if (m.format === 'jpeg' && m.width <= edge && m.height <= edge
            && (!m.orientation || m.orientation === 1) && ['srgb','b-w'].includes(m.space)) {
            await sharp(input, options).timeout({seconds:15}).stats();
        }
        console.log(JSON.stringify({ok:true,bytes,metadata,peakRssMiB:Math.ceil(process.resourceUsage().maxRSS/1024)}));
        return;
    }
    const info = await sharp(input, options).timeout({seconds:15}).rotate()
        .resize({width:edge,height:edge,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'})
        .jpeg({quality:82,progressive:true,chromaSubsampling:'4:2:0'}).toFile(output);
    const check = await sharp(output).metadata();
    if (check.format !== 'jpeg' || !info.size || info.width > edge || info.height > edge
        || (check.orientation && check.orientation !== 1)) throw new Error('source_invalid_jpeg_output');
    console.log(JSON.stringify({ok:true,bytes,metadata,jpegBytes:info.size,width:info.width,height:info.height,
        peakRssMiB:Math.ceil(process.resourceUsage().maxRSS/1024)}));
})().catch(error => {
    const reason = /^source_[a-z_]+$/.test(error.message) ? error.message
        : /pixel limit/i.test(error.message) ? 'source_too_many_pixels' : 'source_decode_failed';
    console.log(JSON.stringify({ok:false,reason})); process.exitCode=1;
});

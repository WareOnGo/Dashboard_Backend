const { fetchImage } = require('../ppt/utils/image');
const { logWarn } = require('../ppt/utils/logger');

const LOOKUP_TIMEOUT_MS = 3000;
const WEBP_TIMEOUT_MS = 5000;
const ORIGINAL_TIMEOUT_MS = 10000;

async function withLookupTimeout(pending) {
    let timer;
    try {
        return await Promise.race([
            pending,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Image registry lookup timed out')), LOOKUP_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** One exact-URL lookup and one cached fetch/fallback per original per export. */
async function createPptImageLoader(prisma, originalUrls, stats = {}) {
    Object.assign(stats, { webpImages: 0, originalFallbacks: 0, failedImages: 0, registryLookupFailed: false });
    const urls = [...new Set(originalUrls.filter(url => typeof url === 'string' && url))];
    let variants = new Map();
    if (urls.length) {
        try {
            const rows = await withLookupTimeout(prisma.labeledWarehouseImage.findMany({
                where: { imageUrl: { in: urls }, webpUrl: { not: null } },
                select: { imageUrl: true, webpUrl: true },
            }));
            // webpUrl is the last published result. A later processing retry
            // must not hide a still-usable variant, matching the image API.
            variants = new Map(rows.filter(row => /^https?:\/\//i.test(row.webpUrl))
                .map(row => [row.imageUrl, row.webpUrl]));
        } catch {
            stats.registryLookupFailed = true;
            logWarn('pptImageService', 'lookup', 'WebP lookup unavailable; using originals');
        }
    }

    const images = new Map();
    return (originalUrl, axiosOptions = {}) => {
        if (!images.has(originalUrl)) {
            images.set(originalUrl, (async () => {
                const webpUrl = variants.get(originalUrl);
                if (webpUrl) {
                    try {
                        const image = await fetchImage(webpUrl, {
                            ...axiosOptions, timeout: WEBP_TIMEOUT_MS,
                            signal: AbortSignal.timeout(WEBP_TIMEOUT_MS), maxContentLength: 20 * 1024 * 1024,
                        }, { validateWebp: true });
                        stats.webpImages++;
                        return image;
                    } catch { /* missing, slow or corrupt variant: try this exact original */ }
                }
                try {
                    const image = await fetchImage(originalUrl, {
                        ...axiosOptions, timeout: ORIGINAL_TIMEOUT_MS,
                        signal: AbortSignal.timeout(ORIGINAL_TIMEOUT_MS),
                    });
                    stats.originalFallbacks++;
                    return image;
                } catch (error) {
                    stats.failedImages++;
                    throw error; // Existing slide placeholder/skip behaviour.
                }
            })());
        }
        return images.get(originalUrl);
    };
}

module.exports = { createPptImageLoader };

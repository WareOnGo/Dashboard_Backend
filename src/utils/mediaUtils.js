// src/utils/mediaUtils.js

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];

/**
 * Get the file extension from a URL (lowercase, without dot)
 * @param {string} url
 * @returns {string}
 */
function getExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    return dot !== -1 ? pathname.slice(dot + 1).toLowerCase() : '';
  } catch {
    // Fallback for bare paths / malformed URLs
    const dot = url.lastIndexOf('.');
    return dot !== -1 ? url.slice(dot + 1).toLowerCase().split(/[?#]/)[0] : '';
  }
}

/**
 * Convert a comma-separated `photos` string into the `media` JSONB shape.
 * @param {string|null|undefined} photos - CSV string of URLs
 * @returns {{ images: string[], videos: string[], docs: string[] }}
 */
function photosToMedia(photos) {
  const media = { images: [], videos: [], docs: [] };
  if (!photos || typeof photos !== 'string') return media;

  const urls = photos.split(',').map(u => u.trim()).filter(Boolean);

  for (const url of urls) {
    const ext = getExtension(url);
    if (VIDEO_EXTENSIONS.includes(ext)) {
      media.videos.push(url);
    } else if (DOC_EXTENSIONS.includes(ext)) {
      media.docs.push(url);
    } else {
      // Default to images (including unknown extensions) to preserve existing behaviour
      media.images.push(url);
    }
  }

  return media;
}

/**
 * Flatten a `media` JSONB object back into a comma-separated string
 * (for the legacy `photos` column during double-write).
 * @param {{ images?: string[], videos?: string[], docs?: string[] } | null} media
 * @returns {string|null}
 */
function mediaToPhotos(media) {
  if (!media) return null;
  const all = [
    ...(media.images || []),
    ...(media.videos || []),
    ...(media.docs || []),
  ];
  return all.length > 0 ? all.join(',') : null;
}

module.exports = { photosToMedia, mediaToPhotos };

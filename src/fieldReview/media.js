const { z } = require('zod');
const { mediaToPhotos } = require('../utils/mediaUtils');

const kinds = ['images', 'videos', 'docs'];
const emptyMedia = () => ({ images: [], videos: [], docs: [] });
const decode = value => {
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
};
function warehouseMedia(warehouse) {
  const media = decode(warehouse?.media), legacy = emptyMedia();
  const photos = decode(warehouse?.photos);
  for (const entry of Array.isArray(photos) ? photos : [photos]) {
    if (typeof entry !== 'string') continue;
    for (const url of entry.split(/,\s*(?=https?:\/\/)|,\s+(?![^,]*\/)/i).map(s => s.trim()).filter(Boolean)) {
      const path = url.split(/[?#]/)[0];
      const kind = /\.(mp4|mov|avi|mkv|webm)$/i.test(path) ? 'videos' : /\.(pdf|docx?|xlsx?)$/i.test(path) ? 'docs' : 'images';
      legacy[kind].push(url);
    }
  }
  return Object.fromEntries(kinds.map(kind => [kind, [...new Set((Array.isArray(media?.[kind]) ? media[kind] : legacy[kind])
    .filter(url => typeof url === 'string' && url.trim()))]]));
}
const urls = media => kinds.flatMap(kind => media?.[kind] || []);
const mimeKind = mime => mime?.startsWith('image/') ? 'images' : mime?.startsWith('video/') ? 'videos' : 'docs';
const urlSchema = z.string().max(4096).url().refine(value => /^https?:\/\//i.test(value) && !new URL(value).username && !new URL(value).password, 'Use an HTTP or HTTPS file URL.');
const mediaSchema = z.object(Object.fromEntries(kinds.map(kind => [kind, z.array(urlSchema).max(200)]))).strict();
function parseMedia(value) {
  const media = mediaSchema.parse(value), all = urls(media);
  if (all.length > 200) throw new Error('A proposed gallery can contain at most 200 files.');
  if (new Set(all).size !== all.length) throw new Error('Select each file only once.');
  return media;
}
function mediaPatch(media) {
  return { media, photos: mediaToPhotos(media) };
}
module.exports = { kinds, emptyMedia, warehouseMedia, mimeKind, parseMedia, mediaPatch };

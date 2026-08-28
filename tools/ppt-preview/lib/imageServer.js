const http = require('http');
const { photoBuffer } = require('./images');

/**
 * Local origin for fixture photographs.
 *
 * Exists so the deck builders' real image path runs: they fetch every photo with
 * axios through `src/ppt/utils/image.js`, and stubbing that out would skip the
 * EXIF normalisation and header-parsing that decide how a photo lands on a
 * slide. Serving them instead keeps all of it in play, offline and identical
 * every run.
 *
 * Routes, all under /photo:
 *   /photo/<label>.jpg            a JPEG
 *   /photo/<label>.png            a PNG
 *   /photo/<label>.jpg?rotate=6   a JPEG carrying EXIF Orientation 6
 *   /photo/<label>.jpg?status=404 a refusal, for the missing-photo path
 *   /photo/<label>.jpg?delay=ms   a slow response
 */
async function startImageServer({ port = 4901, host = '127.0.0.1' } = {}) {
  /** Every photo request the deck builders made. */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const match = url.pathname.match(/^\/photo\/([^/]+)\.(jpg|jpeg|png)$/);

    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not a photo route');
      return;
    }

    const [, label, extension] = match;
    const status = Number(url.searchParams.get('status') || 200);
    const delay = Number(url.searchParams.get('delay') || 0);
    const orientation = Number(url.searchParams.get('rotate') || 0) || undefined;

    requests.push({ path: url.pathname + url.search, label, status, orientation });

    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`fixture photo refused with ${status}`);
      return;
    }

    try {
      const format = extension === 'png' ? 'png' : 'jpeg';
      const body = await photoBuffer({ label, format, orientation });
      res.writeHead(200, {
        'Content-Type': format === 'png' ? 'image/png' : 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`fixture photo failed: ${error.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    baseUrl: `http://${host}:${server.address().port}`,
    host,
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startImageServer };

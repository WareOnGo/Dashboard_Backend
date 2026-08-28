const http = require('http');
const https = require('https');

/**
 * Refuse outbound HTTP the harness has not allow-listed.
 *
 * The detailed deck enriches every warehouse from Google Maps, Mapbox, Nominatim
 * and Overpass. Left alone in a local run that traffic makes the harness slow
 * (each miss waits out a 10s+ axios timeout), non-deterministic (a deck's
 * content then depends on what Overpass returned today) and quietly dependent on
 * the internet. Blocking it at the socket layer instead means the enrichment
 * failure path — which is already wrapped in try/catch and expected in
 * production — runs immediately.
 *
 * The point is not only to block: the attempts are recorded, so a run reports
 * exactly which third parties a variant reaches for and how often. That is
 * information about the deck builders that nothing else in the repo surfaces.
 *
 * Patches http/https at the module level, which is where axios's Node adapter
 * ends up regardless of how it is configured. Call `restore()` when done.
 */
function installNetGuard({ allowHosts = ['127.0.0.1', 'localhost'] } = {}) {
  const attempts = [];
  const allowed = new Set(allowHosts);

  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  /** Pull the host out of whatever shape the caller used. */
  const hostOf = (args) => {
    const [first] = args;
    if (typeof first === 'string') {
      try { return new URL(first).hostname; } catch { return first; }
    }
    if (first instanceof URL) return first.hostname;
    if (first && typeof first === 'object') return first.hostname || first.host || '';
    return '';
  };

  const guard = (original, scheme) => function guarded(...args) {
    const host = String(hostOf(args)).replace(/:\d+$/, '');
    if (allowed.has(host)) return original.apply(this, args);

    attempts.push({ scheme, host, at: attempts.length });

    // Thrown synchronously rather than emitted as a socket error: axios calls
    // transport.request inside its promise executor, so this rejects the caller's
    // promise immediately instead of after a timeout.
    const error = new Error(
      `[ppt-preview] blocked ${scheme}://${host} — outbound network is disabled in this run`,
    );
    error.code = 'EHARNESSBLOCKED';
    throw error;
  };

  http.request = guard(originals.httpRequest, 'http');
  http.get = guard(originals.httpGet, 'http');
  https.request = guard(originals.httpsRequest, 'https');
  https.get = guard(originals.httpsGet, 'https');

  return {
    attempts,
    /** Blocked hosts with a count each, most-contacted first. */
    summary() {
      const counts = new Map();
      for (const attempt of attempts) {
        counts.set(attempt.host, (counts.get(attempt.host) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count);
    },
    restore() {
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
    },
  };
}

module.exports = { installNetGuard };

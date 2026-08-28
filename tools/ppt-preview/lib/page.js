/**
 * The contact sheet the preview server serves.
 *
 * Plain string templating on purpose: this page is a dev tool that has to work
 * with no build step, no network and no dependencies, and it needs to still work
 * when the deck it is describing failed to generate.
 */

const escapeHtml = (value) => String(value ?? '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;

function renderDeck(deck) {
  if (deck.error) {
    return `
      <section class="deck">
        <header><h2>${escapeHtml(deck.label)}</h2>
        <span class="badge bad">generation failed</span></header>
        <pre class="error">${escapeHtml(deck.error)}</pre>
      </section>`;
  }

  const countTone = deck.slideCount === deck.expectedSlides ? 'ok' : 'bad';
  const badges = [
    `<span class="badge ${countTone}">${deck.slideCount} slides (expected ${deck.expectedSlides})</span>`,
    `<span class="badge">${deck.media.length} embedded images</span>`,
    `<span class="badge">${kb(deck.bytes)}</span>`,
    `<span class="badge">generate ${deck.generateMs}ms</span>`,
    deck.renderMs ? `<span class="badge">render ${deck.renderMs}ms</span>` : '',
    deck.leaks.length ? `<span class="badge bad">${deck.leaks.length} placeholder leak(s)</span>` : '',
    deck.slides.some((s) => s.blank) ? `<span class="badge bad">blank slide(s)</span>` : '',
  ].filter(Boolean).join(' ');

  const leaks = deck.leaks.length
    ? `<ul class="leaks">${deck.leaks
        .map((l) => `<li>slide ${l.slide}: <b>${escapeHtml(l.leak)}</b> — ${escapeHtml(l.text)}</li>`)
        .join('')}</ul>`
    : '';

  const renderError = deck.renderError
    ? `<pre class="error">rasterisation failed: ${escapeHtml(deck.renderError)}</pre>`
    : '';

  const slides = deck.slides.length
    ? deck.slides.map((slide) => `
        <figure class="slide${slide.blank ? ' blank' : ''}">
          <a href="/${escapeHtml(slide.file)}" target="_blank" rel="noreferrer">
            <img loading="lazy" src="/${escapeHtml(slide.file)}" alt="Slide ${slide.index}">
          </a>
          <figcaption>
            <span>Slide ${slide.index}</span>
            <span class="dim">${slide.width}×${slide.height}${slide.blank ? ' · looks blank' : ''}</span>
          </figcaption>
        </figure>`).join('')
    : '<p class="dim">No slide images — see the error above.</p>';

  const warehouses = deck.warehouses
    .map((w) => `#${w.id} ${escapeHtml(w.city)} (${w.photos} photo${w.photos === 1 ? '' : 's'})`)
    .join(' · ');

  return `
    <section class="deck">
      <header>
        <h2>${escapeHtml(deck.label)}</h2>
        <a class="download" href="/${escapeHtml(deck.pptx)}">download .pptx</a>
      </header>
      <div class="badges">${badges}</div>
      <div class="dim warehouses">${warehouses}</div>
      ${leaks}
      ${renderError}
      <div class="slides">${slides}</div>
    </section>`;
}

/** The checks block the eval runner adds above the decks. */
function renderChecks(results) {
  if (!results || !results.length) return '';
  const failed = results.filter((r) => !r.pass && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const known = results.filter((r) => r.known);
  const rows = results.map((r) => {
    const tone = r.skipped ? '' : r.known ? 'known' : r.pass ? 'ok' : 'bad';
    const mark = r.skipped ? '–' : r.known ? '~' : r.pass ? '✓' : '✕';
    return `<li class="${tone}"><span class="mark">${mark}</span> ${escapeHtml(r.name)}`
      + (r.detail ? `<div class="dim detail">${escapeHtml(r.detail)}</div>` : '')
      + '</li>';
  }).join('');

  return `
    <section class="deck checks">
      <header>
        <h2>Checks</h2>
        <span class="badge ${failed.length ? 'bad' : 'ok'}">
          ${results.length - failed.length - skipped.length - known.length} passed · ${failed.length} failed${known.length ? ` · ${known.length} known` : ''}${skipped.length ? ` · ${skipped.length} skipped` : ''}
        </span>
      </header>
      <ul class="checklist">${rows}</ul>
    </section>`;
}

function renderContactSheet({ decks, dir, meta, results }) {
  const blocked = meta.blocked.length
    ? `<div class="note">Blocked outbound: ${meta.blocked.map((b) => `${escapeHtml(b.host)} ×${b.count}`).join(', ')}</div>`
    : '';

  const flags = Object.entries(meta.customDetails)
    .filter(([, on]) => !on)
    .map(([key]) => `--no-${key === 'mapsLocation' ? 'maps' : key === 'pocSlide' ? 'poc' : key}`)
    .join(' ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPT preview — ${escapeHtml(decks.map((d) => d.variant).join(', '))}</title>
<style>
  :root { color-scheme: dark; --bg:#141414; --card:#1d1d1d; --line:#2f2f2f; --text:#e9e9e9;
          --dim:#8f8f8f; --ok:#52c41a; --bad:#ff4d4f; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:var(--bg); color:var(--text);
         font:14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h2 { font-size:16px; margin:0; }
  .dim { color:var(--dim); }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
         margin-bottom:22px; flex-wrap:wrap; }
  .note { color:var(--dim); font-size:13px; margin-top:4px; }
  button { background:#2563eb; color:#fff; border:0; border-radius:8px; padding:9px 16px;
           font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { background:#1d4ed8; }
  button[disabled] { opacity:.6; cursor:progress; }
  section.deck { background:var(--card); border:1px solid var(--line); border-radius:12px;
                 padding:18px; margin-bottom:20px; }
  section.deck > header { display:flex; justify-content:space-between; align-items:baseline;
                          margin-bottom:10px; gap:12px; }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .badge { font-size:11px; padding:2px 9px; border-radius:99px; border:1px solid var(--line);
           color:var(--dim); white-space:nowrap; }
  .badge.ok { color:var(--ok); border-color:var(--ok); }
  .badge.bad { color:var(--bad); border-color:var(--bad); }
  .warehouses { font-size:12px; margin-bottom:10px; }
  ul.leaks { margin:8px 0; padding-left:20px; color:var(--bad); font-size:13px; }
  pre.error { background:#1a1010; border:1px solid #5c2626; border-radius:8px; padding:10px;
              color:#ffb4b4; overflow:auto; font-size:12px; }
  .slides { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:14px; }
  figure.slide { margin:0; background:#0d0d0d; border:1px solid var(--line); border-radius:8px;
                 overflow:hidden; }
  figure.slide.blank { border-color:var(--bad); }
  figure.slide img { display:block; width:100%; height:auto; background:#fff; }
  figcaption { display:flex; justify-content:space-between; padding:6px 10px; font-size:12px; }
  a { color:#69b1ff; text-decoration:none; }
  a.download { font-size:13px; }
  ul.checklist { list-style:none; margin:0; padding:0; }
  ul.checklist li { padding:5px 0; border-bottom:1px solid var(--line); font-size:13px; }
  ul.checklist li:last-child { border-bottom:0; }
  ul.checklist li.ok .mark { color:var(--ok); }
  ul.checklist li.bad { color:var(--bad); }
  ul.checklist li.known .mark { color:#faad14; }
  ul.checklist .mark { display:inline-block; width:16px; font-weight:700; }
  ul.checklist .detail { margin:2px 0 0 16px; font-size:12px; }
</style></head>
<body>
  <div class="top">
    <div>
      <h1>PPT preview</h1>
      <div class="dim">${escapeHtml(meta.source)} · ${escapeHtml(String(meta.dpi))} dpi · network ${meta.offline ? 'blocked' : 'open'}${flags ? ` · ${escapeHtml(flags)}` : ''}</div>
      <div class="note">${escapeHtml(dir)}</div>
      ${blocked}
      <div class="note">${meta.photoRequests} fixture photo request(s) · built ${escapeHtml(meta.generatedAt)}</div>
    </div>
    <button id="rebuild">Rebuild</button>
  </div>
  ${renderChecks(results)}
  ${decks.map(renderDeck).join('')}
<script>
  const button = document.getElementById('rebuild');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Rebuilding…';
    try {
      const response = await fetch('/rebuild');
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'rebuild failed');
      location.reload();
    } catch (error) {
      button.textContent = 'Rebuild failed — see terminal';
      button.disabled = false;
      console.error(error);
    }
  });
</script>
</body></html>`;
}

module.exports = { renderContactSheet };

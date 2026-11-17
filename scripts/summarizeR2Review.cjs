// Offline consolidation of the read-only inventory and independent reference checks.
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(process.argv[2]);
const load = name => JSON.parse(fs.readFileSync(path.join(directory, name)));
const inventory = load('inventory-summary.json');
const initial = load('reference-summary.json');
const independent = load('orphan-database-review.json');
const local = load('orphan-local-review.json');
const trace = load('orphan-trace-review.json');
const panoMatches = load('panorama-source-matches.json');
const all = fs.readFileSync(path.join(directory, 'object-references.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
const candidates = all.filter(object => object.classification === 'unreferenced');
const byEtag = new Map();
for (const object of all) {
    const id = `${object.etag}:${object.bytes}`;
    const list = byEtag.get(id) || []; list.push(object); byEtag.set(id, list);
}
const partial = initial.missingReferences.filter(ref => ref.key.endsWith('…'));
const add = (map, key, object) => { const row = map[key] ||= { objects: 0, bytes: 0 }; row.objects++; row.bytes += object.bytes; };
const total = rows => ({ objects: rows.length, bytes: rows.reduce((n,row) => n + row.bytes, 0) });
const report = { generatedAt: new Date().toISOString(), originalInventoryTime: inventory.finishedAt,
    initialCandidateTotal: total(candidates), byDisposition: {}, candidateNature: {},
    candidateAges: {}, uploadAuditKinds: {}, candidates: [], method: {
        independentDatabaseTables: independent.tables.length, independentErrors: independent.errors,
        localFilesWithMatches: Object.keys(local.files).length, localErrors: local.errors,
        databaseAccess: trace.databaseAccess,
        scope: 'Three configured R2 buckets; both application databases, including the panos schema; application text/JSON/text arrays; exact filename checks; local source and historical snapshots; local panorama image hashes.',
        limitations: 'Account-wide bucket listing and lifecycle/billing APIs denied by current credentials. No access-log or external-link-use audit. Object listing and database scans are separate points in time while uploads continue. Candidate status is not authorization to delete.',
    } };
for (const object of candidates) {
    const full = `${object.bucket}/${object.key}`;
    const matches = panoMatches.filter(row => row.bucket === object.bucket && row.key === object.key);
    const original = matches.some(row => /^(originals|originals-2|cache-originals)\//.test(row.localPath));
    const partialMatches = partial.filter(ref => ref.bucket === object.bucket && object.key.startsWith(ref.key.slice(0,-1)));
    const history = trace.historical.filter(row => row.keys.includes(full));
    const liveDuplicates = (byEtag.get(`${object.etag}:${object.bytes}`) || []).filter(peer => peer !== object && ['active','derived_active','static_source'].includes(peer.classification));
    const events = trace.auditEvents.filter(row => row.key === path.posix.basename(object.key));
    const ageDays = Math.floor((new Date(inventory.finishedAt) - new Date(object.modifiedAt)) / 864e5);
    let disposition = original ? 'retain_original' : partialMatches.length ? 'retain_possible_history' : history.length ? 'retain_deleted_warehouse_history' : 'candidate';
    // Filename matches outside upload audit logs would need individual review.
    const unexpectedRefs = (independent.matches[full] || []).filter(ref => ref.source !== 'warehouse.public.audit_logs' || ref.column !== 'entityId');
    if (unexpectedRefs.length) disposition = 'needs_reference_review';
    const nature = object.key.startsWith('scout_') ? 'Scout warehouse uploads' : object.key.startsWith('media_') ? 'WhatsApp media uploads' : !object.key.includes('/') ? 'Dashboard / other root uploads' :
        object.key.startsWith('panos/') ? 'Panorama enhancement experiments' : object.key.startsWith('compositions/') ? 'Unused composition assets' :
        object.key.startsWith('tickets/') ? 'Unattached ticket uploads' : object.key.startsWith('webp/') ? 'WebP derivatives' : 'Blog, guide, or floorplan assets';
    const row = { bucket: object.bucket, key: object.key, bytes: object.bytes, modifiedAt: object.modifiedAt, ageDays, disposition, nature,
        uploadAuditEvents: events.map(event => ({ action: event.action, entity: event.entity, context: event.context, first: event.first, last: event.last })),
        panoramaLocalMatches: matches.map(match => match.localPath), formerWarehouseIds: history.map(item => item.warehouseId),
        possibleTruncatedHistory: partialMatches.map(ref => ref.key), liveDuplicates: liveDuplicates.map(peer => ({ bucket: peer.bucket, key: peer.key, classification: peer.classification })),
        independentFilenameReferences: independent.matches[full] || [], localReferenceFiles: Object.keys(local.matches[full] || {}) };
    report.candidates.push(row); add(report.byDisposition, disposition, row);
    if (disposition === 'candidate') {
        add(report.candidateNature, nature, row);
        add(report.candidateAges, ageDays < 7 ? '<7 days' : ageDays < 30 ? '7–29 days' : '30+ days', row);
    }
    for (const event of events) add(report.uploadAuditKinds, `${event.action}/${event.entity}/${event.context}`, row);
}
const remaining = report.candidates.filter(row => row.disposition === 'candidate');
report.duplicateOfLive = total(remaining.filter(row => row.liveDuplicates.length));
report.olderDuplicateOfLive = total(remaining.filter(row => row.ageDays >= 30 && row.liveDuplicates.length));
report.withUploadOnlyHistory = total(remaining.filter(row => row.uploadAuditEvents.length));
report.ticketDetails = {};
for (const row of remaining.filter(row => row.key.startsWith('tickets/'))) {
    const part = row.key.split('/')[1]; add(report.ticketDetails, part === 'draft' ? 'draft' : part === 'employees' ? 'employee upload folders' : 'named ticket folders', row);
}
const save = (name, data) => fs.writeFileSync(path.join(directory, name), data, { mode: 0o600 });
save('reviewed-orphans.json', JSON.stringify(report, null, 2) + '\n');
const csv = value => '"' + String(value).replace(/"/g, '""') + '"';
const header = 'bucket,key,bytes,last_modified,age_days,disposition,nature,live_duplicate_count,upload_audit_events,former_warehouse_ids\n';
const csvRows = rows => rows.map(row => [row.bucket,row.key,row.bytes,row.modifiedAt,row.ageDays,row.disposition,row.nature,row.liveDuplicates.length,row.uploadAuditEvents.length,row.formerWarehouseIds.join(';')].map(csv).join(',')).join('\n') + '\n';
save('reviewed-candidates.csv', header + csvRows(remaining));
save('reviewed-all-initial-candidates.csv', header + csvRows(report.candidates));
const gb = bytes => (bytes / 1e9).toFixed(3);
const mb = bytes => (bytes / 1e6).toFixed(2);
const n = value => value.toLocaleString('en-IN');
const rows = entries => Object.entries(entries).map(([label,value]) => `| ${label} | ${n(value.objects)} | ${gb(value.bytes)} GB |`).join('\n');
const retained = report.candidates.filter(row => row.disposition !== 'candidate');
const text = `R2 storage audit — 24 September 2026\n\n` +
`The three configured buckets contain **${n(inventory.totals.objects)} objects / ${gb(inventory.totals.bytes)} GB** (${(inventory.totals.bytes/2**30).toFixed(2)} GiB). These are complete listings of the known buckets, but the current credentials return 403 for account-wide bucket enumeration and lifecycle settings. Billing credentials were unavailable. Additional unconfigured buckets cannot be ruled out. The inventory finished at ${inventory.finishedAt}; uploads continued during the audit. All listed objects are Standard storage. No incomplete multipart uploads were found.\n\n` +
`| Bucket | Objects | Storage |\n|---|---:|---:|\n` + inventory.buckets.map(bucket => `| ${bucket.name} | ${n(bucket.objects)} | ${gb(bucket.bytes)} GB |`).join('\n') + `\n\n` +
`Warehouse media dominates: ${gb(inventory.buckets.find(bucket=>bucket.name==='whatsapp-bot-media').byType.video.bytes)} GB of videos and ${gb(inventory.buckets.find(bucket=>bucket.name==='whatsapp-bot-media').byType.image.bytes)} GB of images. This includes ${gb(inventory.buckets.find(bucket=>bucket.name==='whatsapp-bot-media').byPrefix['webp/'].bytes)} GB under webp/, ${gb(inventory.buckets.find(bucket=>bucket.name==='whatsapp-bot-media').byPrefix['panos/'].bytes)} GB under panos/, and ${mb(inventory.buckets.find(bucket=>bucket.name==='whatsapp-bot-media').byPrefix['tickets/'].bytes)} MB of ticket attachments. These prefix figures overlap the media-type figures. No new JPEG backfill was run.\n\n` +
`**The initial ${n(candidates.length)}-file / ${gb(total(candidates).bytes)} GB list was too broad for deletion.** A second filename-based scan of ${independent.tables.length} database tables and a workspace-wide historical-file search found additional evidence. ${n(retained.length)} objects / ${mb(total(retained).bytes)} MB are excluded from the revised candidate list.\n\n` +
`| Disposition | Objects | Storage |\n|---|---:|---:|\n` + rows(report.byDisposition) + `\n\n` +
`- Retain 41 original panorama images (${mb(report.byDisposition.retain_original.bytes)} MB). Their sizes and MD5 hashes match local source files in originals/ and cache-originals/. An unused current URL does not make an original disposable. All 52 initially flagged panorama images were identified locally: 41 originals and 11 enhancement experiment outputs.\n` +
`- Hold nine images matching truncated historical URLs (${mb(report.byDisposition.retain_possible_history.bytes)} MB). Prefix matches are ambiguous; they are not treated as deletion candidates.\n` +
`- Hold seven images/videos/WebPs (${mb(report.byDisposition.retain_deleted_warehouse_history.bytes)} MB) seen in the 13 September website snapshot. They belonged to warehouses 535 and 2227, neither of which exists in the current database. This is historical provenance, not current application use.\n` +
`- All 982 newly found filename references are CREATE/file audit entries for generating upload URLs (464 dashboard, 518 scout). These prove upload provenance; none are current gallery or attachment links. The revised candidate list contains ${report.withUploadOnlyHistory.objects} files with this upload-only history.\n\n` +
`**Revised candidates: ${n(remaining.length)} files / ${gb(total(remaining).bytes)} GB.** Their filenames were absent from current Warehouse.media/photos/photosWebp, staged data, image registry, panorama tour/scene fields, blog/content tables, ticket attachments and composition JSON, and the other scanned application tables. The independent scan looked for filenames without requiring an R2 hostname, including bare keys, JSON and text arrays.\n\n` +
`| File nature | Candidates | Storage |\n|---|---:|---:|\n` + rows(report.candidateNature) + `\n\n` +
`${n(report.duplicateOfLive.objects)} revised candidates / ${gb(report.duplicateOfLive.bytes)} GB match the single-part ETag and size of a still-referenced object. ${n(report.olderDuplicateOfLive.objects)} of these / ${gb(report.olderDuplicateOfLive.bytes)} GB are at least 30 days old: these have stronger cleanup evidence. This metadata comparison was not a full download/hash verification of both R2 copies. It also does not prove that a shared public URL has no external users.\n\n` +
`| Candidate age | Objects | Storage |\n|---|---:|---:|\n` + rows(report.candidateAges) + `\n\n` +
`The 36 unattached ticket objects include 31 in draft/, three in employee upload folders, and two in named ticket folders. The 18 unused autoware bucket assets belong to still-existing compositions but are absent from their current component JSON. The 23 compositions/ files in the shared media bucket have no current parent composition; many use example UUIDs. The 11 remaining panorama candidates match local experiment outputs.\n\n` +
`Code supports the likely cause of many root objects: the dashboard uploads before the warehouse form is saved, removing a file only changes form state, and deleting a warehouse deletes its database row. AutoWare composition deletion likewise deletes the database row without removing R2 assets. These are routes by which abandoned uploads, replacements, and deleted records can leave files behind; they do not establish the cause of every individual file.\n\n` +
`**Billing:** at an unchanged ${gb(inventory.totals.bytes)} GB for a full month, Standard storage is approximately **$0.48/month** after the shared 10 GB-month allowance and billing-unit rounding. Actual storage charges depend on average daily peaks; Class A/B operations, tax and other products are additional. No invoice or request metrics were accessible, so the observed bill has not been reconciled. See [Cloudflare pricing](https://developers.cloudflare.com/r2/pricing/).\n\n` +
`**Limits and next step:** These are candidates for review, not a delete list. Preserve original sources and historical files, recheck live references just before any cleanup, and start with older duplicate uploads. Public links may exist in chats, documents, browser drafts, cached pages or systems outside the repositories and databases scanned; no access-log check was possible. Nothing was deleted or changed in R2 or either database.\n\n` +
`Evidence files: [reviewed candidates](reviewed-candidates.csv), [all initial candidates with revised dispositions](reviewed-all-initial-candidates.csv), [full per-object evidence](reviewed-orphans.json), [inventory](inventory-summary.json), [initial reference scan](reference-summary.json), [independent filename scan](orphan-database-review.json), [historical source scan](orphan-local-review.json), [upload and deleted-warehouse traces](orphan-trace-review.json), [panorama hash matches](panorama-source-matches.json). The initial orphan-candidates.csv is superseded by reviewed-candidates.csv.\n`;
save('report.md', text);
console.log(JSON.stringify({ initial: report.initialCandidateTotal, revised: total(remaining), byDisposition: report.byDisposition, nature: report.candidateNature, ages: report.candidateAges, duplicateOfLive: report.duplicateOfLive, olderDuplicateOfLive: report.olderDuplicateOfLive, databaseAccess: trace.databaseAccess, report: path.join(directory,'report.md') }, null, 2));

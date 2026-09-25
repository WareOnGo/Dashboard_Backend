// One-off Sol second opinions for READY/REVIEW rows using the discounted Batch API.
// No synchronous inference, new schema, scene-label changes, or image uploads.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MODEL, VERSION, PROMPT, sha256, buildRequest, verifySource, parseResult, indexResults, applyResult } = require('./lib/websiteImageBatchReview.cjs');
const {downloadOriginal} = require('../src/utils/websiteImageAssessment.cjs');

const TERMINAL = new Set(['completed','failed','expired','cancelled']);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => {
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data,null,2)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
};
const event = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
function safeError(error) {
    const code = String(error.code || error.cause?.code || error.message || error.name);
    return /^[a-zA-Z0-9_]+$/.test(code) ? code : 'operation_failed';
}
async function mapBounded(rows, count, fn) {
    let cursor = 0;
    const results = new Array(rows.length);
    await Promise.all(Array.from({ length: Math.min(count,rows.length) }, async () => {
        while (cursor < rows.length) { const i = cursor++; results[i] = await fn(rows[i],i); }
    }));
    return results;
}
async function api(route, { method = 'GET', body, raw = false } = {}) {
    if (!process.env.OPENAI_API_KEY) throw new Error('missing_api_key');
    const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(`https://api.openai.com/v1${route}`, {
        method, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        headers, signal: AbortSignal.timeout(90000), redirect: 'error',
    });
    if (!response.ok) {
        let code;
        try { code = (await response.json()).error?.code; } catch {}
        const error = new Error(`openai_http_${response.status}`);
        error.code = `openai_http_${response.status}${typeof code === 'string' && /^[\w]+$/.test(code) ? `_${code}` : ''}`;
        throw error;
    }
    return raw ? response.text() : response.json();
}

async function prepare(prisma, output, expectedCount) {
    if (fs.existsSync(path.join(output,'manifest.json'))) throw new Error('snapshot_already_exists');
    const rows = await prisma.$queryRawUnsafe(`SELECT id,"imageUrl","websiteStatus","websiteDecision",
      "websiteQualityTier","websiteAssessment","websiteAssessedAt","websiteOverride"
      FROM labeled_warehouse_images WHERE "websiteStatus"='READY' AND "websiteDecision"='REVIEW' ORDER BY id`);
    if (!rows.length || rows.length !== expectedCount) throw new Error('unexpected_review_count');
    if (rows.some(row => row.websiteOverride)) throw new Error('manual_override_requires_exclusion');
    let checked = 0;
    // Four original buffers at most; never retain image binaries on disk.
    await mapBounded(rows,4,async row => {
        row.websiteAssessedAt = row.websiteAssessedAt.toISOString();
        row.customId = buildRequest(row).custom_id;
        let failure;
        for (let attempt=0; attempt<3; attempt++) {
            try { row.sourceCheck = await verifySource(row); failure = null; break; }
            catch (error) { failure = error; if (safeError(error)==='source_changed') break; }
        }
        if (failure) throw failure;
        checked++;
        if (checked % 25 === 0 || checked === rows.length) event({ event:'SOURCE_CHECK', checked, total:rows.length });
    });
    savePrepared(output,rows,rows.map(row=>buildRequest(row)));
}
function savePrepared(output,rows,requests,extra={}) {
    const input = requests.map(request => JSON.stringify(request)).join('\n')+'\n';
    if (Buffer.byteLength(input)>190000000) throw new Error('batch_input_too_large');
    const snapshot = JSON.stringify(rows,null,2)+'\n';
    fs.writeFileSync(path.join(output,'snapshot.json'),snapshot,{ mode:0o600 });
    fs.writeFileSync(path.join(output,'input.jsonl'),input,{ mode:0o600 });
    const manifest = { jobId:randomUUID(), createdAt:new Date().toISOString(), status:'prepared',
        model:MODEL, version:VERSION, promptSha256:sha256(PROMPT), count:rows.length,
        snapshotSha256:sha256(snapshot), inputSha256:sha256(input), inputBytes:Buffer.byteLength(input),
        completionWindow:'24h', inputFileId:null, batchId:null, ...extra };
    write(path.join(output,'manifest.json'),manifest);
    event({ event:'PREPARED', count:rows.length, model:MODEL, inputBytes:manifest.inputBytes, output });
}
async function prepareRetry(prisma,output,parentOutput,expectedCount) {
    if (!parentOutput || fs.existsSync(path.join(output,'manifest.json'))) throw new Error('invalid_retry_output');
    const parent=loadPrepared(parentOutput);
    const batch=read(path.join(parentOutput,'batch.json'));
    if (!TERMINAL.has(batch.status) || batch.id!==parent.manifest.batchId) throw new Error('parent_batch_not_terminal');
    const errors=indexResults([fs.readFileSync(path.join(parentOutput,'errors.jsonl'),'utf8')],parent.rows);
    const rows=parent.rows.filter(row=>{
        const result=errors.get(row.customId);
        return result?.response?.status_code===400 && /download.+timeout/i.test(result.response?.body?.error?.message || '');
    });
    if (!rows.length || rows.length!==expectedCount) throw new Error('unexpected_retry_count');
    const requests=await mapBounded(rows,4,async row=>{
        const [unchanged]=await prisma.$queryRawUnsafe(`SELECT id FROM labeled_warehouse_images WHERE id=$1 AND "imageUrl"=$2
          AND "websiteStatus"='READY' AND "websiteDecision"='REVIEW' AND "websiteAssessment"=$3::jsonb
          AND "websiteAssessedAt"=$4::timestamptz AND "websiteOverride" IS NULL`,
        row.id,row.imageUrl,JSON.stringify(row.websiteAssessment),row.websiteAssessedAt);
        if (!unchanged) throw new Error('retry_row_changed');
        const {buffer}=await downloadOriginal(row.imageUrl,AbortSignal.timeout(45000));
        const request=buildRequest(row,{originalBytes:buffer});
        row.batchInputTransport='original-bytes';row.retryOfBatchId=batch.id;
        row.sourceCheck={checkedAt:new Date().toISOString(),bytes:buffer.length};
        return request;
    });
    savePrepared(output,rows,requests,{retryOfBatchId:batch.id,parentOutput});
    parent.manifest.retryOutputs=[...new Set([...(parent.manifest.retryOutputs || []),output])];
    write(path.join(parentOutput,'manifest.json'),parent.manifest);
}
function loadPrepared(output) {
    const manifest = read(path.join(output,'manifest.json'));
    const snapshot = fs.readFileSync(path.join(output,'snapshot.json'));
    const input = fs.readFileSync(path.join(output,'input.jsonl'));
    if (manifest.model !== MODEL || manifest.version !== VERSION || manifest.promptSha256 !== sha256(PROMPT)
        || sha256(snapshot) !== manifest.snapshotSha256 || sha256(input) !== manifest.inputSha256) throw new Error('snapshot_integrity_failed');
    const rows = JSON.parse(snapshot);
    if (rows.length !== manifest.count || new Set(rows.map(row=>row.customId)).size !== rows.length) throw new Error('invalid_snapshot_count');
    return { manifest, rows, input };
}
async function findSubmitted(manifest) {
    // A lost HTTP response must not cause another billable submission. Recover by
    // the job UUID before retrying an uncertain POST. Absence requires inspection.
    let after;
    for (let page=0; page<100; page++) {
        const list = await api(`/batches?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        const matches = list.data.filter(batch => batch.metadata?.job_id === manifest.jobId);
        if (matches.length > 1) throw new Error('duplicate_remote_batches');
        if (matches.length) return matches[0];
        if (!list.has_more) return null;
        after = list.last_id;
    }
    throw new Error('batch_lookup_limit');
}
async function submit(output) {
    const { manifest, input } = loadPrepared(output);
    const file = path.join(output,'manifest.json');
    if (manifest.batchId) { event({ event:'ALREADY_SUBMITTED',batchId:manifest.batchId }); return; }
    if (!manifest.inputFileId) {
        const form = new FormData();
        form.append('purpose','batch');
        form.append('file',new Blob([input],{type:'application/jsonl'}),'website-sol-review.jsonl');
        manifest.inputFileId = (await api('/files',{method:'POST',body:form})).id;
        write(file,manifest);
    }
    let batch;
    if (manifest.submissionAttemptedAt) {
        batch = await findSubmitted(manifest);
        if (!batch) throw new Error('submission_uncertain_do_not_resubmit');
    } else {
        manifest.submissionAttemptedAt = new Date().toISOString();
        write(file,manifest);
        batch = await api('/batches',{method:'POST',body:{ input_file_id:manifest.inputFileId,
            endpoint:'/v1/responses',completion_window:'24h',
            metadata:{job_id:manifest.jobId,purpose:'website-image-review',version:VERSION} }});
    }
    manifest.batchId = batch.id; manifest.status = batch.status;
    manifest.submittedAt = new Date(batch.created_at*1000).toISOString();
    write(file,manifest); write(path.join(output,'batch.json'),batch);
    event({ event:'SUBMITTED', count:manifest.count, model:MODEL, batchId:batch.id, status:batch.status });
}

async function collect(prisma, output, batch, apply) {
    const { manifest, rows } = loadPrepared(output);
    const contents = [];
    for (const [field,name] of [['output_file_id','output.jsonl'],['error_file_id','errors.jsonl']]) {
        if (!batch[field]) continue;
        const file = path.join(output,name);
        if (!fs.existsSync(file)) fs.writeFileSync(file,await api(`/files/${batch[field]}/content`,{raw:true}),{mode:0o600});
        contents.push(fs.readFileSync(file,'utf8'));
    }
    const results = indexResults(contents,rows);
    const reportPath = path.join(output,'report.json');
    const previous = fs.existsSync(reportPath) ? read(reportPath) : null;
    if (previous && previous.batchId !== batch.id) throw new Error('report_batch_mismatch');
    const outcomes = new Map((previous?.rows || []).map(row => [row.id,row]));
    await mapBounded(rows,4,async snapshot => {
        if (outcomes.get(snapshot.id)?.outcome === 'APPLIED') return;
        const line = results.get(snapshot.customId);
        const entry = {id:snapshot.id,customId:snapshot.customId};
        try {
            if (!line) throw new Error('missing_result');
            const result = parseResult(line,snapshot,batch.id);
            Object.assign(entry,{decision:result.decision,qualityTier:result.qualityTier,assessment:result.assessment,
                usage:line.response.body.usage || {}});
            if (!apply) entry.outcome = 'VALIDATED';
            else {
                const [current] = await prisma.$queryRawUnsafe('SELECT "websiteAssessment" FROM labeled_warehouse_images WHERE id=$1',snapshot.id);
                if (current?.websiteAssessment?.batchReview?.batchId === batch.id) entry.outcome = 'APPLIED';
                else {
                    entry.sourceCheck = await verifySource(snapshot);
                    result.assessment.batchReview.sourceRecheckedAt = entry.sourceCheck.checkedAt;
                    entry.outcome = (await applyResult(prisma,snapshot,result)) === 1 ? 'APPLIED' : 'SKIPPED_CHANGED_ROW';
                }
            }
        } catch (error) { entry.outcome='ERROR';entry.error=safeError(error); }
        outcomes.set(snapshot.id,entry);
        // Persist after each result; a crash after UPDATE is recovered from its
        // batchReview ID, without repeating inference or replacing history.
        write(reportPath,{batchId:batch.id,updatedAt:new Date().toISOString(),rows:[...outcomes.values()]});
    });
    const entries = [...outcomes.values()];
    const summary = { total:rows.length,returned:results.size,applied:0,validated:0,skipped:0,errors:0,retryableErrors:0,
        decisions:{ALLOW:0,BLOCK:0,REVIEW:0},inputTokens:0,cachedInputTokens:0,outputTokens:0 };
    for (const row of entries) {
        if (row.outcome==='APPLIED') summary.applied++;
        else if (row.outcome==='VALIDATED') summary.validated++;
        else if (row.outcome==='SKIPPED_CHANGED_ROW') summary.skipped++;
        else {
            summary.errors++;
            if (/^(source_(timeout|download_failed|http_5\d\d)|operation_failed|PrismaClient\w+|P10\d\d|P2024|E\w+|20|23)$/.test(row.error || '')) {
                summary.retryableErrors++;
            }
        }
        if (row.decision) summary.decisions[row.decision]++;
        summary.inputTokens+=row.usage?.input_tokens || 0;
        summary.cachedInputTokens+=row.usage?.input_tokens_details?.cached_tokens || 0;
        summary.outputTokens+=row.usage?.output_tokens || 0;
    }
    write(reportPath,{batchId:batch.id,updatedAt:new Date().toISOString(),summary,rows:entries});
    event({event:'RESULTS',batchId:batch.id,...summary});
    return summary;
}
async function poll(prisma, output, {watch,apply}) {
    const {manifest}=loadPrepared(output);
    if (!manifest.batchId) throw new Error('batch_not_submitted');
    let transientFailures=0;
    do {
        try {
            const batch=await api(`/batches/${manifest.batchId}`);
            write(path.join(output,'batch.json'),batch);
            event({event:'BATCH_STATUS',batchId:batch.id,status:batch.status,counts:batch.request_counts});
            manifest.status=batch.status; manifest.lastCheckedAt=new Date().toISOString();
            write(path.join(output,'manifest.json'),manifest);
            if (TERMINAL.has(batch.status)) {
                const report=await collect(prisma,output,batch,apply);
                manifest.resultSummary=report;manifest.collectedAt=new Date().toISOString();
                write(path.join(output,'manifest.json'),manifest);
                if (watch && report.retryableErrors && transientFailures < 10) {
                    transientFailures++;
                    await delay(60000);
                    continue;
                }
                return;
            }
            transientFailures=0;
        } catch(error) {
            event({event:'POLL_ERROR',code:safeError(error)});
            if (!watch || ++transientFailures>=20 || /^openai_http_40[13]/.test(safeError(error))) throw error;
        }
        if (watch) await delay(60000);
    } while (watch);
}

async function main() {
    require('node:net').setDefaultAutoSelectFamilyAttemptTimeout(2000);
    require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
    const [command,...args]=process.argv.slice(2);
    const opts={apply:false,background:false,expectedCount:275};
    for (const arg of args) {
        if (arg==='--apply') opts.apply=true;
        else if (arg==='--background') opts.background=true;
        else if (arg.startsWith('--output=')) opts.output=path.resolve(arg.slice(9));
        else if (arg.startsWith('--expected-count=')) opts.expectedCount=Number(arg.slice(17));
        else if (arg.startsWith('--from=')) opts.parentOutput=path.resolve(arg.slice(7));
        else throw new Error('unknown_option');
    }
    if (!['prepare','prepare-retry','submit','status','collect','watch'].includes(command) || !opts.output
        || !Number.isInteger(opts.expectedCount) || opts.expectedCount<1 || opts.expectedCount>50000) throw new Error('invalid_options');
    fs.mkdirSync(opts.output,{recursive:true,mode:0o700});
    if (command==='status') {
        const {manifest}=loadPrepared(opts.output);
        if (!manifest.batchId) throw new Error('batch_not_submitted');
        const batch=await api(`/batches/${manifest.batchId}`);
        event({event:'BATCH_STATUS',batchId:batch.id,status:batch.status,counts:batch.request_counts});
        return;
    }
    if (opts.background) {
        if (command!=='watch') throw new Error('background_requires_watch');
        const log=fs.openSync(path.join(opts.output,'watcher.log'),'a',0o600);
        const child=spawn(process.execPath,['--max-old-space-size=512',__filename,...process.argv.slice(2).filter(a=>a!=='--background')],
            {detached:true,stdio:['ignore',log,log],cwd:path.resolve(__dirname,'..'),env:process.env});
        fs.writeFileSync(path.join(opts.output,'watcher.pid'),`${child.pid}\n`,{mode:0o600});
        child.unref();fs.closeSync(log);event({event:'WATCHER_STARTED',pid:child.pid,output:opts.output});return;
    }
    const lock=path.join(opts.output,'runner.lock');
    // Prevent concurrent writers/submissions. An interrupted process can resume.
    if (fs.existsSync(lock)) {
        const pid=Number(fs.readFileSync(lock,'utf8').trim());
        if (!(pid>0)) throw new Error('invalid_runner_lock');
        try {process.kill(pid,0);throw new Error('runner_already_active');}
        catch(error) {if(error.code!=='ESRCH')throw error;fs.unlinkSync(lock);}
    }
    const handle=fs.openSync(lock,'wx',0o600);fs.writeFileSync(handle,`${process.pid}\n`);fs.closeSync(handle);
    const {PrismaClient}=require('@prisma/client');
    const url=new URL(process.env.DATABASE_URL);url.searchParams.set('connection_limit','4');url.searchParams.set('pool_timeout','30');
    const prisma=new PrismaClient({datasources:{db:{url:url.toString()}}});
    try {
        if(command==='prepare')await prepare(prisma,opts.output,opts.expectedCount);
        else if(command==='prepare-retry')await prepareRetry(prisma,opts.output,opts.parentOutput,opts.expectedCount);
        else if(command==='submit')await submit(opts.output);
        else await poll(prisma,opts.output,{watch:command==='watch',apply:opts.apply});
    } finally {await prisma.$disconnect();fs.unlinkSync(lock);}
}
module.exports={prepare,loadPrepared,submit,collect,poll,mapBounded};
if(require.main===module)main().catch(error=>{event({event:'FAILED',code:safeError(error)});process.exitCode=1;});

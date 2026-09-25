const { createHash } = require('node:crypto');
const { PROMPT, SCHEMA } = require('../../src/utils/websiteImagePolicy.cjs');
const { normalizeAssessment, validateSource, downloadOriginal } = require('../../src/utils/websiteImageAssessment.cjs');

const MODEL = 'gpt-5.6-sol';
const VERSION = 'website-approval-sol-batch-v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function sourceMetadata(row) {
    const a = row.websiteAssessment;
    if (!a || !/^[a-f0-9]{64}$/.test(a.sourceSha256 || '') || !(a.sourceWidth > 0 && a.sourceHeight > 0)) {
        throw new Error('missing_source_metadata');
    }
    return { sha256: a.sourceSha256, width: a.sourceWidth, height: a.sourceHeight,
        bytes: a.sourceBytes, format: a.sourceFormat, etag: a.sourceEtag };
}

function buildRequest(row, { originalBytes } = {}) {
    const source = sourceMetadata(row);
    if (row.websiteDecision !== 'REVIEW' || row.websiteStatus !== 'READY' || !Number.isInteger(row.id)) {
        throw new Error('not_a_ready_review');
    }
    let imageUrl = validateSource(row.imageUrl);
    if (originalBytes) {
        if (sha256(originalBytes) !== source.sha256) throw new Error('source_changed');
        if (!['jpeg','png','webp','gif'].includes(source.format)) throw new Error('unsupported_source_format');
        imageUrl = `data:image/${source.format};base64,${originalBytes.toString('base64')}`;
    }
    return { custom_id: `website-review-${row.id}-${source.sha256.slice(0,16)}`, method: 'POST', url: '/v1/responses',
        body: { model: MODEL, store: false, reasoning: { effort: 'medium' }, max_output_tokens: 8192,
            input: [{ role: 'user', content: [
                { type: 'input_text', text: PROMPT },
                { type: 'input_image', image_url: imageUrl, detail: 'high' },
            ] }], text: { format: { type: 'json_schema', name: 'website_image_eval', strict: true, schema: SCHEMA } } } };
}

async function verifySource(row, http = fetch) {
    const { buffer } = await downloadOriginal(row.imageUrl, AbortSignal.timeout(45000), http);
    if (sha256(buffer) !== sourceMetadata(row).sha256) throw new Error('source_changed');
    return { checkedAt: new Date().toISOString(), bytes: buffer.length };
}

function parseResult(line, snapshot, batchId) {
    if (line.custom_id !== snapshot.customId) throw new Error('wrong_custom_id');
    if (line.error || line.response?.status_code !== 200) throw new Error('batch_request_failed');
    const body = line.response.body;
    if (!body || body.status !== 'completed' || body.error || body.incomplete_details) throw new Error('incomplete_response');
    if (body.model !== MODEL && !body.model?.startsWith(`${MODEL}-`)) throw new Error('unexpected_response_model');
    const content = (body.output || []).flatMap(item => item.content || []);
    if (content.some(item => item.type === 'refusal')) throw new Error('model_refusal');
    const text = body.output_text || content.filter(item => item.type === 'output_text').map(item => item.text).join('');
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('invalid_response_json'); }
    const result = normalizeAssessment(raw, sourceMetadata(snapshot));
    Object.assign(result.assessment, {
        model: MODEL, version: VERSION, promptSha256: sha256(PROMPT), inputTransport: snapshot.batchInputTransport || 'original-url',
        batchReview: { batchId, customId: line.custom_id, requestId: line.response.request_id,
            retryOfBatchId: snapshot.retryOfBatchId || null,
            responseId: body.id, responseModel: body.model, usage: body.usage || {},
            prior: { decision: snapshot.websiteDecision, qualityTier: snapshot.websiteQualityTier,
                assessedAt: snapshot.websiteAssessedAt, assessment: snapshot.websiteAssessment } },
    });
    return result;
}

function indexResults(contents, snapshots) {
    const expected = new Set(snapshots.map(row => row.customId));
    const results = new Map();
    for (const line of contents.flatMap(text => text.split('\n')).filter(line => line.trim())) {
        const result = JSON.parse(line);
        if (!expected.has(result.custom_id)) throw new Error('unknown_result_id');
        if (results.has(result.custom_id)) throw new Error('duplicate_result_id');
        results.set(result.custom_id, result);
    }
    return results;
}

// One atomic compare-and-swap. Stale results and changes made by people win over
// this asynchronous review. The complete first assessment remains in JSONB.
async function applyResult(prisma, snapshot, result) {
    return prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET
      "websiteDecision"=$1, "websiteQualityTier"=$2, "websiteAssessment"=$3::jsonb, "websiteAssessedAt"=now()
      WHERE id=$4 AND "imageUrl"=$5 AND "websiteStatus"='READY' AND "websiteDecision"='REVIEW'
      AND "websiteQualityTier" IS NOT DISTINCT FROM $6
      AND "websiteAssessedAt"=$7::timestamptz AND "websiteAssessment"=$8::jsonb
      AND "websiteOverride" IS NULL AND "websiteClaimToken" IS NULL AND "websiteLeaseUntil" IS NULL`,
    result.decision, result.qualityTier, JSON.stringify(result.assessment), snapshot.id, snapshot.imageUrl,
    snapshot.websiteQualityTier, snapshot.websiteAssessedAt, JSON.stringify(snapshot.websiteAssessment));
}

module.exports = { MODEL, VERSION, PROMPT, SCHEMA, sha256, sourceMetadata, buildRequest, verifySource,
    parseResult, indexResults, applyResult };

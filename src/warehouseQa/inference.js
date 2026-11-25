const engine = require('./engine');
const { hash, fail } = require('./common');
const { MODEL, TIMEOUT_MS, settings } = require('./modelConfig');
const { executionHash } = require('./execution');
function requestHash(request) {
  const input = { ...request };
  delete input.request_id;
  return hash(input);
}

class QaInference {
  constructor({ repository, apiKey, fetchImpl = fetch }) {
    this.repository = repository;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async evaluate(row) {
    const { request, schema, prompt, host } = engine.aiRequest(row, row.as_of_date);
    const provenance = {
      request_hash: requestHash(request),
      prompt_hash: hash(prompt),
      output_schema_hash: hash(schema),
      profile_hash: engine.profileHash,
      engine_version: engine.profile.engine_version,
      execution_hash: executionHash,
      settings
    };
    const fingerprint = hash(provenance);
    const cached = await this.repository.cache('inference:' + fingerprint);
    if (cached) {
      // Validation also runs on cached output. A corrupt cache is never accepted.
      if (
        !cached.validated ||
        cached.fingerprint !== fingerprint ||
        requestHash(cached.request) !== provenance.request_hash
      )
        fail(502, 'QA_CACHE_MISMATCH', 'Cached evaluation does not match this snapshot and profile.');
      const checks = engine.acceptAi(row, cached.request, cached.raw_output);
      return {
        result: engine.assemble(row, [...host, ...checks], { ...cached.model, cache_hit: true }),
        artifact: cached
      };
    }
    if (!request.requested_checks.length) {
      return {
        result: engine.assemble(row, host, { model_requested: MODEL, call_required: false }),
        artifact: { provenance }
      };
    }
    if (!this.apiKey()) fail(503, 'QA_OPENAI_NOT_CONFIGURED', 'OpenAI is not configured on the server.');
    const started = Date.now();
    let response;
    try {
      response = await this.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: 'Bearer ' + this.apiKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          input: [
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify(request) }
          ],
          text: { format: { type: 'json_schema', name: 'warehouse_qa_checks', strict: true, schema } }
        })
      });
    } catch {
      fail(502, 'QA_OPENAI_TRANSPORT', 'OpenAI timed out or could not be reached.');
    }
    if (!response.ok)
      fail(502, 'QA_OPENAI_HTTP_' + response.status, 'OpenAI rejected the evaluation request.');
    const data = await response.json();
    if (data.status !== 'completed') fail(502, 'QA_MODEL_INCOMPLETE', 'The AI evaluation did not complete.');
    const content = (data.output || []).flatMap((item) => item.content || []);
    if (content.some((item) => item.type === 'refusal'))
      fail(502, 'QA_MODEL_REFUSAL', 'The AI evaluation was refused.');
    const output = JSON.parse(
      content
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text)
        .join('')
    );
    const accepted = engine.acceptAi(row, request, output);
    const model = {
      model_requested: MODEL,
      model_returned: data.model,
      response_id: data.id,
      usage: data.usage,
      latency_seconds: (Date.now() - started) / 1000,
      provenance,
      cache_hit: false
    };
    const artifact = {
      fingerprint,
      request,
      raw_output: output,
      model,
      validated: true,
      completed_at_utc: new Date().toISOString()
    };
    await this.repository.putCache('inference:' + fingerprint, artifact);
    return { result: engine.assemble(row, [...host, ...accepted], model), artifact };
  }
}
module.exports = { QaInference, MODEL, TIMEOUT_MS };

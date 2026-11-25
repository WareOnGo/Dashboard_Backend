const engine = require('./engine');
const { MODEL, TIMEOUT_MS } = require('./inference');
const { QaError } = require('./common');
const { exclusion } = require('./eligibility');
const { executionHash, blockedResult } = require('./execution');
const MAX_ATTEMPTS = 3;

class QaWorker {
  constructor({ repository, inference, logger = console, runBy = 'Raghav' }) {
    this.repository = repository;
    this.inference = inference;
    this.logger = logger;
    this.runBy = runBy;
    this.active = null;
    this.timer = null;
    this.stopping = false;
  }

  async process(item) {
    const reason = exclusion(item.snapshot);
    if (reason) {
      await this.repository.transaction(async (repo) => {
        if (!(await repo.skip(item))) return;
        await repo.event({
          runId: item.runId,
          warehouseId: item.warehouseId,
          actor: { id: 'qa-engine', name: 'Warehouse QA engine' },
          action: 'QA_SKIPPED',
          payload: {
            scope: 'PER_WHID',
            reason,
            runBy: this.runBy,
            snapshot_id: item.snapshot.snapshot_id,
            profile_hash: engine.profileHash,
            warehouse_writes: 0
          }
        });
      });
      return;
    }
    let outcome;
    try {
      const run = await this.repository.run(item.runId);
      if (run?.metadata.execution_hash !== executionHash) {
        outcome = { error: 'QA_EXECUTION_CHANGED', result: blockedResult(item.snapshot, run?.metadata) };
      } else {
        if (item.attempts > MAX_ATTEMPTS)
          throw new QaError(502, 'QA_ATTEMPTS_EXHAUSTED', 'Evaluation attempts exhausted.');
        outcome = await this.inference.evaluate(item.snapshot);
      }
    } catch (error) {
      // Only controlled error codes enter logs or records; never provider bodies,
      // API credentials, query text or arbitrary model-generated error messages.
      const code = error instanceof QaError ? error.code : 'QA_INVALID_RESPONSE';
      const retry =
        item.attempts < MAX_ATTEMPTS &&
        ![
          'QA_OPENAI_NOT_CONFIGURED',
          'QA_OPENAI_HTTP_401',
          'QA_OPENAI_HTTP_403',
          'QA_OPENAI_HTTP_400'
        ].includes(code);
      outcome = {
        error: code,
        retry,
        result: retry ? null : engine.failed(item.snapshot, item.snapshot.as_of_date, MODEL, code)
      };
    }
    await this.repository.transaction(async (repo) => {
      await repo.lock('qa-warehouse-review:' + item.warehouseId);
      if (outcome.result) outcome.result.version = item.result ? item.result.version + 1 : 0;
      if (!(await repo.finish(item, outcome))) return;
      await repo.event({
        runId: item.runId,
        warehouseId: item.warehouseId,
        actor: { id: 'qa-engine', name: 'Warehouse QA engine' },
        action: outcome.retry
          ? 'QA_RETRY_SCHEDULED'
          : outcome.error
            ? 'QA_EVALUATION_FAILED'
            : 'QA_EVALUATED',
        payload: {
          scope: 'PER_WHID',
          runBy: this.runBy,
          attempt: item.attempts,
          snapshot_id: item.snapshot.snapshot_id,
          response_id: outcome.result?.model?.response_id || null,
          error: outcome.error || null,
          profile_hash: engine.profileHash,
          execution_hash: executionHash,
          warehouse_writes: 0
        }
      });
      if (!outcome.error && !outcome.retry && outcome.result?.coverage.ai_status === 'COMPLETED')
        await repo.supersedeUntouchedReviews(item.warehouseId, this.runBy);
    });
  }

  drain(budgetMs = 75000) {
    // One pump per process; DB claims fence other application instances.
    if (this.active) return this.active;
    const deadline = Date.now() + budgetMs;
    const lane = async () => {
      while (!this.stopping && Date.now() + TIMEOUT_MS + 1000 < deadline) {
        const item = await this.repository.claim();
        if (!item) return;
        await this.process(item);
      }
    };
    this.active = Promise.allSettled([lane(), lane()])
      .then((results) => {
        if (results.some((result) => result.status === 'rejected'))
          this.logger.error('Warehouse QA queue operation failed; expired leases will be retried.');
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.drain();
    }, 25000);
    this.timer.unref();
    void this.drain();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }
}
module.exports = { QaWorker, MAX_ATTEMPTS };

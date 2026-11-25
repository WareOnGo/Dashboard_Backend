# Deferred: hourly warehouse QA and alerts

**Status: later phase, outside the manual QA release.** The manual dashboard flow does not require a scheduler, cron secret, forward-scan timestamp or automated alerts. Do not install or enable the timer as part of the manual rollout. The backend worker only processes explicitly queued work; it does not select new warehouses on its own.

## Hourly selection

When forward QA is requested, use `POST /api/ai-qa/cron` with the separate `X-AI-QA-Token` credential. Its first scan requires an explicit ISO start timestamp with timezone. Selection uses `(createdAt, id)` ordering, a fixed upper watermark, a two-minute settling delay and a one-hour overlap. Source capture remains read-only. The cursor and queued items commit together; overlapping scans cannot enqueue the same forward evaluation twice. Backdated records older than the overlap and records without creation timestamps need explicit backfill IDs.

Persist each page's request ID before sending and reuse it after a lost response. Continue `has_more:true` with a new ID. Drain queued work explicitly through `/cron/drain`; an hourly enqueue alone does not guarantee completion on a host that suspends background CPU. The cron token can process work and read queue health, but cannot approve flags or access warehouse review data. Employee assignments still require an admin's approval.

## Existing scaffolding to verify later

`scripts/runWarehouseQaCron.js` is an HTTP driver, not a separate QA engine. It persists a resumable checkpoint, follows continuation pages and drains the native queue. `deploy/warehouse-qa-cron.service` and `.timer` are inactive systemd templates. They have not been installed or enabled in production.

The runner needs Node 22, API connectivity, a durable checkpoint and exactly one checkpoint writer. The service template supplies `flock`, state directories and an hourly persistent timer. Adapt the account, working directory and Node executable to the actual runner host; another scheduler is acceptable if it provides equivalent durability and exclusive execution.

Future runner configuration:

```text
AI_QA_API_URL=https://<backend-host>/api/ai-qa
AI_QA_CRON_SECRET=<a separate random secret of at least 32 characters>
AI_QA_FORWARD_START_AT=<explicit ISO timestamp with timezone>
AI_QA_CRON_STATE_FILE=<absolute durable checkpoint path>
```

Keep the secret in the backend and scheduler secret stores. Never put it in Vite/browser configuration. The driver saves each request before sending, uses a 105-second HTTP timeout and stops after a 55-minute invocation budget with its checkpoint intact. Do not delete the checkpoint to retry an uncertain request. The next invocation resumes it. Nonzero exit status or `ready:false` requires investigation.

## Alerting backlog

- Alert on scheduler failures, unavailable QA storage/configuration, active failed evaluations, expired leases and pending age approaching one hour. Use `/api/ai-qa/cron/health`; ordinary application health does not establish QA health.
- Record model latency, failures, usage and queue throughput. Establish provider spend/rate limits and appropriate alert thresholds from representative traffic. The five-warehouse pilot does not prove hourly capacity.
- Track execution-version mismatches during rollout. Old policy/engine/schema/model contracts fail explicitly without an AI call and require fresh evaluation under the new contract. Retain old findings and audit history.
- Test notifications and escalation with the intended operators. No notification destination has been configured, and no alert messages have been sent by this implementation.

## Acceptance before activation

Exercise actual hosting timeouts and CPU behavior, overlapping replicas and invocations, lost HTTP responses, process restarts, durable checkpoint recovery, provider/database outages, delayed retries, full continuation windows and backlog drainage. Keep the global concurrency setting consistent across replicas. Test the chosen production scheduler and alerts before enabling automatic selection.

To stop hourly selection later, disable the scheduler while leaving manual QA enabled. Preserve its checkpoint and QA audit tables. `AI_QA_ENABLED=false` disables the whole QA feature and is a separate emergency stop; it is not necessary merely to pause forward fill. Existing employee tasks remain in the normal review workflow.

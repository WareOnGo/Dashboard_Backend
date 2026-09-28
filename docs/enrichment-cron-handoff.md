# Enrichment cron ownership after EC2 handoff

Live destinations and execution were verified on 28 September 2026 before
removing the dashboard workers. No database schema, source media, image rows or
R2 objects are removed by this cleanup.

| Existing trigger | Current destination and responsibility |
|---|---|
| `sweep-warehouse-image-labels`, every 15 minutes | EC2 `POST /cron/enrichment`: scene labels, separate document subtype action, website approval and proximity |
| `geocode-recent`, 21:27 UTC / 02:57 IST | EC2 `POST /cron/geocode-recent` |
| `wareongo-website-nightly-build`, 20:30 UTC / 02:00 IST | CMS `/api/deploy` starts the website build and asks Render `/maintenance/webp`, which forwards to EC2 |
| Database backup, 22:30 UTC / 04:00 IST | Separate systemd backup timer on the enrichment EC2 host |

The four CRM pg_cron schedules remain part of the separate CRM application.
JPEG remains an explicit action; this handoff did not introduce a JPEG cron.

Verification checked the stored schedule destinations, successful EC2 parent
runs tagged `executor: warehouse-enricher`, the active backup timer, and matching
WebP job ID/status/executor from Render and EC2. None of the active enrichment
schedules targeted the retired dashboard routes. Schedules and credentials were
left unchanged.

## Removed dashboard execution paths

- `/api/enrichment/sweep` and `/api/image-labels/sweep` and their processing code.
- Combined enrichment/proximity sweep services and worker-only repository methods.
- The scheduled website-assessment wrapper; its explicit local batch/backfill
  implementation remains available without an HTTP worker registration.
- The old App Runner cron creation, migration and deployment-verification scripts.

## Retained contracts

- Accepted warehouse writes and staged approvals still register images.
- `GET /api/image-labels/warehouse/:id`, `GET /api/image-labels/stats` and bulk
  warehouse image labels retain their authentication and response contracts.
- `Warehouse.media`, original image URLs, WebP/JPEG metadata, approval records,
  registry claims and retention history are preserved.
- PPT image selection and JPEG-to-original fallback are unchanged.
- Explicit image-label, website-assessment, JPEG, proximity, OSM-ingestion and
  review tools keep the modules they call. They are maintenance tools, not
  alternate scheduled workers. Coordinate any manual run with the EC2 worker.

The website backend retains its authenticated maintenance forwarding route,
approved gallery selection and explicit table-driven compression CLI. Its
unused Redis job runner and earlier photo-column-only compressor are retired.
Website builds still run independently of image processing.

For current action APIs, budgets, run status, deployment and rollback, use the
[enrichment architecture](https://github.com/rs0125/procurement-enrichment/blob/main/docs/ARCHITECTURE.md)
and [cron runbook](https://github.com/rs0125/procurement-enrichment/blob/main/docs/CRON_MIGRATION.md).
An old backend release can restore retired code, but must not be rescheduled
alongside the EC2 worker. No data rollback is required for this code cleanup.

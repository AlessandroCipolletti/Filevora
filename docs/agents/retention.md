# Retention and cleanup

Retention is off until `FILES_RETENTION_ENABLED=true`. It also needs `FILES_RETENTION_MAX_AGE_DAYS` or `FILES_UNUSED_RETENTION_DAYS`. `FILES_RETENTION_GRACE_DAYS` defaults to 7. `0` deletes on the first sweep. `FILES_CLEANUP_INTERVAL_MINUTES` defaults to 60.

`maxAgeDays` is measured from creation. `unusedAfterDays` is measured from the last request. A file is removed only when one of those windows has fully elapsed. Pins are kept.

## Last request

Issuing a delivery URL sets `last_accessed_at` on the asset.

Stored mode writes that column on `filevora_assets`. `filevora migrate` adds it when an older database does not have it.

Lite mode has no database server. The same field is stored on the asset card under the object root. That card is the source of truth. Redis is not used for this timestamp, because a flushed Redis would forget a recent request. If the card has no timestamp, cleanup uses `created_at`, so a file is not deleted before the configured lifetime measured from creation. An object that is newer than the cleanup interval is not treated as an orphan.

## What cleanup removes

- Expired assets, including every version object. Stored rows are soft-deleted the same way as `DELETE`: `deleted_at` is set, `processing_state` becomes `deleted`, and version rows become `status = 'deleted'`. Grace `0` removes the objects on that sweep.
- Incomplete uploads older than the upload session TTL.
- Partial download files and version files that have no original, once they are older than the cleanup interval. A fresh encode is left alone.

## How to run it

The worker schedules a BullMQ job on the processing queue at `FILES_CLEANUP_INTERVAL_MINUTES` when retention is enabled. The job is not a dry-run.

On demand:

- `POST /retention/cleanup` with `{ "dryRun": true }` or `{ "dryRun": false }`
- `filevora cleanup --dry-run --json --tenant <id>`

The report lists `filesEligible`, `filesDeleted`, `items`, and `orphans`. A real sweep also appends `/.filevora/cleanup.log`.

# Changelog

## 0.1.0

### M0 — Foundations

- Public package `filevora` with imports `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, and `filevora/types`.
- Typed configuration, secret redaction, and the stable error catalog.
- `managed`, `hybrid`, and cloud processing fail with `FEATURE_NOT_AVAILABLE`.
- CLI: `filevora capabilities --json` and `filevora config validate --json`.
- Upload storage, the browser client, and the worker are not implemented. Calling them fails closed.

### M1 — Local storage and metadata

- Filesystem driver with opaque keys, SQLite migrations, and tenant-scoped create, read, list, and delete.
- HTTP chunked upload and HMAC download tokens. A signed URL stops working after delete.
- `examples/node-minimal` uploads a PNG and reads it back after a process restart.
- S3, Postgres, the browser client, and the worker remain unavailable.

### M2 — Browser client and resumable uploads

- `createUploadClient` sends parts, reports progress, and can pause, resume, cancel, and retry.
- A second client with the same resume store finishes an interrupted upload. The checksum matches and the file is not duplicated.
- Expired and unknown sessions fail with catalog errors.
- Two files can be in flight together. IndexedDB resume records round-trip in the test environment.

### M3 — Queue and embedded worker

- SQLite jobs use leases, retries, and idempotency keys.
- The first queued job spawns one child worker. A second call reuses the live pid.
- Killing that child releases the lease. The job succeeds once, with `attempts >= 2`.
- Preset jobs fail with `PROCESSOR_UNAVAILABLE` because no image or video processor is registered.
- `filevora doctor --json` reports Node, config, storage, SQLite, and FFmpeg. FFmpeg is a warning when missing.

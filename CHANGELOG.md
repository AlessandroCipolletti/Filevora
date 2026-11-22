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

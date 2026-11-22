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

### M4 — Image variants

- Sharp writes `thumbnail` (320), `optimized` (1280), and `hd` (1920) WebP variants.
- Variants are not enlarged past the source. A second job does not publish duplicate rows.
- Private delivery tokens return the WebP bytes. The original checksum is unchanged.
- Images over `imageMaxPixels` fail the job and leave no variant. The original remains.

### M5 — Video and audio

- FFmpeg and ffprobe are spawned with argument arrays and `shell: false`. A missing binary fails with `FFMPEG_NOT_FOUND`.
- Video presets write an H.264 MP4 capped at the source size and a WebP poster. Sharp encodes the poster. FFmpeg is not asked for a WebP encoder.
- A 240p source does not get an HD variant. Audio presets write AAC in an M4A file.
- Typed trim and transcode recipes are allowlisted. A timeout kills FFmpeg with `PROCESSING_TIMEOUT`. Aborting the signal kills it with `CANCELLED`.
- The integration test records the FFmpeg pid and checks its parent is the worker child. A metadata read during that encode returned in under one second.

### M6 — S3-compatible storage

- The S3 driver signs multipart part URLs and download URLs. The AWS SDK is optional and is loaded only when the driver is selected.
- Tests upload through the browser client straight to an in-process path-style emulator. The secret is absent from the session JSON and the PUT URL. The downloaded bytes match the PNG.
- Filesystem uploads still complete in the same test file.
- `filevora init --profile local-s3` writes a MinIO Compose file and does not start Docker. MinIO itself was not run.

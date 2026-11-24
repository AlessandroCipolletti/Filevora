# Direct S3 upload

Server signs. Client writes to S3. Complete verifies and starts processing.

- `POST /uploads/direct` body `{ filename, mimeType, bytes, mode?: "single" | "multipart", preset? }`.
- `mode` defaults from `storage.s3.multipartThresholdBytes` (16 MiB).
- Rejects when `storage.driver` is not `s3` (`INVALID_CONFIG`).
- Rejects when `bytes` exceeds `defaults.maxFileBytes` (`FILE_TOO_LARGE`).
- Single response: `url`, `headers`, `expiresAt`, `sessionId`, `fileId`, `key`. PUT the exact bytes with `headers`.
- Multipart response: `uploadId`, `partSize`, `parts[{ partNumber, url, expiresAt }]`. PUT each part. Read `ETag`.
- `POST /uploads/direct/:sessionId/complete` body `{ parts?: [{ partNumber, etag }] }`. Single uploads send `{}`.
- Complete heads the object, checks size, sniffs type, strips EXIF per `safety.exif`, scans when a scanner is configured, enforces type limits, then queues the preset. SSE and webhooks are the normal processing events.
- Signed URL lifetime is `storage.s3.uploadGrantTtlSeconds` (900). Session lifetime is `upload.sessionTtlSeconds`.
- Bucket CORS must allow `PUT` from the app origin and expose `ETag`.
- Client: `createUploadClient().uploadDirect(file, { mimeType, mode?, onProgress? })`. No Node builtins.

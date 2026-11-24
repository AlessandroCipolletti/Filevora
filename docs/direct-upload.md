# Direct upload to S3

When storage is S3, a client can PUT bytes straight to the bucket. Filevora signs the request, then checks the object and starts the same processing pipeline as a normal upload.

Filesystem storage cannot sign an upload. `createDirectUpload` fails with `INVALID_CONFIG` and the chunked session API is the path to use.

## Create

`POST /uploads/direct`

```json
{
  "filename": "photo.png",
  "mimeType": "image/png",
  "bytes": 12345,
  "mode": "single"
}
```

`mode` is `single` or `multipart`. When it is omitted, files at or above `FILES_S3_MULTIPART_THRESHOLD_BYTES` (default 16 MiB) use multipart. A file larger than `maxFileBytes` is `FILE_TOO_LARGE`. A signed URL expires after `uploadGrantTtlSeconds` (default 900). The session itself expires after `sessionTtlSeconds`.

A single upload returns `url` and `headers`. Send a `PUT` of the exact byte length with those headers. The signature includes `Content-Type` and `Content-Length`.

A multipart upload returns `uploadId`, `partSize`, and `parts`. `PUT` each part URL and keep the `ETag`. Parts can be retried until the session expires.

## Complete

`POST /uploads/direct/:sessionId/complete`

```json
{ "parts": [{ "partNumber": 1, "etag": "\"abc\"" }] }
```

A single upload sends `{}`. Filevora heads the object, checks the size, sniffs the type, applies the EXIF policy to JPEG and PNG originals, runs the malware scanner when one is configured, checks type size limits, and queues the asset preset. Progress and webhooks then match any other upload.

## CORS

The bucket has to allow the browser origin:

```json
{
  "AllowedOrigins": ["https://app.example"],
  "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}
```

`ETag` must be exposed or the browser cannot read the part etag.

## Client

```ts
import { createUploadClient } from 'filevora/client';

const client = createUploadClient({ endpoint: '/api/files' });
const record = await client.uploadDirect(file, {
  mimeType: file.type || 'application/octet-stream',
  onProgress: (progress) => console.log(progress.percentage),
});
await client.waitForProcessing(record.id);
```

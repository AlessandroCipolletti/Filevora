# Filevora

Filevora is a headless TypeScript SDK for the file lifecycle: resumable upload, private storage, background derivatives, and short-lived delivery. It runs inside your Node app. There is no Filevora account, API key, or hosted control plane.

Your application keeps users, permissions, and business records. Filevora keeps bytes, versions, and processing jobs.

The package is not on npm yet. Install it from this repository. Node `>=22.13`.

## Contents

- [Quick start](#quick-start)
- [Lite and stored](#lite-and-stored)
- [Features](#features)
- [Library methods](#library-methods)
- [HTTP API](#http-api)
- [SDK](#sdk)
- [CLI](#cli)
- [For coding agents](#for-coding-agents)
- [Develop this repository](#develop-this-repository)

## Quick start

**1. Create the server.** With no database URL this is lite mode: files on disk, no metadata database.

```ts
import { createFiles } from 'filevora/server';

const files = createFiles({
  storage: { driver: 'filesystem', root: './.files/objects' },
});
```

`createFiles` validates configuration and does not start a worker. The object directory opens on the first upload.

**2. Mount the HTTP handler.** You authenticate the caller. Filevora ignores `ownerId` and `tenantId` in the request body.

```ts
import { createFilesHandler } from 'filevora/http';

const handler = createFilesHandler({
  files,
  health: true,
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});
```

`handler` is `(request: Request) => Promise<Response>`. In Node, pass it through `handleNodeRequest` from `filevora/http`. `health: true` serves `GET /health` with no principal. A working host is in [examples/node-minimal](examples/node-minimal).

**3. Upload from the browser.** `complete()` resolves when the original is stored. Encoding may still be running.

```ts
import { createUploadClient } from 'filevora/client';

const client = createUploadClient({ endpoint: '/api/files' });
const uploaded = await client.upload(file).complete();
```

**4. Run a worker** so queued image, video, audio, and webhook jobs finish. Several machines can share one Redis URL.

```bash
REDIS_URL=redis://127.0.0.1:6379 npx filevora worker
```

The package is ESM (`"type": "module"`). Node 22.13 and newer can also `require('filevora/server')` and the other entry points. `filevora --version` and `filevora worker` run the CLI.

To scaffold the handler, a client snippet, and an env file without prompts:

```bash
npx filevora init --framework express --mode lite --dry-run --json
```

## Lite and stored

Mode follows the environment. Omit `FILEVORA_DATABASE_URL` and the SDK uses **lite**. Set that URL and it uses **stored**. `FILEVORA_METADATA_MODE` can override the choice. Stored mode without a database URL throws `INVALID_CONFIG`.

| | Lite | Stored |
| --- | --- | --- |
| When | No `FILEVORA_DATABASE_URL` | `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlite://`, or a SQLite file path |
| Metadata | A JSON card next to the object | Your database. `filevora migrate` creates only `filevora_assets` and `filevora_asset_versions` |
| `GET /assets` | `FEATURE_REQUIRES_STORED_MODE` | Id list. Stored mode only |
| Queue | Redis (BullMQ) in both modes. Asset ids are not stored in Redis | Same |
| Object key | `{tenantHash}/{assetId}_{version}.{ext}` in both modes | Same |

`mariadb://` is rewritten to `mysql://`. Auto-migrate is on unless `FILEVORA_AUTO_MIGRATE` turns it off. Names and defaults are in [.env.example](.env.example). Rules are in [docs/configuration.md](docs/configuration.md).

## Features

Each line is implemented in this package. Status of what an automated test covers is in the [capability manifest](docs/agents/capabilities.json). Deeper notes stay in the linked docs.

- **Upload.** Resumable chunked sessions, pause, retry, and resume after refresh. `complete()` means the original is stored. Pass `preset` to choose the versions. [docs/agents/install.md](docs/agents/install.md)
- **Presets.** Named image, video, and PDF recipes (`thumbnail`, `avatar`, `og-image`, `hero`, `social-square`, `video-480p`, `video-720p`, `video-1080p`, `video-preview`, `poster`, `thumbnails`, `sprites`, `pdf-pages`, `pdf-cover`) plus the default `web-optimized` set. `FILES_THUMBNAIL_WIDTH` is `320` or `480` (default `480`) for the image thumbnail and the legacy video poster. Custom presets use the same operations as transform. [docs/presets.md](docs/presets.md)
- **URL import.** `POST /assets/from-url` returns an asset id, then the SDK downloads the URL, sniffs the bytes, and queues the same encoding jobs. Private and metadata addresses are rejected. [docs/configuration.md](docs/configuration.md)
- **Transform.** One config object: `image.resize`, `image.crop`, `video.resize`, `video.crop`, `video.trim`, `pdf.removePages`. `replace` defaults to true. [docs/agents/transform.md](docs/agents/transform.md)
- **Processing.** Image presets write WebP thumbnail, optimized, and HD with Sharp and do not enlarge the source. Video presets write an H.264 MP4, a WebP poster, thumbnail strips, and sprite sheets with a VTT and JSON timeline. Audio presets transcode to MP3, AAC, Opus, or WAV, normalize loudness with EBU R128, and write a waveform plus probe metadata. The default `web-optimized` audio path still writes AAC in an M4A file. PDF text extraction reads literal text, including a per-page JSON description (`pdf-text`). `POST /pdf/merge` and `POST /files/:id/split` build new PDFs. LibreOffice (`soffice`) converts Office files when it is installed (`office-pdf`); `filevora doctor` warns when it is missing. `pdftoppm` from Poppler renders page thumbnails (`pdf.pages`, presets `pdf-pages` and `pdf-cover`) and a PNG of page 1 during normalize. A missing binary leaves text extraction working and fails page images with `PROCESSOR_UNAVAILABLE`. CSV and XLSX return row counts. OCR returns `OCR_NOT_CONFIGURED`.
- **Progress.** `GET /files/:fileId/progress` is one event shape for upload, download, and processing: `phase`, `state`, `percentage`, `etaMs`, and a terminal `versions` list. SSE is the default. JSON is the fallback. The browser client sends the host `Authorization` header.
- **Versions and delivery.** `GET /files/:fileId/versions` returns signed URLs. `_original` is available as soon as the upload is verified, including while encoding is queued or after it fails.
- **Webhooks.** Optional `FILEVORA_WEBHOOK_URL` or a per-request `webhook`. Events are `upload.completed`, `processing.completed`, `processing.failed`, and `transform.completed`. The body is the terminal progress event, HMAC-signed. [docs/agents/webhooks.md](docs/agents/webhooks.md)
- **Retention and cleanup.** `FILES_RETENTION_*` and `FILES_UNUSED_RETENTION_DAYS`. A delivery URL updates `last_accessed_at` (the asset row in stored mode, the asset card in lite). Cleanup also removes old orphans. Pins are kept. [docs/agents/retention.md](docs/agents/retention.md)
- **Upload safety.** Optional ClamAV scan after the original is stored and before encoding. No scanner means the scan is skipped. `FILEVORA_EXIF_STRIP` defaults to `gps`. `FILEVORA_TYPE_MAX_BYTES` limits size by the sniffed type, not the extension.
- **Test helpers.** `filevora/testing` uses a temporary filesystem, lite mode, and synchronous processing. No Redis or S3. [docs/agents/testing.md](docs/agents/testing.md)
- **Init and doctor.** `filevora init` detects Express, Fastify, Hono, Next.js, or Node and writes files only with `--force` when they already exist. The env template sets `FILES_DEFAULT_PRESET`. `filevora doctor` checks config, mode, storage, Redis, the database, ffmpeg, ffprobe, the scanner, webhooks, and that the default preset exists. `health: true` serves that report. [docs/agents/init.md](docs/agents/init.md) · [docs/agents/doctor.md](docs/agents/doctor.md)
- **Manifest and MCP.** `filevora manifest --json` and `readManifest()` return the versioned capability document. `filevora mcp` exposes lookup, config validation, and doctor over stdio with no extra dependency. [docs/agents/manifest.md](docs/agents/manifest.md)
- **Storage.** Filesystem, or S3-compatible storage via `FILES_S3_BUCKET`, `FILES_S3_REGION`, `FILES_S3_ENDPOINT`, `FILES_S3_ACCESS_KEY_ID`, and `FILES_S3_SECRET_ACCESS_KEY`. Clients can PUT straight to S3 with a signed single or multipart upload; complete verifies the object and starts processing ([docs/direct-upload.md](docs/direct-upload.md)). `filevora init --profile local-s3` writes a MinIO Compose file and does not start Docker. Postgres tables use `FILES_POSTGRES_SCHEMA` (default `filevora`).
- **Descriptions.** Optional Gemini descriptions for images, video, audio, and PDFs. Stored mode only. `describe` overrides `FILEVORA_DESCRIBE_ASSETS` (default off). Content is sent to Google only when a description runs. [docs/descriptions.md](docs/descriptions.md)
- **Framework helpers.** `filevora/next`, `filevora/express`, `filevora/fastify`, and `filevora/hono` adapt the HTTP handler. `filevora/react` exports `useUpload` and `useAssetProgress` and renders no UI. `filevora/client` stays free of Node builtins. [docs/frameworks.md](docs/frameworks.md)
- **Metadata databases.** Lite has none. Stored uses PostgreSQL, MySQL or MariaDB, or SQLite, chosen by the database URL scheme.
- **Access control.** Assets are `private` or `public` (default `private`). Private downloads use HMAC `/content` URLs or S3 presigned URLs. Public downloads use `/public`. `signUrl` signs a version. `POST /files/:assetId/revoke-urls` invalidates older links. [docs/access-control.md](docs/access-control.md)

`provider: "managed"` throws `FEATURE_NOT_AVAILABLE`. This package does not bill, issue accounts, or render a UI.

## Library methods

Every feature is a typed method you can call in process from `filevora/server`. You do not need the HTTP handler or `filevora/client`. Each HTTP route calls the method listed next to it in the [HTTP API](#http-api) table, so validation, limits, and error codes are the same.

```ts
import { createFiles, isFileSdkError } from 'filevora/server';

const files = createFiles({
  storage: { driver: 'filesystem', root: './.files/objects' },
});
const ctx = { principal: { id: 'user-1', tenantId: 'acme' } };
```

Instance methods take a `ctx` (`RequestContext`) as their last argument. `ctx.principal` is the caller your app has already authenticated, and its `tenantId` scopes every read and write. You can also set `ctx.policy` (`UploadPolicy`: `maxFileBytes`, `allowedMimeTypes`, `ownerId`) to narrow upload limits. Filevora does not check permissions here; your app decides what the principal may do before it calls a method.

Failures throw a `FileSdkError` with a stable `code` (see [docs/errors](docs/errors)). `isFileSdkError(error)` narrows it. Methods that need stored mode throw `FEATURE_REQUIRES_STORED_MODE` or `DESCRIPTION_REQUIRES_DATABASE` in lite mode.

```ts
try {
  await files.get('file_missing', ctx);
} catch (error) {
  if (isFileSdkError(error) && error.code === 'ASSET_NOT_FOUND') {
    // 404 in your app
  }
}
```

### Upload

**`createUploadSession(input, ctx): Promise<UploadSession>`** starts a resumable upload. `input` is `{ filename, mimeType, bytes, checksum?, idempotencyKey?, preset?, metadata?, visibility?, webhook?, describe? }`. Parts are `session.partSize` bytes, and the last part holds the rest. Errors: `INVALID_CONFIG` (missing fields), `FILE_TOO_LARGE`, `UNSUPPORTED_MIME`, `CHECKSUM_MISMATCH` (not a SHA-256 hex digest), `IDEMPOTENCY_CONFLICT`, `QUOTA_EXCEEDED`, `TRANSFORM_REJECTED` (unknown preset), `FORBIDDEN` (public files disabled).

**`writePart(sessionId, partNumber, body, ctx): Promise<{ partNumber, etag, bytes }>`** stores one part. `body` is a `Uint8Array`. Errors: `UPLOAD_PART_MISSING` (part number outside the session), `UPLOAD_SIZE_MISMATCH`, `UPLOAD_SESSION_EXPIRED`, `NOT_FOUND`.

**`completeUpload(sessionId, { parts?, checksum? }, ctx): Promise<FileRecord>`** assembles and sniffs the original, then queues the preset. Errors: `UPLOAD_PART_MISSING`, `UPLOAD_SIZE_MISMATCH`, `MIME_MISMATCH`, `UNSUPPORTED_MIME`, `CHECKSUM_MISMATCH`, `FILE_TOO_LARGE`.

```ts
const bytes = new Uint8Array(await readFile('photo.png'));
const session = await files.createUploadSession(
  { filename: 'photo.png', mimeType: 'image/png', bytes: bytes.byteLength, preset: 'avatar' },
  { ...ctx, policy: { maxFileBytes: 5_000_000 } },
);
for (let part = 1; part <= session.partCount; part += 1) {
  const start = (part - 1) * session.partSize;
  await files.writePart(session.id, part, bytes.subarray(start, start + session.partSize), ctx);
}
const file = await files.completeUpload(session.id, {}, ctx);
```

**`getUploadSession(sessionId, ctx): Promise<UploadSession>`** reads a session. **`abortUpload(sessionId, ctx): Promise<void>`** aborts it and removes stored parts; a verified session throws `INVALID_CONFIG`. **`partUploadUrls(sessionId, ctx): Promise<Record<string, string>>`** returns presigned part URLs for an S3 multipart session, and `{}` on filesystem storage.

```ts
const current = await files.getUploadSession(session.id, ctx);
if (current.status !== 'verified') await files.abortUpload(session.id, ctx);
```

**`createDirectUpload(input, ctx): Promise<DirectUploadGrant>`** signs a single PUT or multipart part URLs straight to S3. `input` is `{ filename, mimeType, bytes, mode?: 'single' | 'multipart', preset?, describe? }`. Filesystem storage throws `INVALID_CONFIG`. **`completeDirectUpload(sessionId, { parts?, describe? }, ctx): Promise<FileRecord>`** heads the object, checks the size and sniffed type, applies the EXIF policy and the scanner, and queues processing. Errors: `UPLOAD_PART_MISSING`, `UPLOAD_SIZE_MISMATCH`, `MIME_MISMATCH`, `UNSUPPORTED_MIME`. See [docs/direct-upload.md](docs/direct-upload.md).

```ts
const grant = await files.createDirectUpload({ filename: 'clip.mp4', mimeType: 'video/mp4', bytes: size }, ctx);
await fetch(grant.url!, { method: 'PUT', headers: grant.headers, body });
const file = await files.completeDirectUpload(grant.sessionId, {}, ctx);
```

**`createFromUrl({ url, preset?, visibility?, webhook?, describe? }, ctx): Promise<FileRecord>`** returns the asset before the download finishes, then downloads, sniffs, and queues the preset. Errors: `INVALID_CONFIG` (no `url`), `REMOTE_URL_SCHEME`, `REMOTE_URL_CREDENTIALS`, `REMOTE_URL_PORT`, `REMOTE_URL_HOST`, `REMOTE_URL_BLOCKED`.

```ts
const imported = await files.createFromUrl({ url: 'https://example.com/logo.png', preset: 'thumbnail' }, ctx);
```

### Read and list

**`get(fileId, ctx, { detailed? }): Promise<FileRecord>`** reads one asset. `detailed` defaults to `true` (the HTTP route defaults to `false` in lite mode). Error: `ASSET_NOT_FOUND`.

**`getMany(assetIds, ctx): Promise<FileRecord[]>`** reads many assets in request order and skips missing or deleted ids. More than 20 ids return summary `asset` blocks. Lite mode throws `FEATURE_REQUIRES_STORED_MODE` above 20 ids.

```ts
const one = await files.get(file.id, ctx);
const many = await files.getMany([file.id, imported.id], ctx);
```

**`list(query, ctx): Promise<Page<FileRecord>>`** lists the tenant's assets. `query` (`ListQueryInput`) takes `type`, `createdFrom`/`createdTo`, `updatedFrom`/`updatedTo`, `mime`, `filename`, `sizeMin`/`sizeMax`, `durationMin`/`durationMax`, `widthMin`/`heightMin`, `status`, `visibility`, `preset`, `sort`, `order`, `limit`, and `cursor`. `tags`, `tagsAll`, `tagCategory`, `q`, `descriptionStatus`, and `hasDescription` need stored mode and a Gemini key. Error: `LIST_QUERY_INVALID`. See [docs/list.md](docs/list.md).

**`listAssetIds({ limit?, cursor? }, ctx): Promise<{ assetIds, nextCursor }>`** returns ids only. Stored mode only.

```ts
const page = await files.list({ type: 'image', sort: 'created', order: 'desc', limit: 20 }, ctx);
const next = page.nextCursor ? await files.list({ type: 'image', cursor: page.nextCursor }, ctx) : null;
```

**`search(input, ctx): Promise<SearchFilesPage>`** runs semantic search over described assets. `input` (`SearchFilesInput`) is `{ query, minScore?, maxResults?, limit?, cursor? }` plus the list filters. Each hit has a `score`. Errors: `DESCRIPTION_REQUIRES_DATABASE`, `DESCRIPTION_NOT_CONFIGURED`, `SEARCH_QUERY_INVALID`, `EMBEDDING_UNAVAILABLE`. See [docs/search.md](docs/search.md).

```ts
const hits = await files.search({ query: 'a red bicycle at night', type: 'image', limit: 10 }, ctx);
```

**`delete(fileId, ctx): Promise<void>`** soft-deletes the asset, its versions, and its search vector. Error: `ASSET_NOT_FOUND`.

```ts
await files.delete(file.id, ctx);
```

### Processing

**`transform(assetId, request, ctx): Promise<TransformLaunch>`** queues a transform and returns `{ launched, jobId, assetId, sourceAssetId, replace }`. `request` (`TransformRequest`) is `{ operations?, preset?, replace?, webhook? }`. `replace` defaults to `true`; `false` creates a new asset id. Errors: `TRANSFORM_REJECTED` (names the field, the detected type, and the valid operations), `ASSET_NOT_FOUND`. See [docs/agents/transform.md](docs/agents/transform.md).

```ts
await files.transform(file.id, { operations: [{ op: 'image.resize', width: 640 }] }, ctx);
await files.transform(file.id, { preset: 'og-image', replace: false }, ctx);
```

**`mergePdfs(assetIds, ctx, describe?)`** merges 2 to 20 PDFs into a new asset and returns `{ assetId, jobId, sourceAssetIds }`. **`splitPdf(assetId, ranges, ctx, describe?)`** writes one new PDF per page range (1 to 20 ranges) and returns `{ sourceAssetId, assetIds, jobId }`. Error: `TRANSFORM_REJECTED` (not a PDF, or a count out of range).

```ts
const merged = await files.mergePdfs([pdfA.id, pdfB.id], ctx);
const split = await files.splitPdf(merged.assetId, [[1, 2], [3]], ctx);
```

**`describeAsset(fileId, ctx): Promise<FileRecord>`** queues or refreshes a Gemini description, which also writes the search vector. Stored mode only. Errors: `DESCRIPTION_REQUIRES_DATABASE`, `DESCRIPTION_NOT_CONFIGURED`. See [docs/descriptions.md](docs/descriptions.md).

```ts
const pending = await files.describeAsset(file.id, ctx);
```

**`normalize(fileId, { kind, schema?, invalidRows?, sheet? }, ctx)`** reads a PDF (text, page count, page-1 preview) or a CSV or XLSX table (`kind: 'tabular'`, optional column `schema`), and stores the result as the `normalized` JSON version. Error: `UNSUPPORTED_MIME`.

```ts
const table = await files.normalize(csv.id, { kind: 'tabular', schema: { columns: { email: { type: 'email', required: true } } } }, ctx);
```

**`listPresets(): PresetSummary[]`** lists built-in presets plus the custom presets in this instance's config. The module-level `listPresets(custom?)` does the same without an instance.

```ts
const names = files.listPresets().map((preset) => preset.name);
```

### Progress and jobs

**`processingSnapshot(fileId, ctx, { baseUrl? }): Promise<ProgressEvent>`** returns one progress event (`phase`, `state`, `percentage`, `etaMs`, `terminal`). With `baseUrl`, a terminal success includes `versions` with URLs.

**`watchProgress(fileId, ctx, { baseUrl?, intervalMs?, signal? }): AsyncGenerator<ProgressEvent>`** yields each changed snapshot until the terminal one. This is the stream `GET /files/:fileId/progress` sends as SSE. Image and document jobs yield only the terminal event. Abort `signal` to stop early. Error: `ASSET_NOT_FOUND`.

```ts
for await (const event of files.watchProgress(file.id, ctx, { baseUrl: 'https://app.example/api/files' })) {
  console.log(event.phase, event.state, event.percentage);
}
```

**`getJob(jobId, ctx): Promise<ProcessingJob>`** and **`cancelJob(jobId, ctx): Promise<ProcessingJob>`** read or cancel a queued job by the `jobId` that `transform`, `mergePdfs`, and `splitPdf` return. Error: `NOT_FOUND`. **`process(fileId, {}, ctx)`** queues the asset's preset again.

```ts
const job = await files.getJob(launch.jobId, ctx);
if (job.state === 'queued') await files.cancelJob(job.id, ctx);
```

### Delivery and access control

**`getDeliveryUrls(fileId, { baseUrl, expiresInSeconds? }, ctx): Promise<DeliveryResult>`** signs URLs for the original and every ready version. Public assets get `/public` URLs. Private S3 originals get presigned URLs. Errors: `NOT_FOUND` (upload not verified), `INVALID_CONFIG` (TTL outside 30 to 86400 seconds).

**`signUrl(assetId, { version?, expiresIn?, download?, ip?, baseUrl? }, ctx): Promise<{ url, expiresAt }>`** signs one `/content` URL. `ip` binds it to a client address. `download` sets the download file name.

```ts
const delivery = await files.getDeliveryUrls(file.id, { baseUrl: 'https://app.example/api/files' }, ctx);
const link = await files.signUrl(file.id, { version: 'thumbnail', expiresIn: 300 }, ctx);
```

**`setVisibility(assetId, 'public' | 'private', ctx): Promise<FileRecord>`** changes visibility. Errors: `INVALID_CONFIG` (other values), `FORBIDDEN` (public files disabled). **`revokeUrls(assetId, ctx): Promise<{ assetId, revoked: true }>`** rotates the asset salt so every earlier signed URL fails with `DELIVERY_REVOKED`.

```ts
await files.setVisibility(file.id, 'public', ctx);
await files.revokeUrls(file.id, ctx);
```

**`openOriginal(token, range?, ip?): Promise<OpenedContent>`** reads the bytes behind a signed `/content` token. No principal is needed. **`openPublic(assetId, version, range?): Promise<OpenedContent>`** reads a public version. `range` is `{ start, end? }`, and a range read returns a `Uint8Array` body; otherwise `body` is a stream. Errors: `DELIVERY_MALFORMED`, `DELIVERY_BAD_SIGNATURE`, `DELIVERY_EXPIRED`, `DELIVERY_REVOKED`, `DELIVERY_IP_DENIED`, `DELIVERY_NOT_FOUND`, `DELIVERY_PRIVATE`.

```ts
const token = new URL(link.url).pathname.split('/content/')[1]!;
const opened = await files.openOriginal(decodeURIComponent(token));
const head = await files.openPublic(file.id, '_original', { start: 0, end: 1023 });
```

Module functions: `signDeliveryToken(secret, claims)` and `verifyDeliveryToken(token, keys)` sign and check tokens without an instance.

### Retention and operations

**`retentionSweep({ dryRun? }, ctx): Promise<CleanupReport>`** applies `FILES_RETENTION_*` for `ctx.principal.tenantId` and removes old orphans. Pinned assets are kept. **`touch(fileId, ctx): Promise<void>`** records that your app used the asset, which resets its unused-retention clock. See [docs/agents/retention.md](docs/agents/retention.md).

```ts
const plan = await files.retentionSweep({ dryRun: true }, ctx);
await files.touch(file.id, ctx);
```

**`doctor(): Promise<DoctorReport>`** runs the `filevora doctor` checks for this instance's config. `GET /health` serves the same report. **`migrate(): Promise<{ ok: true, mode: 'stored' }>`** creates the Filevora tables in the host database like `filevora migrate`. Lite mode throws `FEATURE_REQUIRES_STORED_MODE`.

```ts
const report = await files.doctor();
if (!report.ok) console.error(report.checks.filter((check) => check.status === 'fail'));
```

**`ensureWorker(): number`** starts the embedded worker child when the config allows it and returns its pid. **`close(): Promise<void>`** stops the child, closes the database and storage, and releases the queue connection.

**`verifyWebhookSignature({ secret, body, timestamp, signature, toleranceSeconds? }): boolean`** checks a received webhook. Pass the raw body and the `X-Filevora-Timestamp` and `X-Filevora-Signature` headers. The default tolerance is 300 seconds.

```ts
import { verifyWebhookSignature } from 'filevora/server';

const ok = verifyWebhookSignature({
  secret: process.env.FILEVORA_WEBHOOK_SECRET!,
  body: rawBody,
  timestamp: request.headers.get('x-filevora-timestamp'),
  signature: request.headers.get('x-filevora-signature'),
});
```

**`explainError(error, explainer?)`** returns the redacted error report plus an optional `suggestion` from your own explainer. **`redactConfig(files.config)`** returns the resolved config with secrets removed, like `filevora config validate`. `readManifest()` from `filevora/manifest` returns the capability manifest.

```ts
console.log(redactConfig(files.config));
```

## HTTP API

Routes come from `HTTP_ROUTES`. The host principal is required on every route except `GET /content/:token` and `GET /public/:assetId/:version`. Paths are relative to `basePath` (for example `/api/files`).

| Method | Path | Description | Library method |
| --- | --- | --- | --- |
| `POST` | `/sessions` | Start a resumable upload. Returns the session and part URLs. | `createUploadSession`, `partUploadUrls` |
| `GET` | `/sessions/:sessionId` | Read an upload session. | `getUploadSession` |
| `PUT` | `/sessions/:sessionId/parts/:partNumber` | Write one raw part. | `writePart` |
| `POST` | `/sessions/:sessionId/complete` | Assemble the original and queue processing. Returns the file record. | `completeUpload` |
| `POST` | `/sessions/:sessionId/abort` | Abort the session. | `abortUpload` |
| `GET` | `/assets` | List asset ids. Stored mode only. | `listAssetIds` |
| `POST` | `/retention/cleanup` | Run retention. Body `{ dryRun?: boolean }`. | `retentionSweep` |
| `POST` | `/assets/from-url` | Import an http(s) URL. Optional `preset`. Returns the file record before the download finishes. | `createFromUrl` |
| `POST` | `/files/batch` | Read many files by id. Body `{ assetIds }`. Returns `{ assets }`. | `getMany` |
| `GET` | `/files` | List files for the tenant. Filters: type, dates, tags, `q`, mime, filename, size, duration, dimensions, status, visibility, preset. See [docs/list.md](docs/list.md). | `list` |
| `POST` | `/files/search` | Semantic search. Stored mode and `FILEVORA_GEMINI_API_KEY`. See [docs/search.md](docs/search.md). | `search` |
| `GET` | `/files/:fileId` | Read one file. | `get` |
| `DELETE` | `/files/:fileId` | Soft-delete the asset and its versions. | `delete` |
| `GET` | `/files/:fileId/versions` | Signed URLs for every ready version of a private asset. Public assets use `/public` URLs. | `getDeliveryUrls` |
| `POST` | `/uploads/direct` | Sign a direct S3 upload. | `createDirectUpload` |
| `POST` | `/uploads/direct/:sessionId/complete` | Verify a direct S3 upload and queue processing. | `completeDirectUpload` |
| `POST` | `/pdf/merge` | Merge PDFs into a new asset. | `mergePdfs` |
| `POST` | `/files/:fileId/split` | Split a PDF by page ranges. | `splitPdf` |
| `POST` | `/files/:fileId/describe` | Queue a Gemini description for an existing asset. Stored mode and `FILEVORA_GEMINI_API_KEY` are required. | `describeAsset` |
| `POST` | `/files/:fileId/transform` | Queue a transform. Body may be `operations` or `preset` (single-output presets accept extra `operations` after the preset). Returns `{ launched, jobId, assetId, sourceAssetId, replace }`. | `transform` |
| `GET` | `/files/:fileId/progress` | Progress event as `text/event-stream` or JSON. | `watchProgress`, `processingSnapshot` |
| `POST` | `/files/:fileId/delivery` | Sign delivery URLs. Optional `expiresInSeconds`. | `getDeliveryUrls` |
| `GET` | `/content/:token` | Download bytes for a signed token. No principal. 403 with a `DELIVERY_*` code when the token is bad. | `openOriginal` |
| `GET` | `/public/:assetId/:version` | Download a public asset with no signature. Private assets return `DELIVERY_PRIVATE`. | `openPublic` |
| `PUT` | `/files/:fileId/visibility` | Set `public` or `private`. | `setVisibility` |
| `POST` | `/files/:fileId/revoke-urls` | Rotate the asset salt so older signed URLs fail. | `revokeUrls` |

`GET /health` is not in that table. It exists only when the handler is created with `health: true` (or `{ path }`). It returns the doctor report (`files.doctor()`) with no authentication. HTTP 200 when required checks pass, 503 when one fails.

Request and response shapes, which mode each route allows, and every error code are in the manifest (`catalog.endpoints`, `catalog.errors`).

## SDK

Public entry points match `package.json` `exports` and `catalog.exports` in the manifest.

### `filevora/server`

`createFiles(options?)` returns a `Files` instance with one method per feature. Every method is listed in [Library methods](#library-methods). `listPresets()` lists built-in and custom preset names. `verifyDeliveryToken` checks an HMAC token and `verifyWebhookSignature` checks a received webhook. Construction does not spawn a worker.

Also exported: `Files`, `FilesOptions`, `ResolvedConfig`, `CreateSessionInput`, `RequestContext`, `TransformRequest`, `TransformLaunch`, `DirectUploadGrant`, `OpenedContent`, `WatchProgressOptions`, `ListQueryInput`, `ProgressEvent`, `ProgressVersion`, `CleanupReport`, `DoctorReport`, `WebhookRequest`, `WebhookEventName`, `FileSdkError`, `isFileSdkError`, `redactConfig`, `explainError`, `Explainer`, `listPresets`, `PresetSummary`, `signDeliveryToken`, `verifyDeliveryToken`, `DeliveryClaims`, `assetTransformSchema`, `AssetTransform`, `AssetTransformInput`, `AssetTransformOperation`.

### `filevora/client`

Browser-safe. It does not import Node, `sharp`, or a cloud SDK.

`createUploadClient({ endpoint })` returns `upload`, `uploadDirect`, `fetchSigned`, `fromUrl`, `transform`, `waitForProcessing`, `watchProcessing`, `history`, and `pending`. `uploadClientOptionsFromEnv` reads `FILEVORA_RESUME_*` and `FILEVORA_PROGRESS_*` in the host and passes them into the client. Resume stores: `createIndexedDbResumeStore`, `createMemoryResumeStore`.

### Framework entries

`filevora/next` (`createNextHandlers`, `uploadFormFile`), `filevora/express` (`expressMiddleware`), `filevora/fastify` (`fastifyPlugin`), `filevora/hono` (`honoHandler`), and `filevora/react` (`useUpload`, `useAssetProgress`). React is an optional peer. None of these render UI. [docs/frameworks.md](docs/frameworks.md)

### `filevora/http`

`createFilesHandler(options)` and `handleNodeRequest(handler, req, res)`. Options include `authenticate`, `authorize`, `policy`, `basePath`, and `health`.

### `filevora/worker`

`startWorker`, `runWorker`, and `ensureEmbeddedWorker`. Importing the module does not start a process.

### `filevora/testing`

`createTestFiles`, `uploadBytes`, `assertProgress`, `samplePng`, `samplePdf`, `sampleMp4`, and `signTestDeliveryUrl`. [docs/agents/testing.md](docs/agents/testing.md)

### `filevora/manifest`

`readManifest()` reads the manifest shipped in the package. `buildManifest` is the generator used by `pnpm manifest`.

### `filevora/types`

Shared types, including `Principal`, `FileRecord`, `UploadSession`, and `DeliveryResult`. Progress event fields are `catalog.progress` in the manifest. The complete symbol list is `catalog.exports` for this module.

## CLI

The binary is `filevora`. The command list is `CLI_COMMANDS` in the package, which is also `cli` in the manifest.

| Command | What it does |
| --- | --- |
| `capabilities --json` | Print the capability manifest. |
| `manifest --json` | Print the same manifest. |
| `config validate --json` | Resolve config and print it with secrets redacted. |
| `doctor --json` | Run health checks. Exit code 1 when a required check fails. |
| `mcp` | MCP stdio server: `manifest_lookup`, `validate_config`, `doctor`. |
| `migrate` | Create `filevora_assets` and `filevora_asset_versions`. Stored mode only. |
| `cleanup [--dry-run] [--json]` | Run retention. `--tenant` selects the tenant. |
| `init [--framework express\|fastify\|hono\|next\|node] [--mode lite\|stored] [--dry-run] [--json]` | Write handler, client snippet, and env template. Refuses to overwrite without `--force`. Also accepts `--dir` and `--database-url`. |
| `init --profile local-s3` | Write a MinIO Compose file. Does not start Docker. |
| `worker` | Process the BullMQ queue. |
| `--help` | List commands. |
| `--version` | Print the package version. |

## For coding agents

Start at [llms.txt](llms.txt). The manifest is the source of truth for routes, exports, environment variables, and error codes.

- [AGENTS.md](AGENTS.md) — repository rules, commands, and layout
- [llms.txt](llms.txt) — index of agent docs
- [docs/agents/capabilities.json](docs/agents/capabilities.json) — versioned manifest (exports, routes, env, errors, progress)
- [docs/agents/capabilities.schema.json](docs/agents/capabilities.schema.json) — schema
- [docs/agents/manifest.md](docs/agents/manifest.md) — how the manifest is generated
- [docs/agents/install.md](docs/agents/install.md)
- [docs/agents/decision-guide.md](docs/agents/decision-guide.md)
- [docs/agents/init.md](docs/agents/init.md)
- [docs/agents/doctor.md](docs/agents/doctor.md)
- [docs/agents/testing.md](docs/agents/testing.md)
- [docs/agents/transform.md](docs/agents/transform.md)
- [docs/agents/webhooks.md](docs/agents/webhooks.md)
- [docs/agents/retention.md](docs/agents/retention.md)
- [docs/agents/troubleshooting.md](docs/agents/troubleshooting.md)
- [docs/agents/verification.md](docs/agents/verification.md)
- [Framework helpers](docs/frameworks.md) — Next, Express, Fastify, Hono, and React hooks with no UI
- [Presets](docs/presets.md) — built-in image and video presets and custom recipes
- [docs/agents/presets.md](docs/agents/presets.md)
- [docs/access-control.md](docs/access-control.md)
- [docs/agents/access-control.md](docs/agents/access-control.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)

```bash
npx filevora manifest --json
npx filevora doctor --json
npx filevora mcp
```

```ts
import { readManifest } from 'filevora/manifest';
```

## Develop this repository

```bash
pnpm install
pnpm dev          # Vite library build, watch
pnpm dev:client   # browser client only, http://127.0.0.1:5173
pnpm run ci       # typecheck, lint, knip, circular, manifest check
pnpm test
```

Use `pnpm run ci`, not bare `pnpm ci`. Public imports are `filevora/server`, `filevora/client`, `filevora/http`, `filevora/next`, `filevora/express`, `filevora/fastify`, `filevora/hono`, `filevora/react`, `filevora/worker`, `filevora/types`, `filevora/testing`, and `filevora/manifest`. Contributor rules are in [AGENTS.md](AGENTS.md).

License: MIT.

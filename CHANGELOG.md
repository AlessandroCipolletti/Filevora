# Changelog

## Unreleased

## 0.1.1 - 2026-11-26

### Documentation

- The README "Install" section documents `npm install filevora`, the package page at https://www.npmjs.com/package/filevora, and `npx filevora --help`.

## 0.1.0 - 2026-11-26

### Library methods

- Every feature is a typed in-process method on `createFiles()` from `filevora/server`. The README section "Library methods" lists each one with its options, errors, and an example. The HTTP handler calls these methods, so validation and error codes match.
- New `files.getMany(assetIds, ctx)` (used by `POST /files/batch`), `files.watchProgress(fileId, ctx, opts)` (the async iterator behind the SSE progress stream), `files.doctor()` (used by `GET /health`), `files.migrate()`, and `files.listPresets()`. New `verifyWebhookSignature` for received webhooks.
- `ctx.policy` (`UploadPolicy`) narrows `createUploadSession` limits and sets the owner, as the HTTP `policy` callback does. Missing session fields, a missing import `url`, and an invalid visibility now throw `INVALID_CONFIG` from the methods, not only from HTTP.
- `filevora/server` also exports `FileSdkError`, `isFileSdkError`, `redactConfig`, `explainError`, and the types `TransformRequest`, `TransformLaunch`, `DirectUploadGrant`, `OpenedContent`, `WatchProgressOptions`, `ListQueryInput`, `ProgressEvent`, `CleanupReport`, `DoctorReport`, and `WebhookRequest`.
- The manifest entry for `POST /files/batch` now matches the handler: body `{ assetIds }`, response `{ assets }`.

### Semantic search

- `POST /files/semantic-search` finds assets by meaning. It takes a natural-language `query` in any language, the `GET /files` structured filters, `minScore` (default 0.65, provisional), `maxResults` (default 100, cap across pages), `limit`, and `cursor`. Each hit has a `score`. Ordering is score descending, then id descending, and the cursor is tied to the query.
- Stored mode only. When a description finishes, the file and its description are embedded together in one `gemini-embedding-2` request at 768 dimensions and written to `filevora_asset_embeddings`, whose new `source` column says `file+description` or `description`. Images are rendered to a JPEG (PNG with transparency) with a 1024 px long edge by our own pipeline, video uses the optimized MP4, audio is sent as MP3 or WAV when it already is one within 180 s, otherwise converted by ffmpeg to a mono MP3 trimmed to 180 s for embedding only, and PDFs are sent as they are up to 6 pages. A file over a limit, of another type, or that cannot be read is embedded as its description only and logged; it never fails the asset. The query is embedded with the same model. `POST /files/:id/describe` replaces it. Delete and retention remove it. There is no bulk reindex: run describe again after changing the model or dimensions.
- The `minScore` default is 0.65 and provisional: one live run of the text fixture with `gemini-embedding-2` gave precision 0.77 and recall 0.82 there (0.55 gave precision 0.06). It stays provisional until a real-files calibration run confirms it.
- The calibration test sweeps `minScore` 0.50 to 0.80 in 0.01 steps with precision, recall, F1 and the best F1, and prints the top 5 results per query (relevant or not), the labeled files missed in the top 10, and the files that were not sent with their description. A real-files mode reads your files from `FILEVORA_CALIBRATION_FILES_DIR` and a `labels.json` with only queries; missing descriptions are generated with the describe code and cached in the gitignored folder.
- New env vars `FILEVORA_EMBEDDING_MODEL`, `FILEVORA_EMBEDDING_DIMENSIONS`, `FILEVORA_SEMANTIC_SEARCH_MIN_SCORE`, and `FILEVORA_SEMANTIC_SEARCH_MAX_RESULTS`. New errors `SEMANTIC_SEARCH_QUERY_INVALID` and `EMBEDDING_UNAVAILABLE`. `createUploadClient().semanticSearch` and the live MCP tool `semantic_search_assets`.
- `EMBEDDING_UNAVAILABLE` names Google's answer: the message and `context` (`geminiHttpStatus`, `geminiStatus`, `geminiMessage`, `geminiReason`) carry the HTTP status and Google's error text, never the key. Google 400, 401, 402, and 403 are `retryable: false` with a fix for the key, billing, or permission; 429 and 5xx stay retryable. `FILEVORA_EMBEDDING_MODEL` also accepts the `models/…` resource form. Error context and logs redact Google API keys (`AIza…`).
- Every public name of this feature says `semantic`, so it is not confused with the `q` keyword filter of `GET /files`: library method `files.semanticSearch`, client method `semanticSearch`, route `POST /files/semantic-search`, MCP tool `semantic_search_assets`, types `SemanticSearchFilesInput`, `SemanticSearchFilesPage`, `SemanticSearchFileHit`, config keys `gemini.semanticSearchMinScore` and `gemini.semanticSearchMaxResults`, and error code `SEMANTIC_SEARCH_QUERY_INVALID`. The earlier `search` names do not exist; there are no aliases.

### List filters

- `GET /files` accepts `type` (`image`, `video`, `document`, `audio`), `createdFrom`/`createdTo`, `updatedFrom`/`updatedTo`, `tags` (any-of), `tagsAll` (all-of), `tagCategory` or `category:tag`, `q`, `mime`, `filename`, `sizeMin`/`sizeMax`, `durationMin`/`durationMax`, `widthMin`/`heightMin`, `status`, `descriptionStatus`, `visibility`, `preset`, `hasDescription`, `sort`, and `order`.
- `document` means PDF, text, CSV, and Office files. `q` is a case-insensitive `LIKE` over the short and long description. Every word must match. There is no separate search endpoint and no full-text or vector index.
- The default sort stays `created` descending, with `id` as the tiebreaker. Description filters (`tag`, `tags`, `tagsAll`, `tagCategory`, `q`, `descriptionStatus`, `hasDescription`) need stored mode and `FILEVORA_GEMINI_API_KEY`. Lite mode returns `DESCRIPTION_REQUIRES_DATABASE`. A missing key returns `DESCRIPTION_NOT_CONFIGURED`. The other filters work in lite and stored mode.
- `createUploadClient().list` sends the query. `list_files` on the MCP server validates it. Indexes for the new columns are created by `filevora migrate` on PostgreSQL, MySQL/MariaDB, and SQLite.

### Gemini asset descriptions

- `FILEVORA_GEMINI_API_KEY` and `describe` on upload, URL import, direct S3 registration, PDF merge, and PDF split queue a Gemini description. `FILEVORA_DESCRIBE_ASSETS` defaults to false. `describe: false` overrides a true default.
- Stored mode only. Lite mode returns `DESCRIPTION_REQUIRES_DATABASE`. A request with `describe: true` and no key returns `DESCRIPTION_NOT_CONFIGURED`.
- The asset row stores `description_long` (3000), `description_short` (300), status, error, model, and time. Tags live in `filevora_asset_tags`. A failed description does not fail the asset. `GET /files?tag=` filters stored assets. `POST /files/:id/describe` runs it again.
- Images use the 1280px derivative, video the optimized H.264 proxy (`FILEVORA_DESCRIBE_VIDEO_HEIGHT`, default 720), audio a mono AAC copy, and PDFs the original. The default model is `gemini-3.5-flash-lite`. Content is sent to Google only when a description runs.

### Thumbnail width

- `FILES_THUMBNAIL_WIDTH` and `defaults.thumbnailWidth` set the web-optimized image thumbnail, the built-in `thumbnail` preset, and the legacy video poster. Allowed values are 320 and 480. The default changed from 320 to 480. Optimized 1280, HD 1920, and video 720/1080 are unchanged. Any other value is `INVALID_CONFIG`.

### Framework helpers

- `filevora/next`, `filevora/express`, `filevora/fastify`, and `filevora/hono` adapt the existing request handler. They do not render UI.
- `filevora/react` exports `useUpload` and `useAssetProgress`. React is an optional peer dependency. The hooks keep no markup.
- `uploadDirect`, `waitForProcessing`, and `fetchSigned` stay on `filevora/client`, which does not import Node builtins.

### Direct S3 upload

- `POST /uploads/direct` signs a single PUT or a multipart part list. The client uploads to S3. `POST /uploads/direct/:sessionId/complete` heads the object, checks size and sniffed type, applies the EXIF policy, runs the malware scanner, and queues the same preset, progress, and webhook path as a normal upload.
- Signed URLs expire after `uploadGrantTtlSeconds`. Files larger than `maxFileBytes` are rejected. The bucket CORS configuration must expose `ETag`. `createUploadClient().uploadDirect` performs the flow. Filesystem storage cannot sign an upload.

### Audio tools

- `audio.transcode` writes MP3, AAC, Opus, or WAV at a chosen bitrate. `audio.loudnorm` applies EBU R128 via ffmpeg `loudnorm` (`I=-23`, `TP=-1.5`, `LRA=11`).
- `audio.waveform` stores a PNG and a JSON peak map. `audio.describe` stores duration, codec, sample rate, channels, and bitrate.
- Presets: `audio-mp3`, `audio-aac`, `audio-loudnorm`, `audio-waveform`, and `audio-describe`. The same operations can be sent without a preset.

### PDF tools

- `pdf.text` and the `pdf-text` preset store a JSON description: document metadata and the text of each page.
- `POST /pdf/merge` joins PDF assets into one new asset. `POST /files/:id/split` writes one new asset per page range. Both use the storage driver and the same processing job, progress, and webhook path as other work.
- `office-pdf` converts Word, PowerPoint, and Excel with LibreOffice (`soffice`). The check is optional. `filevora doctor` warns when it is missing, and a conversion fails with `PROCESSOR_UNAVAILABLE`.

### PDF page thumbnails

- `pdf.pages` renders selected pages, or every page, to PNG, JPEG, or WebP. `dpi`, `width`, and `height` set the size. Presets `pdf-pages` and `pdf-cover` do the same.
- Rendering uses Poppler's `pdftoppm`. Install `poppler-utils` or `brew install poppler`. `filevora doctor` warns when it is missing. A page-image job then fails with `PROCESSOR_UNAVAILABLE`. Text extraction does not need Poppler.

### Video thumbnails

- `video.poster` accepts `atMs` or `atPercent`. `video.thumbnails` writes numbered WebP frames. `video.sprite` writes a contact sheet plus a WebVTT file and a JSON timeline.
- Presets `poster`, `thumbnails`, and `sprites` publish those versions in lite and stored mode. The same operations can be sent without a preset. They use the storage driver, so filesystem and S3 behave the same way.

### Example server

- `examples/node-minimal` runs the preset in process when `REDIS_URL` is unset. A complete upload does not fail closed waiting for a queue.

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

- Sharp writes `thumbnail` (`FILES_THUMBNAIL_WIDTH`, default 480), `optimized` (1280), and `hd` (1920) WebP variants.
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

### M7 — Postgres queue on PGlite

- Placeholder conversion, schema, claim with `FOR UPDATE SKIP LOCKED`, and idempotent variant insert.
- Two in-process claimers against one PGlite database take one job. Two publishers leave one variant row. Both see the same S3 object.
- This did not start a networked Postgres server, and `createFiles` still opens SQLite.

### M8 — PDF and tabular fixtures

- A fixture PDF with a `Tj` string returns `Hello Filevora`. A page with no text returns `OCR_NOT_CONFIGURED` and an empty string. An `/Encrypt` dictionary throws `PDF_ENCRYPTED`.
- CSV and XLSX normalization return accepted and rejected row counts. Invalid values are masked as `***`.
- This extractor is not a general PDF renderer and does not write page images.

### M9 — Retention

- Dry-run reports an old file and leaves it readable. A pin removes it from the eligible set.
- A real sweep with a zero grace period deletes the bytes.
- A file with no touch timestamp is not eligible for inactivity deletion.

### M10 — Diagnostics and webhooks

- `explainError` redacts the report, keeps the original error code, and drops the suggestion if the explainer throws.
- Webhook HMAC signatures expire after five minutes. Production rejects loopback and private targets.
- A missing FFmpeg binary throws `FFMPEG_NOT_FOUND` with its catalog path. No live model API was called.

### M11 — Hardening notes

- Declared PNG bytes that are not a PNG fail before a file is stored.
- The 1×1 PNG fixture measured 46 ms in an isolated run and 81 ms in the full suite on darwin, Node v26.5.0. See `docs/benchmarks/baseline.md`.
- `npm pack --dry-run` listed 118 files for `filevora@0.1.0`. The package was not published.

### Follow-up — CI, previews, and release checks

- GitHub Actions installs FFmpeg and Poppler and starts Postgres 16 and MinIO. The workflow now splits typecheck, lint, knip, circular, build, and the Redis, S3, Postgres, and MySQL tests into separate jobs.
- Networked S3 runs when `FILEVORA_S3_ENDPOINT`, `FILEVORA_S3_BUCKET`, and the access keys are set. Networked Postgres runs when `FILEVORA_POSTGRES_URL` is set. On this machine both tests skipped: Docker was unavailable and `psql` was not installed. PGlite and the in-process S3 emulator remain the local proof. `createFiles` still opens SQLite.
- PDF normalize stores a PNG of page 1 when `pdftoppm` succeeds. Poppler 26.04.0 rendered the fixture at 200×200. A missing binary returns `preview.available: false` with `PROCESSOR_UNAVAILABLE` and still returns extracted text.
- Video posters are `image/webp`. FFmpeg encodes them only when `ffmpeg -encoders` lists libwebp. FFmpeg 8.1.2 on this machine does not, so Sharp encodes the poster. `doctor` check `ffmpeg-webp` warns and does not fail the report.
- `pnpm run ci` typechecks, runs ESLint and Prettier, runs knip, and runs madge. The pre-commit hook runs that script. Bare `pnpm ci` is reserved by pnpm and does not run the script.
- The full package suite on darwin, Node v26.5.0, reported 44 tests, 42 passed, 2 skipped, 0 failed. One run printed `benchmark_image_ms=88`. A later run printed `benchmark_image_ms=107`. See `docs/benchmarks/baseline.md`.
- After a clean `dist` rebuild, `npm pack --dry-run` listed 115 files, unpacked size 520.1 kB, shasum `a649bb820347927872a41f4875d58c5bcab7c8f5`. The tarball was deleted. The package was not published.
- No new error codes. Existing `docs/errors/*.md` still match the catalog.

### Vite library build

- `pnpm build` emits JavaScript with Vite 8 library mode, one ES module per source file, and writes `.d.ts` during that build. `tsc` typechecks and no longer emits JavaScript.
- `pnpm dev` watches the library build. `pnpm dev:client` serves the browser client at `http://127.0.0.1:5173`. That page is not published.
- Public imports are unchanged. The worker child is still `dist/worker/child.js`. The published client bundle still has no Node built-ins.

### Client progress and history

- Upload tasks report percent and bytes. `watchProcessing` follows video and audio jobs over SSE, with JSON polling as fallback. Image jobs emit one terminal event.
- `history()` is in memory for the page load and refetches short-lived delivery URLs. `pending()` lists resume-store sessions after a refresh.
- Host env vars are documented in `.env.example`. `uploadClientOptionsFromEnv` reads them in the host process.

### Lite and stored metadata

- `FILEVORA_METADATA_MODE=lite` is the default. It uses object storage and Redis and does not create a database file.
- `GET /files/:assetId` probes `{assetId}_{version}.{ext}`. `?detailed=true` includes dimensions. Responses include `asset` (`AssetInfo`).
- List, retention, and `filevora migrate` return `FEATURE_REQUIRES_STORED_MODE` in lite, with the env change, migrate command, and doctor check.
- Omitting `FILEVORA_DATABASE_URL` stays in lite. Setting it selects stored mode. `postgres://` and `postgresql://` use PostgreSQL, `mysql://` and `mariadb://` use MySQL or MariaDB, and `sqlite://` or a file path uses SQLite. An unknown scheme, or stored mode with no database, returns `INVALID_CONFIG` and names those three.
- `createFiles` and `npx filevora migrate` create only `filevora_assets` and `filevora_asset_versions`. Auto-migrate is on unless `FILEVORA_AUTO_MIGRATE=false`.
- `POST /files/batch` accepts up to 20 ids in lite.

### Init and doctor

- `filevora init` is flag-driven. It detects the framework and package manager, writes handler, client, and env files, and prints the migrate step. `--dry-run` writes nothing. Existing files need `--force`.
- `filevora doctor` checks mode, a storage round trip, Redis and BullMQ, stored-mode database migration, ffmpeg and ffprobe, the malware scanner, and webhook settings. Failed checks include a stable code and a fix. `health: true` exposes the report on `GET /health`.

### Capability manifest

- `docs/agents/capabilities.json` now includes a generated catalog of exports, HTTP routes, config and env settings, error codes, and the progress event. `pnpm manifest:check` fails when the committed file is stale.
- `filevora manifest --json` and `filevora/manifest` expose it. `filevora mcp` serves manifest lookup, config validation, and doctor over stdio without an extra dependency.

### Retention cleanup

- Delivery URLs update `last_accessed_at`. Stored mode keeps it on `filevora_assets`. Lite mode keeps it on the asset card and, when that timestamp is missing, uses creation time so files are not deleted early.
- `POST /retention/cleanup` and `filevora cleanup --dry-run` report expired assets and old orphans. A BullMQ job repeats at `FILES_CLEANUP_INTERVAL_MINUTES` when retention is enabled.

### Completion webhooks

- Optional `FILEVORA_WEBHOOK_URL` and `FILEVORA_WEBHOOK_SECRET`, or a per-request `webhook` object.
- Events are `upload.completed`, `processing.completed`, `processing.failed`, and `transform.completed`. The body is the progress event, signed with `X-Filevora-Timestamp` and `X-Filevora-Signature`.
- Delivery retries through BullMQ. Targets use the URL-import SSRF checks. Localhost requires `FILES_WEBHOOKS_ALLOW_LOOPBACK`.

### Test helpers

- `filevora/testing` exports `createTestFiles`, image, PDF, and video fixtures, `uploadBytes`, and `assertProgress`.
- `processing.mode: "sync"` finishes the job in the caller. It is available only when `env` is `test` and does not open Redis.

### Upload safety

- Optional malware scan after the original is stored and before encoding. No scanner skips the check. `FILEVORA_MALWARE_SCAN=clamav` uses ClamAV INSTREAM. Infected files return `MALWARE_DETECTED` and are quarantined.
- `FILEVORA_EXIF_STRIP` defaults to `gps` for image versions. `all` drops metadata and `none` keeps it.
- `FILEVORA_TYPE_MAX_BYTES` limits size by the sniffed type.

### Named presets

- Built-in presets: `web-optimized` (default; thumbnail, optimized, hd), `thumbnail`, `avatar`, `og-image`, `hero`, `social-square`, `video-480p`, `video-720p`, `video-1080p`, `video-preview`, and `poster`.
- Upload and URL import store the preset's versions next to `_original`. `POST /files/:assetId/transform` accepts `preset`. Single-output presets can be followed by `operations`. Unknown or incompatible names return `TRANSFORM_REJECTED` with `validPresets`.
- Custom presets are `presets` in config or `FILEVORA_PRESETS` JSON, validated like transform operations. See `docs/presets.md`.

### Packed install smoke

- GitHub Actions job `test-pack` installs the packed tarball in a fresh directory and checks the CLI, a lite filesystem upload, a stored SQLite upload, and a lite S3 upload.

### Config and client waits

- S3 environment variables are `FILES_S3_*`. `FILES_POSTGRES_SCHEMA` is created and used as the Postgres search path.
- `waitForProcessing` keeps polling while a URL import is still `uploading` with `processingState: "none"`.
- An unreachable `REDIS_URL` fails with `INVALID_CONFIG` instead of retrying without a limit.

### Init templates

- Generated handlers set `basePath: '/api/files'`, the same path as `filevora/upload-snippet.ts`. The Fastify plugin calls `reply.hijack()` before writing the raw response.

### Package entry points

- `filevora` runs the CLI. `filevora worker` polls BullMQ using `REDIS_URL` or `FILEVORA_CONFIG_PATH`. A missing Redis URL fails with `INVALID_CONFIG` instead of importing `redis-memory-server`.
- `exports` include `require` so Node 22.13+ can load the ESM entry points from CommonJS. The `node:sqlite` experimental warning is suppressed. The filter is a called function so the library build keeps it.

### S3 asset IO

- Presets, transforms, uploads, delivery, and retention read and write through the storage driver. Sharp and FFmpeg use a temporary file, then the bytes go back to S3.
- Lite cards use the same `.filevora/` keys in the bucket when storage is S3. A missing card stays private.
- The embedded worker config keeps `storage.s3`. `GET /health` and `filevora doctor` probe that bucket with a write, read, and delete.
- `test/s3-matrix.test.ts` runs those flows against MinIO in the `test-s3` job for lite and stored mode.

### Signed delivery

- Assets are `private` by default (`FILEVORA_DEFAULT_VISIBILITY`). `PUT /files/:assetId/visibility` changes it. A missing lite asset card stays private.
- `FILEVORA_SIGNING_SECRET` signs `/content` URLs. A comma-separated list rotates keys: the first signs, all of them verify. `signUrl` and `verifyDeliveryToken` are the SDK helpers.
- Private progress, webhook, and version URLs are signed. S3 originals are presigned. Public assets use `/public/:assetId/:version`.
- `POST /files/:assetId/revoke-urls` rotates `url_salt` (a column in stored mode, a field on the lite card). Expired, tampered, revoked, and IP-bound URLs return HTTP 403 with `DELIVERY_*` codes.
- Issuing a signed URL updates `last_accessed_at`. See `docs/access-control.md`.

### Transform an existing asset

- `POST /files/:assetId/transform` accepts one config object and returns `{ launched, jobId, assetId }` immediately. The job uses the BullMQ queue.
- `replace` defaults to true and keeps the asset id. `false` creates a new id. Lite mode finds `{assetId}_original.*`. Stored mode reads the metadata database.
- Operations: `image.resize`, `image.crop`, `video.resize`, `video.crop`, `video.trim`, `pdf.removePages`. Invalid configs return `TRANSFORM_REJECTED` with `field`, `reason`, `detectedType`, and `validOperations`.
- Progress events for upload, URL download, and transforms share `phase`, `percentage`, `etaMs`, and `terminal`. The terminal success event adds `versions` with signed URLs. Older fields `fileId`, `state`, `quiet`, and `terminal` stay.

### Import from a URL

- `POST /assets/from-url` and `createUploadClient().fromUrl(url)` return `assetId` before the download finishes.
- The SDK streams the response, sniffs the bytes, stores `{assetId}_original.{ext}`, and queues the same encoding jobs in lite and stored mode.
- Progress uses `state: "downloading"` and then the processing states. Rejected URLs use `REMOTE_URL_SCHEME`, `REMOTE_URL_CREDENTIALS`, `REMOTE_URL_PORT`, `REMOTE_URL_HOST`, `REMOTE_URL_BLOCKED`, `REMOTE_URL_REDIRECT`, and `REMOTE_URL_TIMEOUT`.

### BullMQ processing queue

- Encoding jobs go to Redis through BullMQ. `REDIS_URL` is the queue. Asset ids and version metadata stay in SQLite (`FILES_SQLITE_PATH`).
- Object keys are `{tenantHash}/{assetId}_{version}.{ext}`.
- `GET /assets` lists asset ids for the authenticated tenant.
- Several `filevora worker` processes can share one `REDIS_URL`. `processing.concurrency` is how many jobs one process runs at once.

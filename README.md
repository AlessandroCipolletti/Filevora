# Filevora

Filevora is a headless TypeScript SDK for the file lifecycle: resumable upload, private storage, background derivatives, and short-lived delivery. It runs inside your Node app. There is no Filevora account, API key, or hosted control plane.

Your application keeps users, permissions, and business records. Filevora keeps bytes, versions, and processing jobs.

The package is not on npm yet. Install it from this repository. Node `>=22.13`.

## Contents

- [Quick start](#quick-start)
- [Lite and stored](#lite-and-stored)
- [Features](#features)
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
| List `GET /files` and `GET /assets` | `FEATURE_REQUIRES_STORED_MODE` | Lists the signed-in tenant |
| Queue | Redis (BullMQ) in both modes. Asset ids are not stored in Redis | Same |
| Object key | `{tenantHash}/{assetId}_{version}.{ext}` in both modes | Same |

`mariadb://` is rewritten to `mysql://`. Auto-migrate is on unless `FILEVORA_AUTO_MIGRATE` turns it off. Names and defaults are in [.env.example](.env.example). Rules are in [docs/configuration.md](docs/configuration.md).

## Features

Each line is implemented in this package. Status of what an automated test covers is in the [capability manifest](docs/agents/capabilities.json). Deeper notes stay in the linked docs.

- **Upload.** Resumable chunked sessions, pause, retry, and resume after refresh. `complete()` means the original is stored. Pass `preset` to choose the versions. [docs/agents/install.md](docs/agents/install.md)
- **Presets.** Named image and video recipes (`thumbnail`, `avatar`, `og-image`, `hero`, `social-square`, `video-480p`, `video-720p`, `video-1080p`, `video-preview`, `poster`) plus the default `web-optimized` set. Custom presets use the same operations as transform. [docs/presets.md](docs/presets.md)
- **URL import.** `POST /assets/from-url` returns an asset id, then the SDK downloads the URL, sniffs the bytes, and queues the same encoding jobs. Private and metadata addresses are rejected. [docs/configuration.md](docs/configuration.md)
- **Transform.** One config object: `image.resize`, `image.crop`, `video.resize`, `video.crop`, `video.trim`, `pdf.removePages`. `replace` defaults to true. [docs/agents/transform.md](docs/agents/transform.md)
- **Processing.** Image presets write WebP thumbnail, optimized, and HD with Sharp and do not enlarge the source. Video presets write an H.264 MP4 and a WebP poster. Audio presets write AAC in an M4A file. PDF text extraction reads literal text; `pdftoppm` stores a PNG of page 1 when it is on `PATH`. CSV and XLSX return row counts. OCR returns `OCR_NOT_CONFIGURED`.
- **Progress.** `GET /files/:fileId/progress` is one event shape for upload, download, and processing: `phase`, `state`, `percentage`, `etaMs`, and a terminal `versions` list. SSE is the default. JSON is the fallback. The browser client sends the host `Authorization` header.
- **Versions and delivery.** `GET /files/:fileId/versions` returns signed URLs. `_original` is available as soon as the upload is verified, including while encoding is queued or after it fails.
- **Webhooks.** Optional `FILEVORA_WEBHOOK_URL` or a per-request `webhook`. Events are `upload.completed`, `processing.completed`, `processing.failed`, and `transform.completed`. The body is the terminal progress event, HMAC-signed. [docs/agents/webhooks.md](docs/agents/webhooks.md)
- **Retention and cleanup.** `FILES_RETENTION_*` and `FILES_UNUSED_RETENTION_DAYS`. A delivery URL updates `last_accessed_at` (the asset row in stored mode, the asset card in lite). Cleanup also removes old orphans. Pins are kept. [docs/agents/retention.md](docs/agents/retention.md)
- **Upload safety.** Optional ClamAV scan after the original is stored and before encoding. No scanner means the scan is skipped. `FILEVORA_EXIF_STRIP` defaults to `gps`. `FILEVORA_TYPE_MAX_BYTES` limits size by the sniffed type, not the extension.
- **Test helpers.** `filevora/testing` uses a temporary filesystem, lite mode, and synchronous processing. No Redis or S3. [docs/agents/testing.md](docs/agents/testing.md)
- **Init and doctor.** `filevora init` detects Express, Fastify, Hono, Next.js, or Node and writes files only with `--force` when they already exist. The env template sets `FILES_DEFAULT_PRESET`. `filevora doctor` checks config, mode, storage, Redis, the database, ffmpeg, ffprobe, the scanner, webhooks, and that the default preset exists. `health: true` serves that report. [docs/agents/init.md](docs/agents/init.md) · [docs/agents/doctor.md](docs/agents/doctor.md)
- **Manifest and MCP.** `filevora manifest --json` and `readManifest()` return the versioned capability document. `filevora mcp` exposes lookup, config validation, and doctor over stdio with no extra dependency. [docs/agents/manifest.md](docs/agents/manifest.md)
- **Storage.** Filesystem, or S3-compatible storage via `FILEVORA_S3_*`. `filevora init --profile local-s3` writes a MinIO Compose file and does not start Docker.
- **Metadata databases.** Lite has none. Stored uses PostgreSQL, MySQL or MariaDB, or SQLite, chosen by the database URL scheme.
- **Access control.** Assets are `private` or `public` (default `private`). Private downloads use HMAC `/content` URLs or S3 presigned URLs. Public downloads use `/public`. `signUrl` signs a version. `POST /files/:assetId/revoke-urls` invalidates older links. [docs/access-control.md](docs/access-control.md)

`provider: "managed"` throws `FEATURE_NOT_AVAILABLE`. This package does not bill, issue accounts, or render a UI.

## HTTP API

Routes come from `HTTP_ROUTES`. The host principal is required on every route except `GET /content/:token` and `GET /public/:assetId/:version`. Paths are relative to `basePath` (for example `/api/files`).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/sessions` | Start a resumable upload. Returns the session and part URLs. |
| `GET` | `/sessions/:sessionId` | Read an upload session. |
| `PUT` | `/sessions/:sessionId/parts/:partNumber` | Write one raw part. |
| `POST` | `/sessions/:sessionId/complete` | Assemble the original and queue processing. Returns the file record. |
| `POST` | `/sessions/:sessionId/abort` | Abort the session. |
| `GET` | `/assets` | List asset ids. Stored mode only. |
| `POST` | `/retention/cleanup` | Run retention. Body `{ dryRun?: boolean }`. |
| `POST` | `/assets/from-url` | Import an http(s) URL. Optional `preset`. Returns the file record before the download finishes. |
| `POST` | `/files/batch` | Read many files by id. |
| `GET` | `/files` | List files for the tenant. Stored mode only. |
| `GET` | `/files/:fileId` | Read one file. |
| `DELETE` | `/files/:fileId` | Soft-delete the asset and its versions. |
| `GET` | `/files/:fileId/versions` | Signed URLs for every ready version of a private asset. Public assets use `/public` URLs. |
| `POST` | `/files/:fileId/transform` | Queue a transform. Body may be `operations` or `preset` (single-output presets accept extra `operations` after the preset). Returns `{ launched, jobId, assetId, sourceAssetId, replace }`. |
| `GET` | `/files/:fileId/progress` | Progress event as `text/event-stream` or JSON. |
| `POST` | `/files/:fileId/delivery` | Sign delivery URLs. Optional `expiresInSeconds`. |
| `GET` | `/content/:token` | Download bytes for a signed token. No principal. 403 with a `DELIVERY_*` code when the token is bad. |
| `GET` | `/public/:assetId/:version` | Download a public asset with no signature. Private assets return `DELIVERY_PRIVATE`. |
| `PUT` | `/files/:fileId/visibility` | Set `public` or `private`. |
| `POST` | `/files/:fileId/revoke-urls` | Rotate the asset salt so older signed URLs fail. |

`GET /health` is not in that table. It exists only when the handler is created with `health: true` (or `{ path }`). It returns the doctor report with no authentication. HTTP 200 when required checks pass, 503 when one fails.

Request and response shapes, which mode each route allows, and every error code are in the manifest (`catalog.endpoints`, `catalog.errors`).

## SDK

Public entry points match `package.json` `exports` and `catalog.exports` in the manifest.

### `filevora/server`

`createFiles(options?)` returns a `Files` instance: sessions, URL import, transform, get, list, delete, delivery URLs, `signUrl`, `setVisibility`, `revokeUrls`, progress snapshots, retention, and normalize. `listPresets()` lists built-in and custom preset names. `verifyDeliveryToken` checks an HMAC token. Construction does not spawn a worker.

Also exported: `Files`, `FilesOptions`, `ResolvedConfig`, `CreateSessionInput`, `RequestContext`, `listPresets`, `PresetSummary`, `signDeliveryToken`, `verifyDeliveryToken`, `DeliveryClaims`, `assetTransformSchema`, `AssetTransform`, `AssetTransformInput`, `AssetTransformOperation`.

### `filevora/client`

Browser-safe. It does not import Node, `sharp`, or a cloud SDK.

`createUploadClient({ endpoint })` returns `upload`, `fromUrl`, `transform`, `waitForProcessing`, `watchProcessing`, `history`, and `pending`. `uploadClientOptionsFromEnv` reads `FILEVORA_RESUME_*` and `FILEVORA_PROGRESS_*` in the host and passes them into the client. Resume stores: `createIndexedDbResumeStore`, `createMemoryResumeStore`.

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

Use `pnpm run ci`, not bare `pnpm ci`. Public imports are `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, `filevora/types`, `filevora/testing`, and `filevora/manifest`. Contributor rules are in [AGENTS.md](AGENTS.md).

License: MIT.

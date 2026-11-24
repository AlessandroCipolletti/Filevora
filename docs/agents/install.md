# Install

The package name is `filevora`. It is not published to npm yet. It is ESM, and Node 22.13+ can `require()` the same entry points. `bin/filevora.js` calls `runCli`. From a checkout:

```bash
pnpm install
pnpm --filter filevora build
```

That build is Vite library mode. It writes one ES module per source file under `packages/filevora/dist`, plus the `.d.ts` files. `pnpm dev` watches that build. `pnpm dev:client` serves the browser client for local development and is not part of the published package.

A host app depends on `filevora` and imports:

```ts
import { createFiles } from 'filevora/server';
import { createUploadClient } from 'filevora/client';
import { createFilesHandler } from 'filevora/http';
import { runWorker } from 'filevora/worker';
import type { FileRecord } from 'filevora/types';
```

No Filevora account, API key, or signup is involved. `examples/fixture-app` is the install check: it constructs `createFiles` and imports the other entries.

`createFilesHandler` accepts chunked uploads. `examples/node-minimal` is a Node HTTP host. The handler shape is a Web `Request` to a Web `Response`.

Store `assetId` from `POST /sessions`, `POST /assets/from-url`, or `POST /files/:assetId/transform` when `replace` is false. Transform details and copyable examples are in `docs/agents/transform.md`. Progress for upload, download, and transform is one shape on `GET /files/:assetId/progress`: `phase`, `state`, `percentage`, `etaMs`, `terminal`. The terminal success event includes `versions._original.url`. A URL import returns the id before the download finishes. `GET /files/:assetId/progress` then reports `downloading` and, after the bytes are stored, the normal processing states. The SDK sniffs the file and does not trust the URL extension or `Content-Type`. Private and metadata targets are rejected unless `FILEVORA_REMOTE_ALLOW_PRIVATE=true`, and that flag does not apply to redirects. Object keys are `{tenantHash}/{assetId}_{version}.{ext}`. Redis (`REDIS_URL`) is only the BullMQ processing queue. After the upload is verified, `GET /files/:assetId/versions` returns `versions._original` plus any encoded version that is ready (`thumbnail`, `optimized`, `hd`). A failed or unfinished encode does not remove `_original`. Run one or more workers with `REDIS_URL=redis://127.0.0.1:6379 npx filevora worker`.

## Lite mode

`FILEVORA_METADATA_MODE=lite` is the default. Bytes live in object storage. There is no SDK database file. `GET /files/:assetId` probes `{assetId}_original.*`. `?detailed=true` adds dimensions. `GET /files`, `GET /assets`, and `npx filevora migrate` return `FEATURE_REQUIRES_STORED_MODE`.

## Stored mode

Providing `FILEVORA_DATABASE_URL` selects stored mode. Omitting it selects lite mode. `FILEVORA_METADATA_MODE` is an optional override. Stored without a URL is an error. Unsupported schemes name the three supported databases.

The scheme is the driver: `postgres://` or `postgresql://`, `mysql://` or `mariadb://`, `sqlite://` or a file path. The database is one the host already runs. `npx filevora migrate` creates only `filevora_assets` and `filevora_asset_versions`. `GET /files?kind=&status=&createdAfter=` and `GET /assets` list ids for the signed-in tenant. Verify with `npx filevora doctor --json`.

`FILEVORA_MALWARE_SCAN` is optional. Leave it unset to skip scanning. `clamav` scans the stored original before encoding. `FILEVORA_EXIF_STRIP` defaults to `gps`. `FILEVORA_TYPE_MAX_BYTES` is a comma-separated list of `mime=bytes` limits checked against the sniffed type.

FFmpeg and Poppler are system binaries. This package does not download them. `pg` and `sharp` are optional dependencies.

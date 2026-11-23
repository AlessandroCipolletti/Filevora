# Install

The package name is `filevora`. It is not published to npm yet. From a checkout:

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

Store `assetId` from `POST /sessions`. Object keys are `{tenantHash}/{assetId}_{version}.{ext}`. Redis (`REDIS_URL`) is only the BullMQ processing queue. After the upload is verified, `GET /files/:assetId/versions` returns `versions._original` plus any encoded version that is ready (`thumbnail`, `optimized`, `hd`). A failed or unfinished encode does not remove `_original`. Run one or more workers with `REDIS_URL=redis://127.0.0.1:6379 npx filevora worker`.

## Lite mode

`FILEVORA_METADATA_MODE=lite` is the default. Bytes live in object storage. There is no SDK database file. `GET /files/:assetId` probes `{assetId}_original.*`. `?detailed=true` adds dimensions. `GET /files`, `GET /assets`, and `npx filevora migrate` return `FEATURE_REQUIRES_STORED_MODE`.

## Stored mode

Set `FILEVORA_METADATA_MODE=stored` and `FILEVORA_DATABASE_URL` to the host database (`sqlite://...` or `postgres://...`). Run `npx filevora migrate` to create `filevora_assets` and `filevora_asset_versions`. `GET /files?kind=&status=&createdAfter=` and `GET /assets` list ids for the signed-in tenant. Verify with `npx filevora doctor --json`.

FFmpeg and Poppler are system binaries. This package does not download them. `pg` and `sharp` are optional dependencies.

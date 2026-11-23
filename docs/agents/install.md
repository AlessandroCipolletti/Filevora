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

Store `assetId` from `POST /sessions`. After the upload is verified, `GET /files/:assetId/versions` returns `versions._original` plus any encoded version that is ready (`thumbnail`, `optimized`, `hd`). A failed or unfinished encode does not remove `_original`.

FFmpeg and Poppler are system binaries. This package does not download them. `pg` and `sharp` are optional dependencies.

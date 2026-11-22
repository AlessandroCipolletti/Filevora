# Install

The package name is `filevora`. It is not published to npm yet. From a checkout:

```bash
pnpm install
pnpm --filter filevora build
```

A host app depends on `filevora` and imports:

```ts
import { createFiles } from 'filevora/server';
import { createUploadClient } from 'filevora/client';
import { createFilesHandler } from 'filevora/http';
import { runWorker } from 'filevora/worker';
import type { FileRecord } from 'filevora/types';
```

No Filevora account, API key, or signup is involved. `examples/fixture-app` is the install check: it constructs `createFiles` and imports the other entries.

Upload routes are not implemented. Do not wire a form yet. The next milestone adds filesystem storage and the HTTP adapter.

Framework snippets for Next.js, Express, and NestJS will be added with the HTTP adapter. The handler shape is a Web `Request` to a Web `Response`, so those frameworks only need a thin conversion.

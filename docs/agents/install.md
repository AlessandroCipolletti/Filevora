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

`createFilesHandler` accepts chunked uploads. `examples/node-minimal` is a Node HTTP host. The handler shape is a Web `Request` to a Web `Response`.

FFmpeg and Poppler are system binaries. This package does not download them. `pg` and `sharp` are optional dependencies.

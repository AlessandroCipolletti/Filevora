# Framework helpers

These helpers wire Filevora into an app. They do not render UI. The app, or a coding agent in that app, draws the controls.

## Next.js

```ts
// app/api/files/[[...path]]/route.ts
import { createFiles } from 'filevora/server';
import { createNextHandlers } from 'filevora/next';

const files = createFiles();
export const { GET, POST, PUT, PATCH, DELETE } = createNextHandlers({
  files,
  health: true,
  basePath: '/api/files',
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

```ts
// app/actions.ts
'use server';
import { createFiles } from 'filevora/server';
import { uploadFormFile } from 'filevora/next';

const files = createFiles();

export async function uploadAction(form: FormData) {
  return uploadFormFile(
    files,
    form,
    { principal: { id: 'user-a', tenantId: 'tenant-a' } },
    { describe: true },
  );
}
```

## Express, Fastify, Hono

```ts
import { createFiles } from 'filevora/server';
import { createFilesHandler } from 'filevora/http';
import { expressMiddleware } from 'filevora/express';
import { fastifyPlugin } from 'filevora/fastify';
import { honoHandler } from 'filevora/hono';

const handler = createFilesHandler({
  files: createFiles(),
  health: true,
  basePath: '/api/files',
  async authenticate() {
    return { id: 'user-a', tenantId: 'tenant-a' };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

expressApp.use('/api/files', expressMiddleware(handler));
await fastify.register(fastifyPlugin(handler));
hono.all('/*', honoHandler(handler));
```

## Browser client

`filevora/client` has no Node builtins and no React.

```ts
import { createUploadClient } from 'filevora/client';

const client = createUploadClient({ endpoint: '/api/files' });
const task = client.upload(file);
task.on('progress', (progress) => console.log(progress.percentage));
const record = await task.complete();
await client.waitForProcessing(record.id);

const direct = await client.uploadDirect(file, {
  mimeType: file.type || 'application/octet-stream',
  onProgress: (progress) => console.log(progress.percentage),
});

const response = await client.fetchSigned(record.variants.thumbnail.url);
```

## React hooks

`filevora/react` is optional and renders nothing. Install `react` in the app.

```tsx
import { createUploadClient } from 'filevora/client';
import { useAssetProgress, useUpload } from 'filevora/react';

const client = createUploadClient({ endpoint: '/api/files' });

export function UploadButton() {
  const upload = useUpload(client);
  const progress = useAssetProgress(client, upload.fileId);
  return (
    <button
      onClick={() => upload.start(fileInput.files[0], { describe: true })}
    >
      {upload.progress?.percentage ?? 0} {progress.update?.state}
    </button>
  );
}
```

The button in that example is the app's UI, not a component shipped by Filevora.

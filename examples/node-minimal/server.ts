import http from 'node:http';
import { createFilesHandler, handleNodeRequest } from 'filevora/http';
import { createFiles } from 'filevora/server';

const root = process.env.FILES_STORAGE_ROOT ?? './.files/objects';
const filename = process.env.FILES_SQLITE_PATH ?? './.files/metadata.sqlite';
const files = createFiles({
  env: 'test',
  storage: { driver: 'filesystem', root },
  metadata: { driver: 'sqlite', filename },
  upload: { chunkBytes: 64 * 1024 },
  ...(process.env.FILES_SIGNING_SECRET
    ? { signingSecret: process.env.FILES_SIGNING_SECRET }
    : {}),
});

const handler = createFilesHandler({
  files,
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
  async policy({ principal }) {
    return {
      ownerId: principal.id,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
    };
  },
});

const server = http.createServer((req, res) => {
  handleNodeRequest(handler, req, res).catch(() => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  process.stdout.write(`listening ${port}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    void files.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 500).unref();
});

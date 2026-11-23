import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const principal = { id: 'user-a', tenantId: 'tenant-a' };

function harness(dir: string, spawn: 'never' | 'on-demand') {
  const options = {
    env: 'test' as const,
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'worker' as const, spawn },
    defaults: {
      allowedMimeTypes: ['image/png'],
      maxFileBytes: 10 * 1024 * 1024,
    },
  };
  const files = createFiles(options);
  const handler = createFilesHandler({
    files,
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
  return { files, handler, options };
}

async function upload(handler: (request: Request) => Promise<Response>) {
  const body = PNG;
  const created = await handler(
    new Request('http://app.local/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user': 'user-a',
        'x-tenant': 'tenant-a',
      },
      body: JSON.stringify({
        filename: 'dot.png',
        mimeType: 'image/png',
        bytes: body.byteLength,
      }),
    }),
  );
  const session = (await created.json()) as {
    id: string;
    assetId: string;
    fileId: string;
  };
  const part = await handler(
    new Request(`http://app.local/sessions/${session.id}/parts/1`, {
      method: 'PUT',
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      body,
    }),
  );
  const written = (await part.json()) as { etag: string };
  const completed = await handler(
    new Request(`http://app.local/sessions/${session.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user': 'user-a',
        'x-tenant': 'tenant-a',
      },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: written.etag }] }),
    }),
  );
  const completedBody = (await completed.json()) as { file: { id: string } };
  return { session, file: completedBody.file };
}

async function versions(
  handler: (request: Request) => Promise<Response>,
  assetId: string,
) {
  const response = await handler(
    new Request(`http://app.local/files/${assetId}/versions`, {
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
    }),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as {
    assetId: string;
    status: string;
    versions: Record<string, { url: string }>;
  };
}

test('upload start returns a stable asset id and versions keep the original', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-asset-'));
  const { files, handler, options } = harness(dir, 'never');
  try {
    const { session, file } = await upload(handler);
    assert.equal(session.assetId, session.fileId);
    assert.equal(file.id, session.assetId);
    const pending = await versions(handler, session.assetId);
    assert.equal(pending.assetId, session.assetId);
    assert.match(pending.versions._original?.url ?? '', /\/content\//);
    assert.equal(pending.status, 'queued');
    const listed = await handler(
      new Request('http://app.local/assets', {
        headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      }),
    );
    const ids = (await listed.json()) as { assetIds: string[] };
    assert.ok(ids.assetIds.includes(session.assetId));
    const hidden = await handler(
      new Request('http://app.local/assets', {
        headers: { 'x-user': 'user-b', 'x-tenant': 'tenant-b' },
      }),
    );
    const other = (await hidden.json()) as { assetIds: string[] };
    assert.deepEqual(other.assetIds, []);
    const sqlPath = options.metadata.filename;
    const { openSqlite } = await import('../dist/metadata/sqlite.js');
    const sql = openSqlite(sqlPath);
    sql.run(
      `UPDATE filevora_assets SET processing_state = 'failed' WHERE id = ?`,
      [session.assetId],
    );
    sql.run(
      `UPDATE jobs SET state = 'failed', error_code = 'FFMPEG_FAILED' WHERE file_id = ?`,
      [session.assetId],
    );
    sql.close();
    const failed = await versions(handler, session.assetId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.versions._original?.url ?? '', /\/content\//);
    const second = await upload(handler);
    await runWorker({ options, once: true });
    const ready = await versions(handler, second.session.assetId);
    assert.ok(ready.versions.thumbnail?.url.includes('/content/'));
    assert.match(ready.versions._original?.url ?? '', /\/content\//);
    const stored = await files.get(second.session.assetId, { principal });
    assert.equal(stored.id, second.session.assetId);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

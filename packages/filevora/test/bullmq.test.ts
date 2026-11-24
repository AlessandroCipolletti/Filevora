import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSqlite } from '../dist/metadata/sqlite.js';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';

const principalA = { id: 'user-a', tenantId: 'tenant-a' };
const principalB = { id: 'user-b', tenantId: 'tenant-b' };

test('two BullMQ workers share one Redis queue and each job runs once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-bull-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never', concurrency: 2 },
    defaults: { allowedMimeTypes: ['image/png'] },
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  try {
    const ids: string[] = [];
    for (const name of ['a.png', 'b.png']) {
      const session = await files.createUploadSession(
        { filename: name, mimeType: 'image/png', bytes: png.byteLength },
        { principal: principalA },
      );
      await files.writePart(session.id, 1, png, { principal: principalA });
      const file = await files.completeUpload(
        session.id,
        {},
        {
          principal: principalA,
        },
      );
      ids.push(file.id);
      await files.process(file.id, { delayMs: 200 }, { principal: principalA });
    }
    await Promise.all([
      runWorker({
        once: true,
        options: {
          env: 'test',
          storage: { root: path.join(dir, 'objects') },
          metadata: { filename: path.join(dir, 'meta.sqlite') },
          processing: { mode: 'inline', spawn: 'never', concurrency: 1 },
        },
      }),
      runWorker({
        once: true,
        options: {
          env: 'test',
          storage: { root: path.join(dir, 'objects') },
          metadata: { filename: path.join(dir, 'meta.sqlite') },
          processing: { mode: 'inline', spawn: 'never', concurrency: 1 },
        },
      }),
    ]);
    const listed = await files.listAssetIds({}, { principal: principalA });
    assert.deepEqual(listed.assetIds.sort(), ids.sort());
    const other = await files.listAssetIds({}, { principal: principalB });
    assert.deepEqual(other.assetIds, []);
    const sql = openSqlite(path.join(dir, 'meta.sqlite'));
    const stored = await sql.get<{ original_object_key: string }>(
      'SELECT original_object_key FROM filevora_assets WHERE id = ?',
      [ids[0]],
    );
    await sql.close();
    assert.match(
      stored?.original_object_key ?? '',
      new RegExp(`${ids[0]}_original\\.png$`),
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

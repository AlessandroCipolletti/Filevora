import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

async function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 10, g: 40, b: 80 },
    },
  })
    .png()
    .toBuffer();
}

async function roundTrip(url: string, label: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `filevora-${label}-`));
  const tenant = `tenant-${label}-${Date.now()}`;
  const principal = { id: 'user-a', tenantId: tenant };
  const body = await png();
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { mode: 'stored', url },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: { allowedMimeTypes: ['image/png'] },
  });
  try {
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: body.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, body, { principal });
    const created = await files.completeUpload(session.id, {}, { principal });
    await files.touch(created.id, { principal });
    await files.process(created.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const loaded = await files.get(created.id, { principal });
    assert.equal(loaded.asset?.assetId, created.id);
    assert.equal(loaded.uploadState, 'verified');
    assert.equal(loaded.asset?.versions._original?.status, 'ready');
    assert.ok(loaded.variants.some((variant) => variant.name === 'thumbnail'));
    const page = await files.list({}, { principal });
    assert.ok(page.items.some((item) => item.id === created.id));
    await files.delete(created.id, { principal });
    await assert.rejects(files.get(created.id, { principal }));
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('createFiles stores assets in PostgreSQL', async (t) => {
  const url = process.env.FILEVORA_POSTGRES_URL;
  if (!url) {
    t.skip('FILEVORA_POSTGRES_URL is not set');
    return;
  }
  await roundTrip(url, 'pg');
});

test('createFiles stores assets in MySQL', async (t) => {
  const url = process.env.FILEVORA_MYSQL_URL;
  if (!url) {
    t.skip('FILEVORA_MYSQL_URL is not set');
    return;
  }
  await roundTrip(url, 'my');
});

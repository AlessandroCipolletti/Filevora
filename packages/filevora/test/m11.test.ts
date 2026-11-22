import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileSdkError } from '../dist/errors/error.js';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('corrupt bytes and a measured image variant stay within the tested limits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m11-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
  });
  try {
    const junk = Buffer.from('this is not a png');
    const session = await files.createUploadSession(
      { filename: 'fake.png', mimeType: 'image/png', bytes: junk.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, junk, { principal });
    await assert.rejects(
      files.completeUpload(session.id, {}, { principal }),
      (error: unknown) => {
        return (
          error instanceof FileSdkError &&
          (error.code === 'UNSUPPORTED_MIME' || error.code === 'MIME_MISMATCH')
        );
      },
    );
    const real = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: PNG.byteLength },
      { principal },
    );
    await files.writePart(real.id, 1, PNG, { principal });
    const record = await files.completeUpload(real.id, {}, { principal });
    const started = Date.now();
    await files.process(record.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const elapsed = Date.now() - started;
    console.log(`benchmark_image_ms=${elapsed}`);
    assert.ok(elapsed < 10_000);
    const ready = await files.get(record.id, { principal });
    assert.equal(ready.variants.length, 3);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

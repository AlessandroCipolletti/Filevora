import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 90, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

async function setup(dir: string, maxPixels = 40_000_000) {
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never', imageMaxPixels: maxPixels },
    defaults: {
      allowedMimeTypes: ['image/png', 'image/webp'],
      maxFileBytes: 20 * 1024 * 1024,
    },
  });
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
  return { files, handler };
}

async function store(
  files: Awaited<ReturnType<typeof setup>>['files'],
  body: Buffer,
  name: string,
) {
  const session = await files.createUploadSession(
    { filename: name, mimeType: 'image/png', bytes: body.byteLength },
    { principal },
  );
  await files.writePart(session.id, 1, body, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

test('web-optimized variants keep the original and do not upscale', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m4-'));
  try {
    const { files, handler } = await setup(dir);
    const large = await png(2000, 1000);
    const originalHash = createHash('sha256').update(large).digest('hex');
    const record = await store(files, large, 'wide.png');
    await files.process(record.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    await files.process(record.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const ready = await files.get(record.id, { principal });
    assert.equal(ready.checksum, originalHash);
    assert.equal(ready.variants.length, 3);
    const byName = Object.fromEntries(
      ready.variants.map((variant) => [variant.name, variant]),
    );
    assert.equal(byName.thumbnail?.width, 320);
    assert.equal(byName.optimized?.width, 1280);
    assert.equal(byName.hd?.width, 1920);
    const delivery = await handler(
      new Request(`http://app.local/files/${record.id}/delivery`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user': 'user-a',
          'x-tenant': 'tenant-a',
        },
        body: '{}',
      }),
    );
    const body = (await delivery.json()) as {
      variants: Record<string, { url: string }>;
    };
    const thumb = await handler(
      new Request(body.variants.thumbnail?.url ?? ''),
    );
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    assert.equal(meta.width, 320);
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined);

    const small = await store(files, await png(40, 20), 'tiny.png');
    await files.process(small.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const tiny = await files.get(small.id, { principal });
    assert.equal(
      tiny.variants.every((variant) => (variant.width ?? 0) <= 40),
      true,
    );
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an image over the pixel limit fails without a variant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m4-limit-'));
  try {
    const { files } = await setup(dir, 100);
    const body = await png(50, 50);
    const record = await store(files, body, 'big.png');
    const job = await files.process(record.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const finished = await files.getJob(job.id, { principal });
    assert.equal(finished.state, 'failed');
    assert.equal(finished.errorCode, 'INVALID_RECIPE');
    const file = await files.get(record.id, { principal });
    assert.equal(file.variants.length, 0);
    assert.equal(
      file.checksum,
      createHash('sha256').update(body).digest('hex'),
    );
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

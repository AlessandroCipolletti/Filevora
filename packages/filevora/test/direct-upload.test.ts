import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { FileSdkError } from '../dist/errors/error.js';
import { createFiles } from '../dist/server/index.js';
import { createTestFiles } from '../dist/testing/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('filesystem storage cannot sign a direct upload', async () => {
  const files = createTestFiles();
  try {
    await assert.rejects(
      () =>
        files.files.createDirectUpload(
          {
            filename: 'dot.png',
            mimeType: 'image/png',
            bytes: PNG.byteLength,
            mode: 'single',
          },
          { principal: files.principal },
        ),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'INVALID_CONFIG',
    );
  } finally {
    await files.close();
  }
});

test('a single presigned PUT is verified and processed', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
    return;
  }
  const region = process.env.FILEVORA_S3_REGION ?? 'us-east-1';
  const accessKeyId = process.env.FILEVORA_S3_ACCESS_KEY_ID ?? 'local';
  const secretAccessKey =
    process.env.FILEVORA_S3_SECRET_ACCESS_KEY ?? 'localpassword';
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const bucket = 'filevora-direct-single';
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-direct-'));
  try {
    await client
      .send(new CreateBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
    const files = createFiles({
      env: 'test',
      storage: {
        driver: 's3',
        root: dir,
        s3: {
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey,
          forcePathStyle: true,
        },
      },
      processing: { mode: 'sync', spawn: 'never' },
      upload: { chunkBytes: 64 * 1024 },
      defaults: { allowedMimeTypes: ['image/png'] },
    });
    try {
      const principal = { id: 'user-a', tenantId: 'tenant-direct' };
      const created = await files.createDirectUpload(
        {
          filename: 'dot.png',
          mimeType: 'image/png',
          bytes: PNG.byteLength,
          mode: 'single',
          preset: 'thumbnail',
        },
        { principal },
      );
      assert.equal(created.mode, 'single');
      assert.ok(created.url);
      const put = await fetch(created.url, {
        method: 'PUT',
        headers: created.headers,
        body: PNG,
      });
      assert.equal(put.status, 200, await put.text());
      const done = await files.completeDirectUpload(
        created.sessionId,
        {},
        { principal },
      );
      assert.equal(done.uploadState, 'verified');
      assert.equal(done.detectedMime, 'image/png');
      assert.equal(done.bytes, PNG.byteLength);
      assert.equal(done.processingState, 'ready');
      assert.ok(done.variants.some((variant) => variant.name === 'thumbnail'));

      const multi = await files.createDirectUpload(
        {
          filename: 'dot.png',
          mimeType: 'image/png',
          bytes: PNG.byteLength,
          mode: 'multipart',
          preset: 'thumbnail',
        },
        { principal },
      );
      assert.equal(multi.mode, 'multipart');
      assert.equal(multi.parts?.length, 1);
      const part = multi.parts?.[0];
      assert.ok(part);
      const partPut = await fetch(part.url, { method: 'PUT', body: PNG });
      assert.equal(partPut.status, 200, await partPut.text());
      const etag = partPut.headers.get('etag');
      assert.ok(etag);
      const finished = await files.completeDirectUpload(
        multi.sessionId,
        { parts: [{ partNumber: part.partNumber, etag }] },
        { principal },
      );
      assert.equal(finished.detectedMime, 'image/png');
      assert.equal(finished.processingState, 'ready');
    } finally {
      await files.close();
    }
  } finally {
    client.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

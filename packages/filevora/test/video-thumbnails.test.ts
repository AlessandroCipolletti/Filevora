import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveConfig } from '../dist/config/load.js';
import { FileSdkError } from '../dist/errors/error.js';
import { spriteTimeline, thumbnailTimes } from '../dist/processors/frames.js';
import { createFiles } from '../dist/server/index.js';
import { openStorage, readAll } from '../dist/storage/stage.js';
import {
  createTestFiles,
  sampleMp4,
  type TestFiles,
} from '../dist/testing/index.js';
import { parseAssetTransform } from '../dist/transform/schema.js';

test('thumbnail times and the sprite map do not need ffmpeg', () => {
  assert.deepEqual(
    thumbnailTimes({ durationMs: 1000, count: 4 }),
    [125, 375, 625, 750],
  );
  assert.deepEqual(
    thumbnailTimes({ durationMs: 1000, atPercent: [0, 100] }),
    [0, 750],
  );
  const map = spriteTimeline({
    timesMs: [0, 500],
    columns: 2,
    cellWidth: 80,
    cellHeight: 40,
    image: 'sprite.webp',
  });
  assert.match(map.vtt, /^WEBVTT\n/);
  assert.match(map.vtt, /sprite\.webp#xywh=80,0,80,40/);
  const parsed = JSON.parse(map.json) as { frames: unknown[]; image: string };
  assert.equal(parsed.image, 'sprite.webp');
  assert.equal(parsed.frames.length, 2);
  assert.throws(
    () =>
      parseAssetTransform({
        operations: [{ op: 'video.poster', atMs: 0, atPercent: 10 }],
      }),
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'TRANSFORM_REJECTED',
  );
});

test('poster, thumbnail, and sprite versions are stored from the video', async (t) => {
  const mp4 = await sampleOrSkip(t);
  if (!mp4) return;
  const files = createTestFiles();
  try {
    const thumbs = await upload(files, mp4, 'thumbnails');
    assert.equal(thumbs.processingState, 'ready');
    for (const name of ['thumb-1', 'thumb-2', 'thumb-3', 'thumb-4']) {
      const variant = thumbs.variants.find((item) => item.name === name);
      assert.equal(variant?.mimeType, 'image/webp');
    }
    const sheet = await upload(files, mp4, 'sprites');
    assert.equal(
      sheet.variants.find((item) => item.name === 'sprite')?.mimeType,
      'image/webp',
    );
    assert.equal(
      sheet.variants.find((item) => item.name === 'sprite-vtt')?.mimeType,
      'text/vtt',
    );
    assert.equal(
      sheet.variants.find((item) => item.name === 'sprite-json')?.mimeType,
      'application/json',
    );
    const storage = await openStorage(
      resolveConfig(
        {
          env: 'test',
          storage: { driver: 'filesystem', root: files.root },
        },
        {},
      ).storage,
    );
    try {
      const listed = await storage.list('');
      const vtt = listed.find((item) => item.key.endsWith('_sprite-vtt.vtt'));
      const json = listed.find((item) =>
        item.key.endsWith('_sprite-json.json'),
      );
      assert.ok(vtt);
      assert.ok(json);
      const vttBody = Buffer.from(
        await readAll(await storage.getObject(vtt.key)),
      );
      const jsonBody = Buffer.from(
        await readAll(await storage.getObject(json.key)),
      );
      assert.match(vttBody.toString('utf8'), /^WEBVTT\n/);
      const parsed = JSON.parse(jsonBody.toString('utf8')) as {
        image: string;
        frames: unknown[];
      };
      assert.equal(parsed.image, 'sprite.webp');
      assert.ok(parsed.frames.length >= 1);
    } finally {
      await storage.close?.();
    }
    const source = await upload(files, mp4, 'poster');
    await files.files.transform(
      source.id,
      {
        operations: [
          { op: 'video.poster', atPercent: 50, width: 48 },
          { op: 'video.thumbnails', count: 2, width: 48 },
        ],
      },
      { principal: files.principal },
    );
    const loaded = await files.files.get(source.id, {
      principal: files.principal,
    });
    assert.ok(
      loaded.variants.some(
        (variant) => variant.recipeId === 'frames' && variant.name === 'poster',
      ),
    );
    assert.ok(loaded.variants.some((variant) => variant.name === 'thumb-2'));
  } finally {
    await files.close();
  }
});

test('sprite versions land in the bucket for lite and stored mode', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
    return;
  }
  const mp4 = await sampleOrSkip(t);
  if (!mp4) return;
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
  try {
    for (const mode of ['lite', 'stored'] as const) {
      const bucket = `filevora-thumbs-${mode}`;
      await client
        .send(new CreateBucketCommand({ Bucket: bucket }))
        .catch(() => undefined);
      const dir = mkdtempSync(path.join(tmpdir(), `filevora-thumbs-${mode}-`));
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
        ...(mode === 'stored'
          ? { metadata: { filename: path.join(dir, 'meta.sqlite') } }
          : {}),
        processing: { mode: 'sync', spawn: 'never' },
        upload: { chunkBytes: 64 * 1024 },
      });
      const storage = await openStorage(
        resolveConfig(
          {
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
          },
          {},
        ).storage,
      );
      try {
        const principal = { id: 'user-a', tenantId: `tenant-${mode}` };
        const session = await files.createUploadSession(
          {
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            bytes: mp4.byteLength,
            preset: 'sprites',
          },
          { principal },
        );
        const urls = await files.partUploadUrls(session.id, { principal });
        const uploaded = await fetch(urls['1'] ?? '', {
          method: 'PUT',
          body: mp4,
        });
        assert.equal(uploaded.status, 200);
        const etag = uploaded.headers.get('etag');
        assert.ok(etag);
        const done = await files.completeUpload(
          session.id,
          { parts: [{ partNumber: 1, etag }] },
          { principal },
        );
        assert.ok(
          done.variants.some((variant) => variant.name === 'sprite-vtt'),
        );
        const listed = await storage.list('');
        const vtt = listed.find((item) => item.key.endsWith('_sprite-vtt.vtt'));
        assert.ok(vtt);
        const body = Buffer.from(
          await readAll(await storage.getObject(vtt.key)),
        );
        assert.match(body.toString('utf8'), /^WEBVTT\n/);
      } finally {
        await files.close();
        await storage.close?.();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    client.destroy();
  }
});

async function sampleOrSkip(t: {
  skip: (message?: string) => void;
}): Promise<Uint8Array | undefined> {
  try {
    return await sampleMp4();
  } catch {
    t.skip('ffmpeg is not available');
    return undefined;
  }
}

async function upload(files: TestFiles, body: Uint8Array, preset: string) {
  const session = await files.files.createUploadSession(
    {
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      bytes: body.byteLength,
      preset,
    },
    { principal: files.principal },
  );
  await files.files.writePart(session.id, 1, body, {
    principal: files.principal,
  });
  return files.files.completeUpload(
    session.id,
    {},
    { principal: files.principal },
  );
}

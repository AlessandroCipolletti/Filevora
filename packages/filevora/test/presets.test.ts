import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { FileSdkError } from '../dist/errors/error.js';
import { createFiles } from '../dist/server/index.js';
import {
  createTestFiles,
  sampleMp4,
  samplePng,
} from '../dist/testing/index.js';

test('named presets reject unknown names and the wrong media type', async () => {
  const files = createTestFiles();
  await assert.rejects(
    () =>
      files.files.createUploadSession(
        {
          filename: 'a.png',
          mimeType: 'image/png',
          bytes: 8,
          preset: 'nope',
        },
        { principal: files.principal },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'TRANSFORM_REJECTED');
      const names = error.context?.validPresets;
      assert.ok(Array.isArray(names));
      assert.ok(names.includes('avatar'));
      assert.ok(names.includes('video-720p'));
      return true;
    },
  );
  const png = samplePng();
  const session = await files.files.createUploadSession(
    {
      filename: 'a.png',
      mimeType: 'image/png',
      bytes: png.byteLength,
      preset: 'video-720p',
    },
    { principal: files.principal },
  );
  await files.files.writePart(session.id, 1, png, {
    principal: files.principal,
  });
  await assert.rejects(
    () =>
      files.files.completeUpload(
        session.id,
        {},
        { principal: files.principal },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'TRANSFORM_REJECTED');
      const names = error.context?.validPresets;
      assert.ok(Array.isArray(names));
      assert.ok(names.includes('thumbnail'));
      assert.equal(names.includes('video-720p'), false);
      return true;
    },
  );
  await files.close();
});

test('avatar and a custom preset publish versions in lite mode', async () => {
  const files = createTestFiles({
    presets: {
      badge: {
        family: 'image',
        operations: [
          { op: 'image.resize', width: 64, height: 64, fit: 'cover' },
        ],
      },
    },
  });
  const body = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 20, g: 40, b: 80 },
    },
  })
    .png()
    .toBuffer();
  const avatar = await upload(files, body, 'face.png', 'avatar');
  const avatarVariant = avatar.variants.find(
    (variant) => variant.name === 'avatar',
  );
  assert.equal(avatarVariant?.width, 512);
  assert.equal(avatarVariant?.height, 512);
  assert.equal(avatarVariant?.mimeType, 'image/webp');
  const event = await files.files.processingSnapshot(
    avatar.id,
    { principal: files.principal },
    { baseUrl: 'http://files.test' },
  );
  assert.equal(typeof event.versions?.avatar?.url, 'string');
  assert.equal(typeof event.versions?._original?.url, 'string');

  const badge = await upload(files, body, 'badge.png', 'badge');
  const badgeVariant = badge.variants.find(
    (variant) => variant.name === 'badge',
  );
  assert.equal(badgeVariant?.width, 64);
  assert.equal(badgeVariant?.height, 64);

  const transformed = await files.files.transform(
    badge.id,
    { preset: 'og-image' },
    { principal: files.principal },
  );
  assert.equal(transformed.replace, true);
  assert.equal(transformed.assetId, badge.id);
  await files.close();
});

test('poster and 720p presets keep the original video and add a version', async () => {
  const files = createTestFiles();
  const video = await sampleMp4();
  const poster = await upload(
    files,
    Buffer.from(video),
    'clip.mp4',
    'poster',
    'video/mp4',
  );
  assert.ok(poster.variants.some((variant) => variant.name === 'poster'));
  assert.equal(poster.bytes > 0, true);
  const hd = await upload(
    files,
    Buffer.from(video),
    'clip2.mp4',
    'video-720p',
    'video/mp4',
  );
  const version = hd.variants.find((variant) => variant.name === '720p');
  assert.equal(version?.height, 720);
  assert.equal(version?.mimeType, 'video/mp4');
  await files.close();
});

test('a stored database uses the same preset versions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-preset-stored-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
  });
  const principal = { id: 'user-a', tenantId: 'tenant-a' };
  const body = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .png()
    .toBuffer();
  const session = await files.createUploadSession(
    {
      filename: 'sq.png',
      mimeType: 'image/png',
      bytes: body.byteLength,
      preset: 'social-square',
    },
    { principal },
  );
  await files.writePart(session.id, 1, body, { principal });
  const stored = await files.completeUpload(session.id, {}, { principal });
  const square = stored.variants.find((variant) => variant.name === 'square');
  assert.equal(square?.width, 1080);
  assert.equal(square?.height, 1080);
  await files.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the thumbnail preset follows the configured width', async () => {
  const body = await sharp({
    create: {
      width: 2000,
      height: 1000,
      channels: 3,
      background: { r: 9, g: 9, b: 9 },
    },
  })
    .png()
    .toBuffer();
  const wide = createTestFiles();
  const narrow = createTestFiles({ defaults: { thumbnailWidth: 320 } });
  try {
    const full = await upload(wide, body, 'wide.png', 'thumbnail');
    const small = await upload(narrow, body, 'wide.png', 'thumbnail');
    const optimized = await upload(wide, body, 'set.png', 'web-optimized');
    const optimizedNarrow = await upload(
      narrow,
      body,
      'set.png',
      'web-optimized',
    );
    assert.equal(
      full.variants.find((variant) => variant.name === 'thumbnail')?.width,
      480,
    );
    assert.equal(
      small.variants.find((variant) => variant.name === 'thumbnail')?.width,
      320,
    );
    const wideByName = Object.fromEntries(
      optimized.variants.map((variant) => [variant.name, variant.width]),
    );
    const narrowByName = Object.fromEntries(
      optimizedNarrow.variants.map((variant) => [variant.name, variant.width]),
    );
    assert.equal(wideByName.thumbnail, 480);
    assert.equal(wideByName.optimized, 1280);
    assert.equal(wideByName.hd, 1920);
    assert.equal(narrowByName.thumbnail, 320);
    assert.equal(narrowByName.optimized, 1280);
    assert.equal(narrowByName.hd, 1920);
  } finally {
    await wide.close();
    await narrow.close();
  }
});

test('custom presets that reuse a built-in name are rejected', () => {
  assert.throws(
    () =>
      createFiles({
        env: 'test',
        storage: { root: path.join(tmpdir(), 'filevora-preset-bad') },
        presets: {
          thumbnail: {
            family: 'image',
            operations: [{ op: 'image.resize', width: 10 }],
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'INVALID_CONFIG');
      return true;
    },
  );
});

async function upload(
  files: ReturnType<typeof createTestFiles>,
  body: Buffer,
  filename: string,
  preset: string,
  mimeType = 'image/png',
) {
  const session = await files.files.createUploadSession(
    { filename, mimeType, bytes: body.byteLength, preset },
    { principal: files.principal },
  );
  await files.files.writePart(session.id, 1, body, {
    principal: files.principal,
  });
  return files.files.completeUpload(
    session.id,
    {},
    {
      principal: files.principal,
    },
  );
}

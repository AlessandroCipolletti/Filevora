import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createUploadClient } from '../dist/client/index.js';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { tenantPath } from '../dist/ids.js';
import { createFiles, type TransformRequest } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

function filesFor(dir: string, stored = false) {
  return createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    ...(stored
      ? { metadata: { filename: path.join(dir, 'host.sqlite') } }
      : {}),
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: {
      allowedMimeTypes: ['image/png', 'video/mp4', 'application/pdf'],
    },
  });
}

async function upload(
  files: ReturnType<typeof createFiles>,
  name: string,
  mime: string,
  body: Buffer,
) {
  const session = await files.createUploadSession(
    { filename: name, mimeType: mime, bytes: body.byteLength },
    { principal },
  );
  await files.writePart(session.id, 1, body, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

function transformOf(
  files: ReturnType<typeof createFiles>,
  assetId: string,
  config: unknown,
) {
  return files.transform(assetId, config as TransformRequest, { principal });
}

function code(error: unknown): FileSdkError {
  assert.ok(error instanceof FileSdkError);
  return error;
}

test('transform config errors name the field, the type, and the valid operations', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-transform-err-'));
  const files = filesFor(dir);
  try {
    const png = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();
    const image = await upload(files, 'dot.png', 'image/png', png);
    await assert.rejects(
      () => transformOf(files, image.id, { operations: [{ op: 'nope' }] }),
      (error: unknown) => {
        const sdk = code(error);
        assert.equal(sdk.code, 'TRANSFORM_REJECTED');
        assert.equal(typeof sdk.context?.field, 'string');
        return true;
      },
    );
    await assert.rejects(
      () =>
        transformOf(files, image.id, {
          operations: [{ op: 'pdf.removePages', pages: [1] }],
        }),
      (error: unknown) => {
        const sdk = code(error);
        assert.equal(sdk.code, 'TRANSFORM_REJECTED');
        assert.equal(sdk.context?.detectedType, 'image/png');
        assert.deepEqual(sdk.context?.validOperations, [
          'image.resize',
          'image.crop',
        ]);
        assert.match(String(sdk.context?.field), /operations\[0\]\.op/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        transformOf(files, image.id, {
          operations: [{ op: 'video.trim', startMs: 0, endMs: 10 }],
        }),
      (error: unknown) => code(error).context?.detectedType === 'image/png',
    );
    await assert.rejects(
      () =>
        transformOf(files, image.id, {
          operations: [
            { op: 'image.crop', x: 0, y: 0, width: 100, height: 100 },
          ],
        }),
      (error: unknown) => {
        const sdk = code(error);
        assert.equal(sdk.context?.field, 'operations[0].width');
        assert.match(String(sdk.context?.reason), /outside 32x24/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        transformOf(files, image.id, {
          extra: true,
          operations: [{ op: 'image.resize', width: 8 }],
        }),
      (error: unknown) => code(error).context?.field === 'extra',
    );
    await assert.rejects(
      () =>
        transformOf(files, 'file_missing', {
          operations: [{ op: 'image.resize', width: 8 }],
        }),
      (error: unknown) => code(error).code === 'ASSET_NOT_FOUND',
    );
    const original = path.join(dir, 'objects', tenantPath('tenant-a'));
    for (const name of readdirSync(original)) {
      if (name.includes('_original.')) rmSync(path.join(original, name));
    }
    await assert.rejects(
      () =>
        transformOf(files, image.id, {
          operations: [{ op: 'image.resize', width: 8 }],
        }),
      (error: unknown) => code(error).code === 'ASSET_NOT_FOUND',
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image, video, and PDF transforms run on the queue in lite and stored mode', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-transform-'));
  const storedDir = mkdtempSync(path.join(tmpdir(), 'filevora-transform-db-'));
  const files = filesFor(dir);
  const stored = filesFor(storedDir, true);
  try {
    const png = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: { r: 200, g: 10, b: 10 },
      },
    })
      .png()
      .toBuffer();
    const image = await upload(files, 'wide.png', 'image/png', png);
    const launched = await transformOf(files, image.id, {
      operations: [
        { op: 'image.crop', x: 0, y: 0, width: 20, height: 20 },
        { op: 'image.resize', width: 10, height: 10 },
      ],
    });
    assert.equal(launched.launched, true);
    assert.equal(launched.replace, true);
    assert.equal(launched.assetId, image.id);
    assert.equal(launched.jobId.startsWith('job_'), true);
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const replaced = await files.get(image.id, { principal });
    assert.equal(replaced.processingState, 'ready');
    const meta = await sharp(
      path.join(
        dir,
        'objects',
        tenantPath('tenant-a'),
        readdirSync(path.join(dir, 'objects', tenantPath('tenant-a'))).find(
          (name) => name.startsWith(`${image.id}_original.`),
        ) ?? '',
      ),
    ).metadata();
    assert.equal(meta.width, 10);
    assert.equal(meta.height, 10);
    const snap = await files.processingSnapshot(
      image.id,
      { principal },
      {
        baseUrl: 'http://app.local',
      },
    );
    assert.equal(snap.terminal, true);
    assert.equal(snap.phase, 'processing');
    assert.equal(snap.assetId, image.id);
    assert.match(snap.versions?._original?.url ?? '', /\/content\//);

    const copy = await transformOf(files, image.id, {
      replace: false,
      operations: [{ op: 'image.resize', width: 8, height: 8 }],
    });
    assert.notEqual(copy.assetId, image.id);
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const created = await files.get(copy.assetId, { principal });
    assert.equal(created.processingState, 'ready');
    const source = await files.get(image.id, { principal });
    assert.equal(source.bytes, replaced.bytes);

    const videoPath = path.join(dir, 'clip.mp4');
    const generated = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64:d=0.4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        videoPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const { readFileSync } = await import('node:fs');
    const video = await upload(
      files,
      'clip.mp4',
      'video/mp4',
      readFileSync(videoPath),
    );
    await transformOf(files, video.id, {
      operations: [
        { op: 'video.crop', x: 0, y: 0, width: 32, height: 32 },
        { op: 'video.trim', startMs: 0, endMs: 200 },
        { op: 'video.resize', width: 16, height: 16 },
      ],
    });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const videoReady = await files.get(video.id, { principal });
    assert.equal(videoReady.detectedMime, 'video/mp4');
    assert.equal(videoReady.processingState, 'ready');

    const pdf = await PDFDocument.create();
    pdf.addPage([40, 40]);
    pdf.addPage([40, 40]);
    const pdfBytes = Buffer.from(await pdf.save());
    const document = await upload(
      stored,
      'two.pdf',
      'application/pdf',
      pdfBytes,
    );
    const pdfJob = await transformOf(stored, document.id, {
      operations: [{ op: 'pdf.removePages', pages: [2] }],
    });
    assert.equal(pdfJob.assetId, document.id);
    await runWorker({
      once: true,
      options: workerConfigOptions(stored.config),
    });
    const pdfReady = await stored.get(document.id, { principal });
    assert.equal(pdfReady.processingState, 'ready');
    const opened = await PDFDocument.load(
      readFileSync(
        path.join(
          storedDir,
          'objects',
          tenantPath('tenant-a'),
          readdirSync(
            path.join(storedDir, 'objects', tenantPath('tenant-a')),
          ).find((name) => name.startsWith(`${document.id}_original.`)) ?? '',
        ),
      ),
    );
    assert.equal(opened.getPageCount(), 1);

    const handler = createFilesHandler({
      files,
      async authenticate() {
        return principal;
      },
      async authorize() {
        return true;
      },
      async policy() {
        return {};
      },
    });
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const viaClient = await client.transform(image.id, {
      replace: false,
      operations: [{ op: 'image.resize', width: 6, height: 6 }],
    });
    assert.equal(viaClient.launched, true);
    assert.notEqual(viaClient.assetId, image.id);
  } finally {
    await files.close();
    await stored.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(storedDir, { recursive: true, force: true });
  }
});

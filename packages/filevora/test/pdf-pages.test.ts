import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveConfig } from '../dist/config/load.js';
import { FileSdkError } from '../dist/errors/error.js';
import {
  renderPdfPage,
  selectPdfPages,
} from '../dist/processors/pdf-preview.js';
import { createFiles } from '../dist/server/index.js';
import { openStorage, readAll } from '../dist/storage/stage.js';
import {
  createTestFiles,
  samplePdf,
  type TestFiles,
} from '../dist/testing/index.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('page selection stays inside the document', () => {
  assert.deepEqual(selectPdfPages(3), [1, 2, 3]);
  assert.deepEqual(selectPdfPages(3, [3, 1]), [3, 1]);
  assert.throws(
    () => selectPdfPages(2, [4]),
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'TRANSFORM_REJECTED',
  );
  assert.throws(
    () => selectPdfPages(60),
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'TRANSFORM_REJECTED',
  );
});

test('a missing pdftoppm fails the page render with a clear error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-pdf-missing-'));
  const pdf = path.join(dir, 'in.pdf');
  try {
    writeFileSync(pdf, await samplePdf());
    await assert.rejects(
      () =>
        renderPdfPage({
          pdfPath: pdf,
          page: 1,
          dpi: 72,
          timeoutMs: 5_000,
          binary: 'pdftoppm-not-installed-filevora',
        }),
      (error: unknown) =>
        error instanceof FileSdkError &&
        error.code === 'PROCESSOR_UNAVAILABLE' &&
        error.message.includes('Poppler'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pdf page presets and operations store images', async (t) => {
  if (!popplerInstalled()) {
    t.skip('pdftoppm is not installed');
    return;
  }
  const pdf = await samplePdf();
  const files = createTestFiles();
  try {
    const all = await upload(files, pdf, 'pdf-pages');
    assert.equal(all.processingState, 'ready');
    assert.equal(
      all.variants.find((variant) => variant.name === 'page-1')?.mimeType,
      'image/png',
    );
    assert.equal(
      all.variants.find((variant) => variant.name === 'page-2')?.mimeType,
      'image/png',
    );
    const storage = await openStorage(
      resolveConfig(
        { env: 'test', storage: { driver: 'filesystem', root: files.root } },
        {},
      ).storage,
    );
    try {
      const listed = await storage.list('');
      const page = listed.find((item) => item.key.endsWith('_page-1.png'));
      assert.ok(page);
      const bytes = Buffer.from(
        await readAll(await storage.getObject(page.key)),
      );
      assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC));
    } finally {
      await storage.close?.();
    }
    const cover = await upload(files, pdf, 'pdf-cover');
    assert.equal(
      cover.variants.find((variant) => variant.name === 'page-1')?.mimeType,
      'image/webp',
    );
    assert.equal(
      cover.variants.some((variant) => variant.name === 'page-2'),
      false,
    );
    await files.files.transform(
      cover.id,
      { operations: [{ op: 'pdf.pages', pages: [9], format: 'png' }] },
      { principal: files.principal },
    );
    const rejected = await files.files.get(cover.id, {
      principal: files.principal,
    });
    assert.equal(rejected.processingState, 'failed');
    assert.equal(
      rejected.variants.some((variant) => variant.name === 'page-9'),
      false,
    );
    await files.files.transform(
      cover.id,
      {
        operations: [
          { op: 'pdf.pages', pages: [2], format: 'jpeg', width: 80, dpi: 72 },
        ],
      },
      { principal: files.principal },
    );
    const loaded = await files.files.get(cover.id, {
      principal: files.principal,
    });
    const pageTwo = loaded.variants.find(
      (variant) =>
        variant.recipeId === 'pdf-stills' && variant.name === 'page-2',
    );
    assert.equal(pageTwo?.mimeType, 'image/jpeg');
    assert.ok((pageTwo?.width ?? 0) <= 80);
  } finally {
    await files.close();
  }
});

test('pdf page images land in the bucket for lite and stored mode', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
    return;
  }
  if (!popplerInstalled()) {
    t.skip('pdftoppm is not installed');
    return;
  }
  const pdf = await samplePdf();
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
      const bucket = `filevora-pdf-pages-${mode}`;
      await client
        .send(new CreateBucketCommand({ Bucket: bucket }))
        .catch(() => undefined);
      const dir = mkdtempSync(
        path.join(tmpdir(), `filevora-pdf-pages-${mode}-`),
      );
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
            filename: 'doc.pdf',
            mimeType: 'application/pdf',
            bytes: pdf.byteLength,
            preset: 'pdf-pages',
          },
          { principal },
        );
        const urls = await files.partUploadUrls(session.id, { principal });
        const uploaded = await fetch(urls['1'] ?? '', {
          method: 'PUT',
          body: pdf,
        });
        assert.equal(uploaded.status, 200);
        const etag = uploaded.headers.get('etag');
        assert.ok(etag);
        const done = await files.completeUpload(
          session.id,
          { parts: [{ partNumber: 1, etag }] },
          { principal },
        );
        assert.equal(done.processingState, 'ready');
        assert.ok(done.variants.some((variant) => variant.name === 'page-2'));
        const listed = await storage.list('');
        const page = listed.find((item) => item.key.endsWith('_page-1.png'));
        assert.ok(page);
        const bytes = Buffer.from(
          await readAll(await storage.getObject(page.key)),
        );
        assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC));
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

function popplerInstalled(): boolean {
  return spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' }).status === 0;
}

async function upload(files: TestFiles, body: Uint8Array, preset: string) {
  const session = await files.files.createUploadSession(
    {
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
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

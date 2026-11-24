import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createFiles } from '../dist/server/index.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { resolveConfig } from '../dist/config/load.js';
import { runDoctor } from '../dist/diagnostics/doctor.js';
import { FileSdkError } from '../dist/errors/error.js';
import {
  convertOfficeToPdf,
  describePdf,
} from '../dist/processors/pdf-tools.js';
import { openStorage, readAll } from '../dist/storage/stage.js';
import { createTestFiles, samplePdf } from '../dist/testing/index.js';

test('a PDF description lists every page', async () => {
  const described = await describePdf(await samplePdf());
  assert.equal(described.metadata.pageCount, 2);
  assert.equal(described.pages.length, 2);
  assert.equal(described.pages[0]?.page, 1);
  assert.equal(typeof described.pages[1]?.width, 'number');
});

test('pdf-text, merge, and split keep the bytes in storage', async () => {
  const pdf = await samplePdf();
  const files = createTestFiles();
  try {
    const session = await files.files.createUploadSession(
      {
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        bytes: pdf.byteLength,
        preset: 'pdf-text',
      },
      { principal: files.principal },
    );
    await files.files.writePart(session.id, 1, pdf, {
      principal: files.principal,
    });
    const textAsset = await files.files.completeUpload(
      session.id,
      {},
      { principal: files.principal },
    );
    assert.equal(textAsset.processingState, 'ready');
    assert.equal(
      textAsset.variants.find((variant) => variant.name === 'text')?.mimeType,
      'application/json',
    );
    const storage = await openStorage(
      resolveConfig(
        { env: 'test', storage: { driver: 'filesystem', root: files.root } },
        {},
      ).storage,
    );
    try {
      const listed = await storage.list('');
      const text = listed.find((item) => item.key.endsWith('_text.json'));
      assert.ok(text);
      const body = JSON.parse(
        Buffer.from(await readAll(await storage.getObject(text.key))).toString(
          'utf8',
        ),
      ) as { metadata: { pageCount: number }; pages: unknown[] };
      assert.equal(body.metadata.pageCount, 2);
      assert.equal(body.pages.length, 2);
    } finally {
      await storage.close?.();
    }

    const left = await uploadPlain(files, pdf, 'left.pdf');
    const right = await uploadPlain(files, pdf, 'right.pdf');
    const merged = await files.files.mergePdfs([left.id, right.id], {
      principal: files.principal,
    });
    const mergedRecord = await files.files.get(merged.assetId, {
      principal: files.principal,
    });
    assert.equal(mergedRecord.processingState, 'ready');
    assert.equal(mergedRecord.detectedMime, 'application/pdf');
    assert.ok(mergedRecord.bytes > pdf.byteLength);

    const split = await files.files.splitPdf(left.id, [[1], [2]], {
      principal: files.principal,
    });
    assert.equal(split.assetIds.length, 2);
    for (const id of split.assetIds) {
      const part = await files.files.get(id, { principal: files.principal });
      assert.equal(part.processingState, 'ready');
      assert.equal(part.detectedMime, 'application/pdf');
      assert.ok(part.bytes > 0);
    }
  } finally {
    await files.close();
  }
});

test('a missing LibreOffice binary fails Office conversion clearly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-office-missing-'));
  const source = path.join(dir, 'note.docx');
  try {
    writeFileSync(source, Buffer.from('not a document'));
    await assert.rejects(
      () =>
        convertOfficeToPdf({
          sourcePath: source,
          timeoutMs: 5_000,
          binary: 'soffice-not-installed-filevora',
        }),
      (error: unknown) =>
        error instanceof FileSdkError &&
        error.code === 'PROCESSOR_UNAVAILABLE' &&
        error.message.includes('LibreOffice'),
    );
    const report = await runDoctor({ env: 'test' }, { FILES_ENV: 'test' });
    const office = report.checks.find((check) => check.id === 'libreoffice');
    assert.ok(office);
    assert.equal(office?.required, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a merged PDF is stored in the bucket', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
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
  const bucket = 'filevora-pdf-merge';
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-pdf-merge-'));
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
      const principal = { id: 'user-a', tenantId: 'tenant-merge' };
      const left = await uploadS3(files, pdf, principal);
      const right = await uploadS3(files, pdf, principal);
      const merged = await files.mergePdfs([left, right], { principal });
      const record = await files.get(merged.assetId, { principal });
      assert.equal(record.processingState, 'ready');
      const listed = await storage.list('');
      const object = listed.find(
        (item) =>
          item.key.includes(merged.assetId) && item.key.endsWith('.pdf'),
      );
      assert.ok(object);
      const bytes = Buffer.from(
        await readAll(await storage.getObject(object.key)),
      );
      assert.equal(bytes.subarray(0, 5).toString('utf8'), '%PDF-');
    } finally {
      await files.close();
      await storage.close?.();
    }
  } finally {
    client.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function uploadS3(
  files: ReturnType<typeof createFiles>,
  body: Uint8Array,
  principal: { id: string; tenantId: string },
) {
  const session = await files.createUploadSession(
    {
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      bytes: body.byteLength,
    },
    { principal },
  );
  const urls = await files.partUploadUrls(session.id, { principal });
  const uploaded = await fetch(urls['1'] ?? '', { method: 'PUT', body });
  assert.equal(uploaded.status, 200);
  const etag = uploaded.headers.get('etag');
  assert.ok(etag);
  const done = await files.completeUpload(
    session.id,
    { parts: [{ partNumber: 1, etag }] },
    { principal },
  );
  return done.id;
}

test('merged PDF page count is the sum of the sources', async () => {
  const pdf = await samplePdf();
  const merged = await (
    await import('../dist/processors/pdf-tools.js')
  ).mergePdfBuffers([pdf, pdf]);
  const doc = await PDFDocument.load(merged);
  assert.equal(doc.getPageCount(), 4);
});

async function uploadPlain(
  files: ReturnType<typeof createTestFiles>,
  body: Uint8Array,
  filename: string,
) {
  const session = await files.files.createUploadSession(
    {
      filename,
      mimeType: 'application/pdf',
      bytes: body.byteLength,
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

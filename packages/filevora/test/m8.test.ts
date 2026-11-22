import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import excel from 'exceljs';
import { FileSdkError } from '../dist/errors/error.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const textPdf = Buffer.from(
  '%PDF-1.4\n4 0 obj\n<< /Length 40 >>\nstream\nBT (Hello Filevora) Tj ET\nendstream\nendobj\n3 0 obj << /Type /Page /Contents 4 0 R >> endobj\n',
);
const emptyPdf = Buffer.from('%PDF-1.4\n3 0 obj << /Type /Page >> endobj\n');
const encryptedPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n',
);

async function setup(dir: string) {
  return createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: {
      allowedMimeTypes: [
        'application/pdf',
        'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/zip',
      ],
    },
  });
}

async function upload(
  files: ReturnType<typeof setup> extends Promise<infer T> ? T : never,
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

test('pdf and tabular fixtures return text, row errors, and safe failures', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m8-'));
  const files = await setup(dir);
  try {
    const pdf = await upload(files, 'hello.pdf', 'application/pdf', textPdf);
    const read = await files.normalize(pdf.id, { kind: 'pdf' }, { principal });
    assert.equal((read.body as { text: string }).text, 'Hello Filevora');
    const scanned = await upload(
      files,
      'scan.pdf',
      'application/pdf',
      emptyPdf,
    );
    const noText = await files.normalize(
      scanned.id,
      { kind: 'pdf' },
      { principal },
    );
    assert.equal((noText.body as { text: string; code?: string }).text, '');
    assert.equal((noText.body as { code?: string }).code, 'OCR_NOT_CONFIGURED');
    const locked = await upload(
      files,
      'locked.pdf',
      'application/pdf',
      encryptedPdf,
    );
    await assert.rejects(
      files.normalize(locked.id, { kind: 'pdf' }, { principal }),
      (error: unknown) => {
        return error instanceof FileSdkError && error.code === 'PDF_ENCRYPTED';
      },
    );
    const csv = Buffer.from('email,amount\nok@example.com,12\nbad,4\n');
    const table = await upload(files, 'rows.csv', 'text/csv', csv);
    const normalized = await files.normalize(
      table.id,
      {
        kind: 'tabular',
        schema: {
          columns: {
            email: { type: 'email', required: true },
            amount: { type: 'number', required: true },
          },
        },
        invalidRows: 'collect',
      },
      { principal },
    );
    const result = normalized.body as {
      rowsAccepted: number;
      rowsRejected: number;
      errors: Array<{ code: string; valuePreview: string }>;
    };
    assert.equal(result.rowsAccepted, 1);
    assert.equal(result.rowsRejected, 1);
    assert.equal(result.errors[0]?.code, 'INVALID_EMAIL');
    assert.equal(result.errors[0]?.valuePreview, '***');
    const workbook = new excel.Workbook();
    const sheet = workbook.addWorksheet('Purchases');
    sheet.addRow(['email', 'amount']);
    sheet.addRow(['sheet@example.com', 9]);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const sheetFile = await upload(
      files,
      'rows.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsx,
    );
    const fromSheet = await files.normalize(
      sheetFile.id,
      {
        kind: 'tabular',
        schema: {
          columns: {
            email: { type: 'email', required: true },
            amount: { type: 'number', required: true },
          },
        },
        sheet: 'Purchases',
      },
      { principal },
    );
    assert.equal((fromSheet.body as { rowsAccepted: number }).rowsAccepted, 1);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

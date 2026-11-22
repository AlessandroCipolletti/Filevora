import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../dist/diagnostics/doctor.js';
import { renderPdfFirstPage } from '../dist/processors/pdf-preview.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pagePdf(): Buffer {
  const stream = 'BT /F1 24 Tf 20 100 Td (Hello Filevora) Tj ET\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xref = Buffer.byteLength(body);
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    table += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function findPagePng(root: string): Buffer | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, name.name);
      if (name.isDirectory()) pending.push(full);
      else if (name.name === 'page-1.png') return readFileSync(full);
    }
  }
  return undefined;
}

test('a missing pdftoppm leaves the preview unavailable', async () => {
  const preview = await renderPdfFirstPage(
    pagePdf(),
    'pdftoppm-not-installed-filevora',
  );
  assert.equal(preview.available, false);
  if (!preview.available) assert.equal(preview.code, 'PROCESSOR_UNAVAILABLE');
});

test('normalize stores a PNG of PDF page 1 when pdftoppm is installed', async (t) => {
  const probe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('pdftoppm is not installed');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-pdf-'));
  const objects = path.join(dir, 'objects');
  const files = await createFiles({
    env: 'test',
    storage: { root: objects },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: { allowedMimeTypes: ['application/pdf'] },
  });
  try {
    const body = pagePdf();
    const session = await files.createUploadSession(
      {
        filename: 'hello.pdf',
        mimeType: 'application/pdf',
        bytes: body.byteLength,
      },
      { principal },
    );
    await files.writePart(session.id, 1, body, { principal });
    const uploaded = await files.completeUpload(session.id, {}, { principal });
    const read = await files.normalize(
      uploaded.id,
      { kind: 'pdf' },
      { principal },
    );
    const result = read.body as {
      text: string;
      preview: {
        available: boolean;
        width?: number;
        height?: number;
        mime?: string;
        variantId?: string;
      };
    };
    assert.equal(result.text, 'Hello Filevora');
    assert.equal(result.preview.available, true);
    assert.equal(result.preview.width, 200);
    assert.equal(result.preview.height, 200);
    assert.equal(result.preview.mime, 'image/png');
    const png = findPagePng(objects);
    assert.ok(png);
    assert.ok(png?.subarray(0, 8).equals(PNG_MAGIC));
    const record = await files.get(uploaded.id, { principal });
    const page = record.variants.find((variant) => variant.name === 'page-1');
    assert.equal(page?.id, result.preview.variantId);
    assert.equal(page?.mimeType, 'image/png');
    assert.equal(page?.width, 200);
    assert.equal(page?.height, 200);
    const report = runDoctor({
      env: 'test',
      storage: { root: objects },
      metadata: { filename: path.join(dir, 'meta.sqlite') },
    });
    const check = report.checks.find((item) => item.id === 'pdftoppm');
    assert.equal(check?.status, 'pass');
    assert.equal(check?.required, false);
    assert.equal(report.ok, true);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

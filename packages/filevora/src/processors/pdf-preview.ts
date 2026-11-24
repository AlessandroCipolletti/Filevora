import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PdfPagePreview =
  | {
      available: true;
      png: Buffer;
      width: number;
      height: number;
    }
  | { available: false; code: 'PROCESSOR_UNAVAILABLE' };

/**
 * Rasterize PDF page 1 with Poppler's pdftoppm.
 * A missing binary or a PDF Poppler cannot read returns unavailable.
 * Text extraction stays independent of this result.
 */
export async function renderPdfFirstPage(
  bytes: Uint8Array,
  binary = 'pdftoppm',
): Promise<PdfPagePreview> {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-pdf-'));
  const pdf = path.join(dir, 'in.pdf');
  const out = path.join(dir, 'page');
  try {
    writeFileSync(pdf, bytes);
    const rendered = await runPdftoppm(binary, pdf, out);
    if (!rendered) return { available: false, code: 'PROCESSOR_UNAVAILABLE' };
    const png = readFileSync(`${out}.png`);
    if (
      png.length < 24 ||
      !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
    ) {
      return { available: false, code: 'PROCESSOR_UNAVAILABLE' };
    }
    return {
      available: true,
      png,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPdftoppm(
  binary: string,
  pdf: string,
  out: string,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(
      binary,
      ['-png', '-f', '1', '-l', '1', '-r', '72', '-singlefile', pdf, out],
      { shell: false },
    );
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish(false);
      else reject(error);
    });
    child.on('close', (code) => finish(code === 0));
  });
}

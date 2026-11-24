import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from '../errors/error.js';
import { validOperations } from '../transform/schema.js';

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

const PDF_PAGE_LIMIT = 50;

/** Page numbers to rasterize. An empty list means every page, up to the limit. */
export function selectPdfPages(pageCount: number, pages?: number[]): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    rejectPages('This PDF has no pages.');
  }
  if (!pages || pages.length === 0) {
    if (pageCount > PDF_PAGE_LIMIT) {
      rejectPages(
        `This PDF has ${pageCount} pages. Pass pages to render at most ${PDF_PAGE_LIMIT}.`,
      );
    }
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  if (new Set(pages).size !== pages.length) {
    rejectPages('Page numbers must be unique.');
  }
  const missing = pages.find((page) => page < 1 || page > pageCount);
  if (missing !== undefined) {
    rejectPages(`Page ${missing} is outside 1..${pageCount}.`);
  }
  if (pages.length > PDF_PAGE_LIMIT) {
    rejectPages(`Render at most ${PDF_PAGE_LIMIT} pages.`);
  }
  return pages;
}

/**
 * Rasterize one PDF page with Poppler. A missing `pdftoppm` throws
 * PROCESSOR_UNAVAILABLE. The caller converts PNG bytes to jpeg or webp.
 */
export async function renderPdfPage(input: {
  pdfPath: string;
  page: number;
  dpi: number;
  timeoutMs: number;
  binary?: string;
}): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-pdf-page-'));
  const prefix = path.join(dir, 'page');
  try {
    await runPdftoppmStrict(
      input.binary ?? 'pdftoppm',
      [
        '-png',
        '-r',
        String(input.dpi),
        '-f',
        String(input.page),
        '-l',
        String(input.page),
        input.pdfPath,
        prefix,
      ],
      input.timeoutMs,
    );
    const png = readFileSync(`${prefix}-${input.page}.png`);
    if (
      png.length < 24 ||
      !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
    ) {
      throw fail('PROCESSOR_UNAVAILABLE', {
        message: 'pdftoppm did not write a PNG for that page.',
      });
    }
    return png;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rejectPages(reason: string): never {
  throw fail('TRANSFORM_REJECTED', {
    message: reason,
    context: {
      field: 'operations[0].pages',
      reason,
      detectedType: 'application/pdf',
      validOperations: validOperations('application/pdf'),
    },
  });
}

function runPdftoppmStrict(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(binary, args, { shell: false });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        fail('PROCESSOR_UNAVAILABLE', {
          message: 'pdftoppm did not finish. Lower dpi or render fewer pages.',
        }),
      );
    }, timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        finish(
          fail('PROCESSOR_UNAVAILABLE', {
            message:
              'pdftoppm was not found. Install Poppler and leave pdftoppm on PATH. PDF text extraction does not need it.',
          }),
        );
        return;
      }
      finish(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) finish();
      else {
        finish(
          fail('PROCESSOR_UNAVAILABLE', {
            message: `pdftoppm exited ${code ?? 'without a status'}. The PDF may be unsupported.`,
          }),
        );
      }
    });
  });
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

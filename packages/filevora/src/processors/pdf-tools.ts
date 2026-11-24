import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fail } from '../errors/error.js';
import { readPdf } from './normalize.js';

export interface PdfPageText {
  page: number;
  text: string;
  width: number;
  height: number;
}

export interface PdfDescription {
  metadata: {
    pageCount: number;
    title: string | null;
    author: string | null;
    producer: string | null;
  };
  pages: PdfPageText[];
}

/** Per-page text plus the document description. Uses the literal text operators. */
export async function describePdf(bytes: Uint8Array): Promise<PdfDescription> {
  const doc = await PDFDocument.load(bytes);
  const pages: PdfPageText[] = [];
  for (let index = 0; index < doc.getPageCount(); index += 1) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(doc, [index]);
    if (!page) continue;
    single.addPage(page);
    const saved = await single.save();
    const read = readPdf(saved);
    const size = doc.getPage(index).getSize();
    pages.push({
      page: index + 1,
      text: read.text,
      width: size.width,
      height: size.height,
    });
  }
  return {
    metadata: {
      pageCount: doc.getPageCount(),
      title: doc.getTitle() ?? null,
      author: doc.getAuthor() ?? null,
      producer: doc.getProducer() ?? null,
    },
    pages,
  };
}

export async function mergePdfBuffers(parts: Uint8Array[]): Promise<Buffer> {
  if (parts.length < 2) {
    throw fail('TRANSFORM_REJECTED', {
      message: 'Merge needs at least two PDF assets.',
      context: {
        field: 'assetIds',
        reason: 'Merge needs at least two PDF assets.',
        detectedType: 'application/pdf',
        validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
      },
    });
  }
  const out = await PDFDocument.create();
  for (const part of parts) {
    const doc = await PDFDocument.load(part);
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  return Buffer.from(await out.save());
}

export async function splitPdfBuffer(
  bytes: Uint8Array,
  ranges: number[][],
): Promise<Buffer[]> {
  const doc = await PDFDocument.load(bytes);
  const count = doc.getPageCount();
  if (ranges.length === 0) {
    throw fail('TRANSFORM_REJECTED', {
      message: 'Split needs at least one page range.',
      context: {
        field: 'ranges',
        reason: 'Split needs at least one page range.',
        detectedType: 'application/pdf',
        validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
      },
    });
  }
  const outputs: Buffer[] = [];
  for (const range of ranges) {
    const pages = [...new Set(range)];
    const missing = pages.find((page) => page < 1 || page > count);
    if (pages.length === 0 || missing !== undefined) {
      throw fail('TRANSFORM_REJECTED', {
        message: `Page ${missing ?? '?'} is outside 1..${count}.`,
        context: {
          field: 'ranges',
          reason: `Page ${missing ?? '?'} is outside 1..${count}.`,
          detectedType: 'application/pdf',
          validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
        },
      });
    }
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      doc,
      pages.map((page) => page - 1),
    );
    for (const page of copied) out.addPage(page);
    outputs.push(Buffer.from(await out.save()));
  }
  return outputs;
}

/**
 * Convert an Office file with LibreOffice. A missing `soffice` throws
 * PROCESSOR_UNAVAILABLE. The binary is optional.
 */
export async function convertOfficeToPdf(input: {
  sourcePath: string;
  timeoutMs: number;
  binary?: string;
}): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-office-'));
  const binary = input.binary ?? 'soffice';
  try {
    await runOffice(binary, input.sourcePath, dir, input.timeoutMs);
    const produced = path.join(
      dir,
      `${path.basename(input.sourcePath, path.extname(input.sourcePath))}.pdf`,
    );
    const pdf = readFileSync(produced);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw fail('PROCESSOR_UNAVAILABLE', {
        message: 'LibreOffice did not write a PDF.',
      });
    }
    return pdf;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOffice(
  binary: string,
  source: string,
  outDir: string,
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
    const child = spawn(
      binary,
      ['--headless', '--convert-to', 'pdf', '--outdir', outDir, source],
      { shell: false },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        fail('PROCESSOR_UNAVAILABLE', {
          message: 'LibreOffice did not finish converting the document.',
        }),
      );
    }, timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        finish(
          fail('PROCESSOR_UNAVAILABLE', {
            message:
              'soffice was not found. Install LibreOffice to convert Office files to PDF. filevora doctor reports this check. PDF tools that do not convert Office files still run.',
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
            message: `LibreOffice exited ${code ?? 'without a status'}.`,
          }),
        );
      }
    });
  });
}

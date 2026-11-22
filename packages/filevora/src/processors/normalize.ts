import { fail } from '../errors/error.js';
import type { NormalizeColumn, RowError } from '../types/index.js';

export interface PdfRead {
  text: string;
  pageCount: number;
  code?: 'OCR_NOT_CONFIGURED';
}

export interface TabularResult {
  rows: Array<Record<string, string | number | boolean | null>>;
  errors: RowError[];
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
}

/** Read text operators from a simple PDF. This is not a general PDF renderer. */
export function readPdf(bytes: Uint8Array): PdfRead {
  const source = new TextDecoder('latin1').decode(bytes);
  if (source.includes('/Encrypt')) throw fail('PDF_ENCRYPTED');
  const pageCount = source.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
  const texts = [...source.matchAll(/\(((?:\\\)|[^)])*)\)\s*Tj/g)].map(
    (match) => (match[1] ?? '').replace(/\\\)/g, ')').replace(/\\\(/g, '('),
  );
  if (texts.length === 0)
    return { text: '', pageCount, code: 'OCR_NOT_CONFIGURED' };
  return { text: texts.join('\n'), pageCount };
}

export function normalizeCsv(
  text: string,
  columns: Record<string, NormalizeColumn>,
  invalidRows: 'collect' | 'fail' = 'collect',
): TabularResult {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const header = splitCsv(lines[0] ?? '');
  const rows: TabularResult['rows'] = [];
  const errors: RowError[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsv(lines[index] ?? '');
    const record: Record<string, string | number | boolean | null> = {};
    let rejected = false;
    for (const [name, rule] of Object.entries(columns)) {
      const value = cells[header.indexOf(name)] ?? '';
      const parsed = coerce(value, rule);
      if (parsed.ok) record[name] = parsed.value;
      else {
        rejected = true;
        errors.push({
          row: index + 1,
          column: name,
          code: parsed.code,
          valuePreview: mask(value),
        });
      }
    }
    if (rejected) {
      if (invalidRows === 'fail') throw fail('SCHEMA_VALIDATION_FAILED');
    } else rows.push(record);
  }
  return {
    rows,
    errors,
    rowsRead: Math.max(0, lines.length - 1),
    rowsAccepted: rows.length,
    rowsRejected: Math.max(0, lines.length - 1 - rows.length),
  };
}

export async function normalizeXlsx(
  bytes: Uint8Array,
  columns: Record<string, NormalizeColumn>,
  sheetName?: string,
): Promise<TabularResult> {
  if (bytes.byteLength > 5_000_000) throw fail('FILE_TOO_LARGE');
  const imported = await import('exceljs');
  const excel = imported.default ?? imported;
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(bytes as never);
  const sheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];
  if (!sheet)
    throw fail('SCHEMA_VALIDATION_FAILED', {
      message: 'The worksheet was not found.',
    });
  const header: string[] = [];
  sheet.getRow(1).eachCell((cell, col) => {
    header[col - 1] = String(cell.value ?? '');
  });
  const rows: TabularResult['rows'] = [];
  const errors: RowError[] = [];
  let read = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    read += 1;
    if (read > 10_000) throw fail('FILE_TOO_LARGE');
    const record: Record<string, string | number | boolean | null> = {};
    let rejected = false;
    for (const [name, rule] of Object.entries(columns)) {
      const cell = row.getCell(header.indexOf(name) + 1);
      const raw = cellValue(cell.value);
      const parsed = coerce(raw, rule);
      if (parsed.ok) record[name] = parsed.value;
      else {
        rejected = true;
        errors.push({
          row: rowNumber,
          column: name,
          code: parsed.code,
          valuePreview: mask(raw),
        });
      }
    }
    if (!rejected) rows.push(record);
  });
  return {
    rows,
    errors,
    rowsRead: read,
    rowsAccepted: rows.length,
    rowsRejected: read - rows.length,
  };
}

function cellValue(value: unknown): string {
  if (value && typeof value === 'object' && 'formula' in value) {
    const result = (value as { result?: unknown }).result;
    return result === undefined || result === null ? '' : String(result);
  }
  if (value instanceof Date) return value.toISOString();
  return value === undefined || value === null ? '' : String(value);
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else current += char ?? '';
  }
  cells.push(current);
  return cells;
}

function coerce(
  value: string,
  rule: NormalizeColumn,
):
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; code: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    if (rule.required) return { ok: false, code: 'REQUIRED' };
    return { ok: true, value: null };
  }
  if (rule.type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
      return { ok: false, code: 'INVALID_EMAIL' };
    return { ok: true, value: trimmed };
  }
  if (rule.type === 'number') {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) return { ok: false, code: 'INVALID_NUMBER' };
    return { ok: true, value: number };
  }
  if (rule.type === 'boolean') {
    if (trimmed !== 'true' && trimmed !== 'false')
      return { ok: false, code: 'INVALID_BOOLEAN' };
    return { ok: true, value: trimmed === 'true' };
  }
  if (rule.type === 'date') {
    if (Number.isNaN(Date.parse(trimmed)))
      return { ok: false, code: 'INVALID_DATE' };
    return { ok: true, value: trimmed };
  }
  return { ok: true, value: trimmed };
}

function mask(value: string): string {
  if (!value) return '';
  return '***';
}

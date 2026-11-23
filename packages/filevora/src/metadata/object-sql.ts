import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Sql } from './sqlite.js';

type Row = Record<string, unknown>;

/**
 * Lite metadata kept as JSON objects in the storage root.
 * This is not a database file. Asset bytes stay at `{assetId}_{version}.{ext}`.
 * Cards remember only fields the bytes cannot: name, owner, checksum, and status.
 */
export function openObjectSql(root: string): Sql {
  const dir = path.join(path.resolve(root), '.filevora');
  const tables = new Map<string, Row[]>([
    ['files', []],
    ['upload_sessions', []],
    ['upload_parts', []],
    ['variants', []],
    ['audit_events', []],
    ['settings', []],
  ]);
  const load = () => {
    tables.set('files', readRows(dir, 'files'));
    tables.set('upload_sessions', readRows(dir, 'sessions'));
    tables.set('upload_parts', readRows(dir, 'parts'));
    tables.set('variants', readRows(dir, 'variants'));
  };
  const save = (table: string) => {
    const folder =
      table === 'files'
        ? 'files'
        : table === 'upload_sessions'
          ? 'sessions'
          : table === 'upload_parts'
            ? 'parts'
            : table === 'variants'
              ? 'variants'
              : '';
    if (!folder) return;
    writeRows(dir, folder, tables.get(table) ?? []);
  };
  load();
  const execute = (raw: string, params: unknown[] = []): Row[] => {
    load();
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO /i.test(sql)) {
      const table = insertRow(tables, sql, params);
      save(table);
      return [];
    }
    if (/^UPDATE /i.test(sql)) {
      const table = updateRows(tables, sql, params);
      save(table);
      return [];
    }
    if (/^DELETE FROM /i.test(sql)) {
      const table = deleteRows(tables, sql, params);
      save(table);
      return [];
    }
    if (/^SELECT /i.test(sql)) return selectRows(tables, sql, params);
    return [];
  };
  return {
    exec() {
      // Lite mode has no schema migrations.
    },
    get<T>(sql: string, params?: unknown[]) {
      return execute(sql, params)[0] as T | undefined;
    },
    all<T>(sql: string, params?: unknown[]) {
      return execute(sql, params) as T[];
    },
    run(sql: string, params?: unknown[]) {
      execute(sql, params);
    },
    transaction<T>(fn: () => T) {
      return fn();
    },
    close() {
      // Objects are flushed on each write.
    },
  };
}

function readRows(dir: string, folder: string): Row[] {
  const target = path.join(dir, folder);
  try {
    return readdirSync(target)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const parsed = JSON.parse(
          readFileSync(path.join(target, name), 'utf8'),
        ) as Row | Row[] | null;
        if (parsed == null) return [];
        return Array.isArray(parsed) ? parsed : [parsed];
      });
  } catch {
    return [];
  }
}

function writeRows(dir: string, folder: string, rows: Row[]): void {
  const target = path.join(dir, folder);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(
      row.id ?? row.upload_session_id ?? row.file_id ?? row.key ?? 'row',
    );
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const keep = new Set<string>();
  for (const [key, list] of groups) {
    const name = `${safeName(key)}.json`;
    keep.add(name);
    const body = folder === 'files' || folder === 'sessions' ? list[0] : list;
    writeFileSync(path.join(target, name), JSON.stringify(body), {
      mode: 0o600,
    });
  }
  for (const name of readdirSync(target)) {
    if (name.endsWith('.json') && !keep.has(name)) {
      writeFileSync(path.join(target, name), 'null');
    }
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function insertRow(
  tables: Map<string, Row[]>,
  sql: string,
  params: unknown[],
): string {
  const match = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \((.+)\)$/i.exec(sql);
  if (!match?.[1] || !match[2] || !match[3]) return '';
  const table = match[1];
  const columns = match[2].split(',').map((column) => column.trim());
  const values = parseValueList(match[3], params);
  const row: Row = {};
  columns.forEach((column, index) => {
    row[column] = values[index] ?? null;
  });
  const rows = tables.get(table) ?? [];
  if (table === 'variants') {
    const clash = rows.find(
      (item) =>
        item.file_id === row.file_id &&
        item.name === row.name &&
        item.recipe_id === row.recipe_id &&
        item.recipe_version === row.recipe_version,
    );
    if (clash) return table;
  }
  rows.push(row);
  tables.set(table, rows);
  return table;
}

function updateRows(
  tables: Map<string, Row[]>,
  sql: string,
  params: unknown[],
): string {
  const match = /^UPDATE (\w+) SET (.+) WHERE (.+)$/i.exec(sql);
  if (!match?.[1] || !match[2] || !match[3]) return '';
  const table = match[1];
  const rows = tables.get(table) ?? [];
  const assignments = splitTop(match[2], ',');
  const compiled = assignments.map((assignment) => {
    const eq = assignment.indexOf('=');
    const column = assignment.slice(0, eq).trim();
    const expr = assignment.slice(eq + 1).trim();
    return { column, expr };
  });
  for (const row of rows) {
    let used = 0;
    const setValues = compiled.map((item) => {
      const value = evalExpr(item.expr, params, used, row);
      used += value.used;
      return value;
    });
    const where = evalWhere(match[3], params, used, row);
    if (!where.ok) continue;
    compiled.forEach((item, index) => {
      row[item.column] = setValues[index]?.value ?? null;
    });
  }
  tables.set(table, rows);
  return table;
}

function deleteRows(
  tables: Map<string, Row[]>,
  sql: string,
  params: unknown[],
): string {
  const match = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(sql);
  if (!match?.[1] || !match[2]) return '';
  const table = match[1];
  const rows = tables.get(table) ?? [];
  tables.set(
    table,
    rows.filter((row) => !evalWhere(match[2] ?? '', params, 0, row).ok),
  );
  return table;
}

function selectRows(
  tables: Map<string, Row[]>,
  sql: string,
  params: unknown[],
): Row[] {
  const sum =
    /^SELECT COALESCE\(SUM\((\w+)\), 0\) AS (\w+) FROM (\w+)(?: WHERE (.+))?$/i.exec(
      sql,
    );
  if (sum?.[1] && sum[2] && sum[3]) {
    const rows = filterRows(tables.get(sum[3]) ?? [], sum[4], params);
    const total = rows.reduce(
      (acc, row) => acc + Number(row[sum[1] ?? ''] ?? 0),
      0,
    );
    return [{ [sum[2]]: total }];
  }
  let text = sql;
  let limit: number | undefined;
  if (/ LIMIT \?$/i.test(text)) {
    limit = Number(params[params.length - 1] ?? 0);
    text = text.replace(/ LIMIT \?$/i, '');
  }
  let orderBy = '';
  const orderMatch = / ORDER BY (.+)$/i.exec(text);
  if (orderMatch?.[1]) {
    orderBy = orderMatch[1];
    text = text.slice(0, orderMatch.index);
  }
  const select = /^SELECT (.+) FROM (\w+)(?: WHERE (.+))?$/i.exec(text.trim());
  if (!select?.[2]) return [];
  let rows = filterRows(tables.get(select[2]) ?? [], select[3], params);
  if (orderBy) {
    const orders = orderBy.split(',').map((part) => {
      const [column, direction] = part.trim().split(/\s+/);
      return {
        column: column ?? '',
        desc: direction?.toLowerCase() === 'desc',
      };
    });
    rows = [...rows].sort((left, right) => {
      for (const order of orders) {
        const a = String(left[order.column] ?? '');
        const b = String(right[order.column] ?? '');
        if (a === b) continue;
        return order.desc ? (a < b ? 1 : -1) : a < b ? -1 : 1;
      }
      return 0;
    });
  }
  if (limit !== undefined) rows = rows.slice(0, limit);
  if (select[1] && select[1] !== '*') {
    const columns = select[1].split(',').map((column) => column.trim());
    return rows.map((row) => {
      const picked: Row = {};
      for (const column of columns) {
        const alias = column.split(/\s+AS\s+/i);
        const source = alias[0]?.trim() ?? column;
        const name = alias[1]?.trim() ?? source;
        picked[name] = row[source];
      }
      return picked;
    });
  }
  return rows;
}

function filterRows(
  rows: Row[],
  where: string | undefined,
  params: unknown[],
): Row[] {
  if (!where) return rows;
  return rows.filter((row) => evalWhere(where, params, 0, row).ok);
}

function evalWhere(
  where: string,
  params: unknown[],
  start: number,
  row: Row,
): { ok: boolean; used: number } {
  const orParts = splitTop(where, ' OR ');
  if (orParts.length > 1) {
    let used = 0;
    let ok = false;
    for (const part of orParts) {
      const result = evalWhere(
        part.replace(/^\(|\)$/g, ''),
        params,
        start + used,
        row,
      );
      used += result.used;
      ok = ok || result.ok;
    }
    return { ok, used };
  }
  const andParts = splitTop(stripParens(where), ' AND ');
  let used = 0;
  for (const part of andParts) {
    const term = part.trim();
    if (term.startsWith('(')) {
      const nested = evalWhere(term, params, start + used, row);
      used += nested.used;
      if (!nested.ok) return { ok: false, used };
      continue;
    }
    const isNull = /^(\w+) IS NULL$/i.exec(term);
    if (isNull?.[1]) {
      if (row[isNull[1]] != null) return { ok: false, used };
      continue;
    }
    const notNull = /^(\w+) IS NOT NULL$/i.exec(term);
    if (notNull?.[1]) {
      if (row[notNull[1]] == null) return { ok: false, used };
      continue;
    }
    const cmp = /^(\w+)\s*(=|<|>)\s*\?$/i.exec(term);
    if (cmp?.[1] && cmp[2]) {
      const expected = params[start + used];
      used += 1;
      const actual = row[cmp[1]];
      const pass =
        cmp[2] === '='
          ? actual === expected
          : cmp[2] === '<'
            ? String(actual) < String(expected)
            : String(actual) > String(expected);
      if (!pass) return { ok: false, used };
      continue;
    }
  }
  return { ok: true, used };
}

function evalExpr(
  expr: string,
  params: unknown[],
  start: number,
  row: Row,
): { value: unknown; used: number } {
  if (expr === '?') return { value: params[start], used: 1 };
  if (/^NULL$/i.test(expr)) return { value: null, used: 0 };
  const literal = /^'([^']*)'$/.exec(expr);
  if (literal) return { value: literal[1], used: 0 };
  if (/^\d+$/.test(expr)) return { value: Number(expr), used: 0 };
  const coalesce = /^COALESCE\((\w+), \?\)$/i.exec(expr);
  if (coalesce?.[1]) {
    const current = row[coalesce[1]];
    return { value: current ?? params[start], used: 1 };
  }
  const cleared = /^CASE WHEN \? THEN NULL ELSE (\w+) END$/i.exec(expr);
  if (cleared?.[1]) {
    return {
      value: params[start] ? null : row[cleared[1]],
      used: 1,
    };
  }
  const swapped = /^CASE WHEN \? THEN '([^']*)' ELSE (\w+) END$/i.exec(expr);
  if (swapped?.[1] && swapped[2]) {
    return {
      value: params[start] ? swapped[1] : row[swapped[2]],
      used: 1,
    };
  }
  if (/^\w+$/.test(expr)) return { value: row[expr], used: 0 };
  return { value: null, used: 0 };
}

function parseValueList(input: string, params: unknown[]): unknown[] {
  const parts = splitTop(input, ',');
  let used = 0;
  return parts.map((part) => {
    const value = evalExpr(part.trim(), params, used, {});
    used += value.used;
    return value.value;
  });
}

function splitTop(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "'") quote = !quote;
    if (quote) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && input.startsWith(separator, index)) {
      parts.push(input.slice(start, index).trim());
      index += separator.length - 1;
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function stripParens(value: string): string {
  let text = value.trim();
  while (text.startsWith('(') && text.endsWith(')'))
    text = text.slice(1, -1).trim();
  return text;
}

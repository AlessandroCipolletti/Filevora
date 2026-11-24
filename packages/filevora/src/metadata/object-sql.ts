import { readAll } from '../storage/stage.js';
import type { StorageDriver } from '../types/index.js';
import type { Sql } from './sqlite.js';

type Row = Record<string, unknown>;

const FOLDERS: Record<string, string> = {
  files: 'files',
  upload_sessions: 'sessions',
  upload_parts: 'parts',
  variants: 'variants',
};

/**
 * Lite metadata kept as JSON objects next to the bytes.
 * Filesystem cards stay at `{root}/.filevora/`. S3 cards use the same keys in the bucket.
 * A missing card is private. This is not a database file and not Redis.
 */
export async function openObjectSql(storage: StorageDriver): Promise<Sql> {
  const tables = new Map<string, Row[]>([
    ['files', []],
    ['upload_sessions', []],
    ['upload_parts', []],
    ['variants', []],
    ['audit_events', []],
    ['settings', []],
  ]);
  let generation = '';
  let latch = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = latch.then(fn, fn);
    latch = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readText = async (key: string): Promise<string> => {
    const head = await storage.headObject(key);
    if (!head) return '';
    const bytes = await readAll(await storage.getObject(key));
    return Buffer.from(bytes).toString('utf8');
  };
  const refresh = async (): Promise<void> => {
    const gen = (await readText('.filevora/generation')) || '0';
    if (generation !== '' && gen === generation) return;
    for (const [table, folder] of Object.entries(FOLDERS)) {
      const prefix = `.filevora/${folder}/`;
      const listed = await storage.list(prefix);
      const rows: Row[] = [];
      for (const item of listed) {
        if (!item.key.endsWith('.json')) continue;
        const text = await readText(item.key);
        if (!text || text === 'null') continue;
        const parsed = JSON.parse(text) as Row | Row[] | null;
        if (parsed == null) continue;
        if (Array.isArray(parsed)) rows.push(...parsed);
        else rows.push(parsed);
      }
      tables.set(table, rows);
    }
    generation = gen;
  };
  const persist = async (table: string): Promise<void> => {
    const folder = FOLDERS[table];
    if (!folder) return;
    const prefix = `.filevora/${folder}/`;
    const groups = new Map<string, Row[]>();
    for (const row of tables.get(table) ?? []) {
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
      await storage.putObject({
        key: `${prefix}${name}`,
        body: Buffer.from(JSON.stringify(body)),
        contentType: 'application/json',
      });
    }
    for (const item of await storage.list(prefix)) {
      const name = item.key.slice(prefix.length);
      if (name.endsWith('.json') && !name.includes('/') && !keep.has(name)) {
        await storage.deleteObject(item.key);
      }
    }
    generation = String(Number(generation || '0') + 1);
    await storage.putObject({
      key: '.filevora/generation',
      body: Buffer.from(generation),
      contentType: 'text/plain',
    });
  };
  const execute = (raw: string, params: unknown[] = []): Promise<Row[]> =>
    exclusive(async () => {
      await refresh();
      const sql = raw.replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO /i.test(sql)) {
        const table = insertRow(tables, sql, params);
        await persist(table);
        return [];
      }
      if (/^UPDATE /i.test(sql)) {
        const table = updateRows(tables, sql, params);
        await persist(table);
        return [];
      }
      if (/^DELETE FROM /i.test(sql)) {
        const table = deleteRows(tables, sql, params);
        await persist(table);
        return [];
      }
      if (/^SELECT /i.test(sql)) return selectRows(tables, sql, params);
      return [];
    });
  await exclusive(refresh);
  return {
    async exec() {
      // Lite mode has no schema migrations.
    },
    async get<T>(sql: string, params?: unknown[]) {
      return (await execute(sql, params))[0] as T | undefined;
    },
    async all<T>(sql: string, params?: unknown[]) {
      return (await execute(sql, params)) as T[];
    },
    async run(sql: string, params?: unknown[]) {
      await execute(sql, params);
    },
    async transaction<T>(fn: () => Promise<T>) {
      return fn();
    },
    async close() {
      await storage.close?.();
    },
  };
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

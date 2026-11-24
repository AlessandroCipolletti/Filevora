import type { Sql } from './sqlite.js';

type Row = Record<string, unknown>;

/** One MySQL or MariaDB connection. Queries are serialized so a transaction stays on it. */
export async function openMysql(url: string): Promise<Sql> {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection(
    url.replace(/^mariadb:/i, 'mysql:'),
  );
  let chain: Promise<unknown> = Promise.resolve();
  let inTx = false;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    if (inTx) return fn();
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const query = async (statement: string, params: unknown[] = []) => {
    const [rows] = await connection.query(statement, params);
    if (!Array.isArray(rows)) return [];
    return rows.map((entry) => normalize(entry as Row));
  };
  return {
    async exec(statement) {
      const parts = splitStatements(statement);
      await enqueue(async () => {
        for (const part of parts) await connection.query(part);
      });
    },
    async get<T>(statement: string, params: unknown[] = []) {
      const rows = await enqueue(() => query(statement, params));
      return rows[0] as T | undefined;
    },
    async all<T>(statement: string, params: unknown[] = []) {
      return (await enqueue(() => query(statement, params))) as T[];
    },
    async run(statement: string, params: unknown[] = []) {
      await enqueue(() => query(statement, params));
    },
    async transaction<T>(fn: () => Promise<T>) {
      return enqueue(async () => {
        inTx = true;
        try {
          await connection.query('BEGIN');
          const result = await fn();
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch {
            // The original error is the one the caller needs.
          }
          throw error;
        } finally {
          inTx = false;
        }
      });
    },
    async close() {
      await connection.end();
    },
  };
}

function normalize(row: Row): Row {
  const output: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') output[key] = Number(value);
    else if (value instanceof Date) output[key] = value.toISOString();
    else output[key] = value;
  }
  return output;
}

function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let quote = false;
  let start = 0;
  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor];
    if (char === "'") {
      if (quote && sql[cursor + 1] === "'") {
        cursor += 1;
        continue;
      }
      quote = !quote;
    }
    if (char === ';' && !quote) {
      const statement = sql.slice(start, cursor).trim();
      if (statement) parts.push(statement);
      start = cursor + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

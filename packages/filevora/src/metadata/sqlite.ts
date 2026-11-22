import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Sql {
  exec(sql: string): void;
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function row<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    output[key] = normalize(entry);
  return output as T;
}

/** Open a SQLite file with WAL and a busy timeout. Creates the parent directory. */
export function openSqlite(filename: string): Sql {
  const resolved = path.resolve(filename);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    exec(sql) {
      db.exec(sql);
    },
    get<T>(sql: string, params: unknown[] = []) {
      return row(db.prepare(sql).get(...(params as never[]))) as T | undefined;
    },
    all<T>(sql: string, params: unknown[] = []) {
      return db
        .prepare(sql)
        .all(...(params as never[]))
        .map((entry) => row(entry))
        .filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        ) as T[];
    },
    run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original error is the one the caller needs.
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

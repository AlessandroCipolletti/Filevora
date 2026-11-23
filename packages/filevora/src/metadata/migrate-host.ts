import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { migrate } from './migrate.js';
import { applyPostgresSchema } from './postgres.js';
import { openSqlite } from './sqlite.js';

/** Apply `filevora_assets` on the host database. Lite mode has nothing to migrate. */
export async function migrateHost(config: ResolvedConfig): Promise<void> {
  if (config.metadata.mode !== 'stored') {
    throw fail('FEATURE_REQUIRES_STORED_MODE', {
      message: 'filevora migrate requires stored metadata mode.',
      context: { mode: config.metadata.mode },
    });
  }
  if (config.metadata.driver === 'postgres') {
    if (!config.metadata.url) {
      throw fail('INVALID_CONFIG', {
        message: 'Postgres migrate needs FILEVORA_DATABASE_URL.',
      });
    }
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: config.metadata.url });
    try {
      await applyPostgresSchema({
        query: async <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) => {
          const result = await pool.query(sql, params);
          return { rows: result.rows as T[] };
        },
        exec: async (sql: string) => {
          await pool.query(sql);
        },
      });
    } finally {
      await pool.end();
    }
    return;
  }
  if (!config.metadata.filename) {
    throw fail('INVALID_CONFIG', {
      message:
        'Stored migrate needs FILEVORA_DATABASE_URL or FILES_SQLITE_PATH.',
    });
  }
  const sql = openSqlite(config.metadata.filename);
  try {
    migrate(sql);
  } finally {
    sql.close();
  }
}

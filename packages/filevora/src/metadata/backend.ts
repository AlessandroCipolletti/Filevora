import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { hostSql } from './host-sql.js';
import { migrate } from './migrate.js';
import { openMysql } from './mysql-sql.js';
import { openObjectSql } from './object-sql.js';
import { openStorage } from '../storage/stage.js';
import { openPostgres } from './postgres-sql.js';
import { openSqlite, type Sql } from './sqlite.js';

/** Open lite object cards or the host database. Does not create a default SQLite file. */
export async function openBackend(config: ResolvedConfig): Promise<Sql> {
  if (config.metadata.mode === 'lite')
    return openObjectSql(await openStorage(config.storage));
  if (!config.metadata.url && !config.metadata.filename) {
    throw fail('INVALID_CONFIG', {
      message:
        'Stored mode needs FILEVORA_DATABASE_URL for a PostgreSQL, MySQL/MariaDB, or SQLite database the host already runs.',
    });
  }
  const sql =
    config.metadata.driver === 'postgres'
      ? await openPostgres(config.metadata.url ?? '', config.metadata.schema)
      : config.metadata.driver === 'mysql'
        ? await openMysql(config.metadata.url ?? '')
        : openSqlite(config.metadata.filename);
  if (config.metadata.autoMigrate !== false) {
    try {
      await migrate(sql, config.metadata.driver);
    } catch (error) {
      await sql.close();
      throw error;
    }
  }
  return hostSql(sql);
}

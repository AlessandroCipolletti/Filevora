import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { migrate } from './migrate.js';
import { openObjectSql } from './object-sql.js';
import { openSqlite, type Sql } from './sqlite.js';

/** Open lite object cards or the host database. Does not create a default SQLite file. */
export function openBackend(config: ResolvedConfig): Sql {
  if (config.metadata.mode === 'lite')
    return openObjectSql(config.storage.root);
  if (config.metadata.driver === 'postgres') {
    throw fail('INVALID_CONFIG', {
      message:
        'Postgres stored mode is applied with `npx filevora migrate`. Point FILEVORA_DATABASE_URL at a host SQLite file for the in-process service, or run migrate against Postgres.',
    });
  }
  if (!config.metadata.filename) {
    throw fail('INVALID_CONFIG', {
      message:
        'Stored mode needs FILEVORA_DATABASE_URL or FILES_SQLITE_PATH. Lite mode does not use a database file.',
    });
  }
  const sql = openSqlite(config.metadata.filename);
  migrate(sql);
  return rewriteAssetTables(sql);
}

/** Existing statements say `files` and `variants`. The host tables use the filevora_ names. */
function rewriteAssetTables(sql: Sql): Sql {
  const rewrite = (statement: string) =>
    statement
      .replace(/\bfiles\b/g, 'filevora_assets')
      .replace(/\bvariants\b/g, 'filevora_asset_versions');
  return {
    exec(statement) {
      sql.exec(rewrite(statement));
    },
    get(statement, params) {
      return sql.get(rewrite(statement), params);
    },
    all(statement, params) {
      return sql.all(rewrite(statement), params);
    },
    run(statement, params) {
      sql.run(rewrite(statement), params);
    },
    transaction(fn) {
      return sql.transaction(fn);
    },
    close() {
      sql.close();
    },
  };
}

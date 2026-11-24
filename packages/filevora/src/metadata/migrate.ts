import { hostStatements, type HostDialect } from './host-schema.js';
import type { Sql } from './sqlite.js';

/** Create filevora_assets and filevora_asset_versions. Does not touch any other table. */
export async function migrate(
  db: Sql,
  dialect: HostDialect = 'sqlite',
): Promise<void> {
  for (const statement of [
    ...hostStatements(dialect),
    'ALTER TABLE filevora_assets ADD COLUMN last_accessed_at TEXT',
  ]) {
    try {
      await db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/duplicate|already exists/i.test(message)) continue;
      throw error;
    }
  }
}

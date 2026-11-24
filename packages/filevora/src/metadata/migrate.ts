import {
  hostStatements,
  postMigrateStatements,
  type HostDialect,
} from './host-schema.js';
import type { Sql } from './sqlite.js';

/** Create filevora_assets and filevora_asset_versions. Does not touch any other table. */
export async function migrate(
  db: Sql,
  dialect: HostDialect = 'sqlite',
): Promise<void> {
  for (const statement of [
    ...hostStatements(dialect),
    'ALTER TABLE filevora_assets ADD COLUMN last_accessed_at TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN url_salt TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN description_long TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN description_short TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN description_status TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN description_error TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN described_at TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN description_model TEXT',
    'ALTER TABLE filevora_assets ADD COLUMN describe_requested INTEGER DEFAULT 0',
    ...postMigrateStatements(dialect),
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

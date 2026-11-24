export type HostDialect = 'sqlite' | 'postgres' | 'mysql';

/**
 * The only tables Filevora creates on a host database.
 * Upload session fields live on the asset row so no other tables are touched.
 */
export function hostStatements(dialect: HostDialect): string[] {
  const id = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
  const label = dialect === 'mysql' ? 'VARCHAR(191)' : 'TEXT';
  const key = dialect === 'mysql' ? 'VARCHAR(255)' : 'TEXT';
  const blob = 'TEXT';
  const int = 'INTEGER';
  const assets = `
CREATE TABLE IF NOT EXISTS filevora_assets (
  id ${id} PRIMARY KEY,
  tenant_id ${label} NOT NULL,
  owner_id ${label} NOT NULL,
  original_name ${blob} NOT NULL,
  declared_mime ${blob} NOT NULL DEFAULT 'application/octet-stream',
  detected_mime ${blob},
  bytes ${int} NOT NULL DEFAULT 0,
  checksum ${blob},
  original_object_key ${blob},
  visibility ${blob} NOT NULL DEFAULT 'private',
  upload_state ${blob} NOT NULL,
  processing_state ${blob} NOT NULL,
  preset ${blob},
  metadata_json ${blob} NOT NULL DEFAULT '{}',
  pinned ${int} NOT NULL DEFAULT 0,
  created_at ${blob} NOT NULL DEFAULT '',
  updated_at ${blob} NOT NULL DEFAULT '',
  deleted_at ${blob},
  grace_until ${blob},
  last_touch_at ${blob},
  session_id ${id},
  session_status ${blob},
  transport ${blob},
  part_size ${int},
  declared_bytes ${int},
  part_count ${int},
  expires_at ${blob},
  idempotency_key ${key},
  session_owner_id ${label},
  storage_upload_id ${blob},
  session_object_key ${blob},
  session_checksum ${blob},
  session_metadata_json ${blob},
  session_created_at ${blob},
  parts_json ${blob}
)`.trim();
  const versions = `
CREATE TABLE IF NOT EXISTS filevora_asset_versions (
  id ${id} PRIMARY KEY,
  file_id ${id} NOT NULL,
  name ${key} NOT NULL,
  recipe_id ${key} NOT NULL,
  recipe_version ${int} NOT NULL,
  storage_key ${blob} NOT NULL,
  mime ${blob} NOT NULL,
  bytes ${int} NOT NULL,
  width ${int},
  height ${int},
  duration_ms ${int},
  checksum ${blob} NOT NULL,
  status ${blob} NOT NULL,
  created_at ${blob} NOT NULL DEFAULT ''
)`.trim();
  const index = (statement: string) =>
    dialect === 'mysql'
      ? statement.replace(/ INDEX IF NOT EXISTS /g, ' INDEX ')
      : statement;
  return [
    assets,
    versions,
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_tenant_created ON filevora_assets (tenant_id, created_at(64), id)'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_tenant_created ON filevora_assets (tenant_id, created_at, id)',
    ),
    index(
      'CREATE UNIQUE INDEX IF NOT EXISTS filevora_assets_session ON filevora_assets (session_id)',
    ),
    index(
      'CREATE UNIQUE INDEX IF NOT EXISTS filevora_assets_idem ON filevora_assets (tenant_id, idempotency_key)',
    ),
    index(
      'CREATE UNIQUE INDEX IF NOT EXISTS filevora_asset_versions_recipe ON filevora_asset_versions (file_id, name, recipe_id, recipe_version)',
    ),
  ];
}

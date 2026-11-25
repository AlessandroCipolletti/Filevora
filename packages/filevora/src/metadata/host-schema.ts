export type HostDialect = 'sqlite' | 'postgres' | 'mysql';

/** Indexes that depend on columns added to databases created before descriptions. */
export function postMigrateStatements(dialect: HostDialect): string[] {
  return [
    dialect === 'mysql'
      ? 'CREATE INDEX filevora_assets_description_status ON filevora_assets (description_status(32))'
      : 'CREATE INDEX IF NOT EXISTS filevora_assets_description_status ON filevora_assets (description_status)',
  ];
}

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
  last_accessed_at ${blob},
  url_salt ${blob},
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
  parts_json ${blob},
  description_long ${blob},
  description_short ${blob},
  description_status ${blob},
  description_error ${blob},
  described_at ${blob},
  description_model ${blob},
  describe_requested ${int} NOT NULL DEFAULT 0
)`.trim();
  const tags = `
CREATE TABLE IF NOT EXISTS filevora_asset_tags (
  asset_id ${id} NOT NULL,
  tag ${label} NOT NULL,
  category ${label} NOT NULL,
  PRIMARY KEY (asset_id, category, tag)
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
  const vector = dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  const short = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
  const embeddings = `
CREATE TABLE IF NOT EXISTS filevora_asset_embeddings (
  asset_id ${id} PRIMARY KEY,
  tenant_id ${label} NOT NULL,
  model ${label} NOT NULL,
  dimensions ${int} NOT NULL,
  embedding ${vector} NOT NULL,
  source ${label} NOT NULL,
  content_hash ${short} NOT NULL,
  embedded_at ${short} NOT NULL
)`.trim();
  const table = (statement: string) =>
    dialect === 'mysql'
      ? statement.replace(/DEFAULT '([^']*)'/g, "DEFAULT ('$1')")
      : statement;
  const index = (statement: string) =>
    dialect === 'mysql'
      ? statement.replace(/ INDEX IF NOT EXISTS /g, ' INDEX ')
      : statement;
  return [
    table(assets),
    table(versions),
    table(tags),
    table(embeddings),
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
    index(
      'CREATE INDEX IF NOT EXISTS filevora_asset_tags_tag ON filevora_asset_tags (tag)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_tenant_updated ON filevora_assets (tenant_id, updated_at(64), id)'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_tenant_updated ON filevora_assets (tenant_id, updated_at, id)',
    ),
    index(
      'CREATE INDEX IF NOT EXISTS filevora_assets_tenant_bytes ON filevora_assets (tenant_id, bytes)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_tenant_name ON filevora_assets (tenant_id, original_name(191))'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_tenant_name ON filevora_assets (tenant_id, original_name)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_processing ON filevora_assets (tenant_id, processing_state(32))'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_processing ON filevora_assets (tenant_id, processing_state)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_mime ON filevora_assets (tenant_id, detected_mime(64))'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_mime ON filevora_assets (tenant_id, detected_mime)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_assets_visibility ON filevora_assets (tenant_id, visibility(16))'
        : 'CREATE INDEX IF NOT EXISTS filevora_assets_visibility ON filevora_assets (tenant_id, visibility)',
    ),
    index(
      'CREATE INDEX IF NOT EXISTS filevora_asset_tags_category ON filevora_asset_tags (category, tag)',
    ),
    index(
      'CREATE INDEX IF NOT EXISTS filevora_asset_embeddings_scope ON filevora_asset_embeddings (tenant_id, model, dimensions, asset_id)',
    ),
    index(
      dialect === 'mysql'
        ? 'CREATE INDEX filevora_asset_versions_file ON filevora_asset_versions (file_id, status(32))'
        : 'CREATE INDEX IF NOT EXISTS filevora_asset_versions_file ON filevora_asset_versions (file_id, status)',
    ),
  ];
}

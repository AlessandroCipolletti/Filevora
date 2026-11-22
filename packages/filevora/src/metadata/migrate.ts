import type { Sql } from './sqlite.js';

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  declared_mime TEXT NOT NULL,
  detected_mime TEXT,
  bytes INTEGER NOT NULL,
  checksum TEXT,
  original_object_key TEXT,
  visibility TEXT NOT NULL,
  upload_state TEXT NOT NULL,
  processing_state TEXT NOT NULL,
  preset TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS files_tenant_created ON files (tenant_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  transport TEXT NOT NULL,
  part_size INTEGER NOT NULL,
  declared_bytes INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  idempotency_key TEXT,
  declared_mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  preset TEXT,
  metadata_json TEXT NOT NULL,
  checksum TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_idempotency
  ON upload_sessions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  checksum TEXT,
  bytes INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (upload_session_id, part_number)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  file_id TEXT,
  action TEXT NOT NULL,
  actor_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  idempotency_key TEXT,
  error_code TEXT,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency
  ON jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (state, run_after);
CREATE TABLE IF NOT EXISTS supervisor_leases (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pid INTEGER NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS variants_recipe
  ON variants (file_id, name, recipe_id, recipe_version);
`;

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  { id: 1, sql: MIGRATION_1 },
  { id: 2, sql: MIGRATION_2 },
  { id: 3, sql: MIGRATION_3 },
];

export function migrate(db: Sql): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  for (const migration of MIGRATIONS) {
    const existing = db.get<{ id: number }>(
      'SELECT id FROM schema_migrations WHERE id = ?',
      [migration.id],
    );
    if (existing) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        new Date().toISOString(),
      ]);
    });
  }
}

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

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  { id: 1, sql: MIGRATION_1 },
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

export interface ResultRow {
  [key: string]: unknown;
}

export interface PostgresQueryable {
  query<T extends ResultRow = ResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

/** Turn `?` placeholders into `$1` style for Postgres. */
export function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  detected_mime TEXT,
  bytes INTEGER NOT NULL,
  checksum TEXT,
  original_object_key TEXT,
  upload_state TEXT NOT NULL,
  processing_state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
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
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS variants_recipe ON variants (file_id, name, recipe_id, recipe_version);
`;

export async function applyPostgresSchema(
  db: PostgresQueryable,
): Promise<void> {
  if (db.exec) await db.exec(SCHEMA);
  else await db.query(SCHEMA);
}

export async function enqueueJob(
  db: PostgresQueryable,
  input: {
    id: string;
    fileId: string;
    tenantId: string;
    idempotencyKey: string;
    now: string;
  },
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    toPostgres(
      'SELECT id FROM jobs WHERE tenant_id = ? AND idempotency_key = ?',
    ),
    [input.tenantId, input.idempotencyKey],
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;
  await db.query(
    toPostgres(
      `INSERT INTO jobs (id, file_id, tenant_id, type, payload_json, schema_version, state, attempts, max_attempts, run_after, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'preset', '{}', 1, 'queued', 0, 5, ?, ?, ?, ?)`,
    ),
    [
      input.id,
      input.fileId,
      input.tenantId,
      input.now,
      input.idempotencyKey,
      input.now,
      input.now,
    ],
  );
  return input.id;
}

export async function claimJob(
  db: PostgresQueryable,
  owner: string,
  now: string,
  leaseUntil: string,
): Promise<string | undefined> {
  const claimed = await db.query<{ id: string }>(
    `UPDATE jobs SET state = 'processing', lease_owner = $1, lease_until = $2, attempts = attempts + 1, updated_at = $3
     WHERE id = (
       SELECT id FROM jobs
       WHERE state IN ('queued', 'retrying') OR (state = 'processing' AND (lease_until IS NULL OR lease_until <= $3))
       ORDER BY run_after ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id`,
    [owner, leaseUntil, now],
  );
  return claimed.rows[0]?.id;
}

export async function publishVariantOnce(
  db: PostgresQueryable,
  input: {
    id: string;
    fileId: string;
    name: string;
    storageKey: string;
    checksum: string;
  },
): Promise<'created' | 'exists'> {
  const existing = await db.query(
    toPostgres(
      'SELECT id FROM variants WHERE file_id = ? AND name = ? AND recipe_id = ? AND recipe_version = 1',
    ),
    [input.fileId, input.name, 'web-optimized'],
  );
  if (existing.rows[0]) return 'exists';
  try {
    await db.query(
      toPostgres(
        `INSERT INTO variants (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status)
         VALUES (?, ?, ?, 'web-optimized', 1, ?, 'image/webp', 1, ?, 'ready')`,
      ),
      [input.id, input.fileId, input.name, input.storageKey, input.checksum],
    );
    return 'created';
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    )
      return 'exists';
    throw error;
  }
}

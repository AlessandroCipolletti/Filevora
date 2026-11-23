interface ResultRow {
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
function toPostgres(sql: string): string {
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
  progress_ratio DOUBLE PRECISION,
  eta_ms INTEGER,
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
  const statements = SCHEMA.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    if (db.exec) await db.exec(statement);
    else await db.query(statement);
  }
}

/** Networked S3 and Postgres tests run only when these variables are set. */
export function externalTargets(env: NodeJS.ProcessEnv): {
  s3: boolean;
  postgres: boolean;
} {
  return {
    s3: Boolean(
      env.FILEVORA_S3_ENDPOINT &&
      env.FILEVORA_S3_BUCKET &&
      env.FILEVORA_S3_ACCESS_KEY_ID &&
      env.FILEVORA_S3_SECRET_ACCESS_KEY,
    ),
    postgres: Boolean(env.FILEVORA_POSTGRES_URL),
  };
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

import { hostStatements } from './host-schema.js';

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

export async function applyPostgresSchema(
  db: PostgresQueryable,
): Promise<void> {
  for (const statement of hostStatements('postgres')) {
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
      'SELECT id FROM filevora_asset_versions WHERE file_id = ? AND name = ? AND recipe_id = ? AND recipe_version = 1',
    ),
    [input.fileId, input.name, 'web-optimized'],
  );
  if (existing.rows[0]) return 'exists';
  try {
    await db.query(
      toPostgres(
        `INSERT INTO filevora_asset_versions (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status)
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

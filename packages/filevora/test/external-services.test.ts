import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  applyPostgresSchema,
  externalTargets,
} from '../dist/metadata/postgres.js';
import { createS3Storage } from '../dist/storage/s3.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

test('external service gate stays closed without endpoints', () => {
  assert.deepEqual(externalTargets({}), { s3: false, postgres: false });
  assert.equal(
    externalTargets({
      FILEVORA_S3_ENDPOINT: 'http://127.0.0.1:9000',
      FILEVORA_S3_BUCKET: 'uploads',
      FILEVORA_S3_ACCESS_KEY_ID: 'local',
      FILEVORA_S3_SECRET_ACCESS_KEY: 'localpassword',
    }).s3,
    true,
  );
  assert.equal(
    externalTargets({ FILEVORA_POSTGRES_URL: 'postgres://localhost/db' })
      .postgres,
    true,
  );
});

test('GitHub Actions runs verify against Postgres and MinIO when the workflow is used', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/ci.yml'),
    'utf8',
  );
  assert.match(workflow, /pnpm run verify/);
  assert.match(workflow, /poppler-utils/);
  assert.match(workflow, /FILEVORA_POSTGRES_URL/);
  assert.match(workflow, /FILEVORA_S3_ENDPOINT/);
  assert.match(workflow, /postgres:16/);
  assert.match(workflow, /pgsty\/silo:RELEASE\.2026-11-12T00-00-00Z/);
});

test('networked S3 put and read', async (t) => {
  const env = process.env;
  if (!externalTargets(env).s3) {
    t.skip(
      'FILEVORA_S3_ENDPOINT is not set; MinIO was not started on this machine',
    );
    return;
  }
  const client = new S3Client({
    region: env.FILEVORA_S3_REGION ?? 'us-east-1',
    endpoint: env.FILEVORA_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.FILEVORA_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.FILEVORA_S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  try {
    await client.send(
      new CreateBucketCommand({ Bucket: env.FILEVORA_S3_BUCKET }),
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (!name.includes('BucketAlready')) throw error;
  }
  const storage = createS3Storage({
    endpoint: env.FILEVORA_S3_ENDPOINT,
    region: env.FILEVORA_S3_REGION ?? 'us-east-1',
    bucket: env.FILEVORA_S3_BUCKET ?? '',
    accessKeyId: env.FILEVORA_S3_ACCESS_KEY_ID,
    secretAccessKey: env.FILEVORA_S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
    multipartThresholdBytes: 8 * 1024 * 1024,
    partSizeBytes: 8 * 1024 * 1024,
    signedUrlTtlSeconds: 900,
    uploadGrantTtlSeconds: 900,
  });
  const key = `ci/${Date.now()}/hello.txt`;
  const body = new TextEncoder().encode('filevora-minio');
  await storage.putObject({ key, body });
  const head = await storage.headObject(key);
  assert.equal(head?.bytes, body.byteLength);
  await storage.deleteObject(key);
});

test('networked Postgres accepts the metadata schema', async (t) => {
  const url = process.env.FILEVORA_POSTGRES_URL;
  if (!url) {
    t.skip(
      'FILEVORA_POSTGRES_URL is not set; networked Postgres was not started on this machine',
    );
    return;
  }
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  const queryable = {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
  };
  try {
    await applyPostgresSchema(queryable);
    const ping = await queryable.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(ping.rows[0]?.ok, 1);
  } finally {
    await pool.end();
  }
});

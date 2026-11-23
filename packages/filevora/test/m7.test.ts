import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  applyPostgresSchema,
  publishVariantOnce,
} from '../dist/metadata/postgres.js';
import { createS3Storage } from '../dist/storage/s3.js';
import { startS3Emulator } from '../dist/storage/s3-emulator.js';

test('two PGlite workers share one database and S3 object without duplicate variants', async () => {
  const db = new PGlite();
  const queryable = {
    query: <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => db.query<T>(sql, params).then((result) => ({ rows: result.rows })),
    exec: (sql: string) => db.exec(sql),
  };
  await applyPostgresSchema(queryable);
  const now = new Date().toISOString();
  const emulator = await startS3Emulator({
    bucket: 'uploads',
    secret: 'localpassword',
  });
  const storage = createS3Storage({
    endpoint: emulator.url,
    region: 'us-east-1',
    bucket: 'uploads',
    accessKeyId: 'local',
    secretAccessKey: 'localpassword',
    forcePathStyle: true,
    multipartThresholdBytes: 1024,
    partSizeBytes: 1024,
    signedUrlTtlSeconds: 900,
    uploadGrantTtlSeconds: 900,
  });
  try {
    const body = new TextEncoder().encode('shared-object');
    await storage.putObject({ key: 'tenant/file/original/object', body });
    await queryable.query(
      `INSERT INTO files (id, tenant_id, owner_id, original_name, bytes, original_object_key, upload_state, processing_state, created_at)
       VALUES ('file_1', 'tenant-a', 'user-a', 'clip.png', $1, 'tenant/file/original/object', 'verified', 'queued', $2)`,
      [body.byteLength, now],
    );
    const head = await storage.headObject('tenant/file/original/object');
    assert.equal(head?.bytes, body.byteLength);
    const published = await Promise.all([
      publishVariantOnce(queryable, {
        id: 'variant_a',
        fileId: 'file_1',
        name: 'thumbnail',
        storageKey: 'tenant/file/variants/thumb',
        checksum: createHash('sha256').update(body).digest('hex'),
      }),
      publishVariantOnce(queryable, {
        id: 'variant_b',
        fileId: 'file_1',
        name: 'thumbnail',
        storageKey: 'tenant/file/variants/thumb',
        checksum: createHash('sha256').update(body).digest('hex'),
      }),
    ]);
    assert.equal(published.filter((result) => result === 'created').length, 1);
    const count = await queryable.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM variants',
    );
    assert.equal(count.rows[0]?.count, '1');
  } finally {
    await emulator.close();
    await db.close();
  }
});

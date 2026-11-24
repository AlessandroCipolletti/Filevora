import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileSdkError } from '../dist/errors/error.js';
import { resolveConfig, supportedDatabases } from '../dist/config/load.js';
import { createFiles } from '../dist/server/index.js';
import { runCli } from '../dist/cli/main.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('database URL selects stored mode and the driver', () => {
  assert.equal(resolveConfig({}).metadata.mode, 'lite');
  assert.equal(
    resolveConfig({}, { FILEVORA_DATABASE_URL: 'postgres://u:p@db/app' })
      .metadata.driver,
    'postgres',
  );
  assert.equal(
    resolveConfig({}, { FILEVORA_DATABASE_URL: 'postgresql://u:p@db/app' })
      .metadata.driver,
    'postgres',
  );
  assert.equal(
    resolveConfig({}, { FILEVORA_DATABASE_URL: 'mysql://u:p@db/app' }).metadata
      .driver,
    'mysql',
  );
  assert.equal(
    resolveConfig({}, { FILEVORA_DATABASE_URL: 'mariadb://u:p@db/app' })
      .metadata.driver,
    'mysql',
  );
  const sqlite = resolveConfig(
    {},
    { FILEVORA_DATABASE_URL: 'sqlite:///tmp/host.sqlite' },
  );
  assert.equal(sqlite.metadata.mode, 'stored');
  assert.equal(sqlite.metadata.driver, 'sqlite');
  assert.equal(sqlite.metadata.filename, '/tmp/host.sqlite');
  const pathOnly = resolveConfig(
    {},
    { FILEVORA_DATABASE_URL: '/tmp/host.sqlite' },
  );
  assert.equal(pathOnly.metadata.driver, 'sqlite');
  assert.throws(
    () => resolveConfig({ metadata: { mode: 'stored' } }),
    (error: unknown) =>
      error instanceof FileSdkError &&
      error.code === 'INVALID_CONFIG' &&
      error.message.includes('FILEVORA_DATABASE_URL'),
  );
  assert.throws(
    () =>
      resolveConfig({}, { FILEVORA_DATABASE_URL: 'mongodb://localhost/db' }),
    (error: unknown) =>
      error instanceof FileSdkError &&
      error.message.includes('PostgreSQL') &&
      error.message.includes('MySQL') &&
      error.message.includes('SQLite') &&
      supportedDatabases().includes('SQLite'),
  );
  assert.equal(
    resolveConfig(
      { metadata: { mode: 'lite' } },
      { FILEVORA_DATABASE_URL: 'postgres://u:p@db/app' },
    ).metadata.mode,
    'lite',
  );
});

test('lite mode has no database file and list asks for stored mode', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-lite-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { mode: 'lite' },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: { allowedMimeTypes: ['image/png'] },
  });
  try {
    assert.equal(files.config.metadata.mode, 'lite');
    assert.equal(files.config.metadata.filename, '');
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: PNG.byteLength },
      { principal },
    );
    assert.equal(session.assetId, session.fileId);
    await files.writePart(session.id, 1, PNG, { principal });
    const file = await files.completeUpload(session.id, {}, { principal });
    assert.equal(file.asset?.assetId, file.id);
    assert.equal(file.asset?.versions._original?.status, 'ready');
    assert.match(file.asset?.kind ?? '', /image/);
    await assert.rejects(files.list({}, { principal }), (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FEATURE_REQUIRES_STORED_MODE');
      assert.ok(
        error.resolution?.actions.some((action) =>
          action.command?.includes('migrate'),
        ),
      );
      assert.equal(
        error.resolution?.documentationPath,
        'docs/errors/FEATURE_REQUIRES_STORED_MODE.md',
      );
      return true;
    });
    const lines: string[] = [];
    const code = await runCli(
      ['migrate', '--json'],
      { FILEVORA_METADATA_MODE: 'lite', FILES_ENV: 'test' },
      { stdout: (line) => lines.push(line), stderr: () => undefined },
    );
    assert.equal(code, 1);
    assert.match(lines.join(''), /FEATURE_REQUIRES_STORED_MODE/);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stored mode lists ids from the host database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-stored-'));
  const database = path.join(dir, 'host.sqlite');
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { mode: 'stored', url: `sqlite://${database}` },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    defaults: { allowedMimeTypes: ['image/png'] },
  });
  try {
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: PNG.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, PNG, { principal });
    const file = await files.completeUpload(session.id, {}, { principal });
    const page = await files.list({ kind: 'image' }, { principal });
    assert.equal(page.items[0]?.id, file.id);
    const ids = await files.listAssetIds({}, { principal });
    assert.deepEqual(ids.assetIds, [file.id]);
    const db = new DatabaseSync(database);
    db.prepare(
      `INSERT INTO filevora_asset_versions
        (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status)
       VALUES ('ver_thumb', ?, 'thumbnail', 'preset', 1, 'objects/thumb', 'image/webp', 12, 'abc', 'ready')`,
    ).run(file.id);
    db.close();
    await files.delete(file.id, { principal });
    const after = new DatabaseSync(database);
    const version = after
      .prepare('SELECT status FROM filevora_asset_versions WHERE file_id = ?')
      .get(file.id) as { status: string };
    after.close();
    assert.equal(version.status, 'deleted');
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

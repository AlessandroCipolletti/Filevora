import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runCli } from '../dist/cli/main.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(files: ReturnType<typeof createFiles>, name: string) {
  const session = await files.createUploadSession(
    { filename: name, mimeType: 'image/png', bytes: PNG.byteLength },
    { principal },
  );
  await files.writePart(session.id, 1, PNG, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

test('stored mode records last access and deletes only past the lifetime', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-retain-stored-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    retention: {
      enabled: true,
      unusedAfterDays: 1,
      gracePeriodDays: 0,
      cleanupIntervalMinutes: 1,
    },
  });
  try {
    const old = await upload(files, 'old.png');
    const fresh = await upload(files, 'fresh.png');
    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    db.prepare('UPDATE filevora_assets SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      old.id,
    );
    const preview = await files.retentionSweep({ dryRun: true }, { principal });
    assert.equal(preview.filesEligible, 1);
    assert.equal(preview.items[0]?.reason, 'unused');
    assert.equal(preview.filesDeleted, 0);
    await files.getDeliveryUrls(
      old.id,
      { baseUrl: 'http://files.test' },
      { principal },
    );
    const kept = await files.retentionSweep({ dryRun: true }, { principal });
    assert.equal(kept.filesEligible, 0);
    db.prepare(
      'UPDATE filevora_assets SET last_accessed_at = ?, created_at = ? WHERE id = ?',
    ).run(
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      old.id,
    );
    const removed = await files.retentionSweep(
      { dryRun: false },
      { principal },
    );
    assert.equal(removed.filesDeleted, 1);
    await assert.rejects(files.get(old.id, { principal }));
    assert.equal((await files.get(fresh.id, { principal })).id, fresh.id);
    db.close();
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lite mode falls back to creation time and removes old orphan versions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-retain-lite-'));
  const root = path.join(dir, 'objects');
  const files = createFiles({
    env: 'test',
    storage: { root },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'sync', spawn: 'never' },
    retention: {
      enabled: true,
      maxAgeDays: 1,
      gracePeriodDays: 0,
      cleanupIntervalMinutes: 1,
    },
  });
  try {
    const asset = await upload(files, 'card.png');
    const sql = await import('../dist/metadata/backend.js');
    const db = await sql.openBackend(files.config);
    await db.run('UPDATE files SET created_at = ? WHERE id = ?', [
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      asset.id,
    ]);
    await db.close();
    const orphanDir = path.join(root, 'loose');
    mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'asset_thumbnail.webp');
    const recent = path.join(orphanDir, 'asset_hd.webp');
    writeFileSync(orphan, 'old');
    writeFileSync(recent, 'new');
    const past = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(orphan, past, past);
    const report = await files.retentionSweep({ dryRun: false }, { principal });
    assert.equal(report.filesDeleted, 1);
    assert.ok(
      report.orphans.some((item) => item.reason === 'version-without-original'),
    );
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(recent), true);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup CLI dry-run prints a report', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-retain-cli-'));
  const lines: string[] = [];
  const code = await runCli(
    ['cleanup', '--dry-run', '--json', '--tenant', 'tenant-a'],
    {
      FILES_ENV: 'test',
      FILES_STORAGE_ROOT: path.join(dir, 'objects'),
      FILES_RETENTION_ENABLED: 'true',
      FILES_RETENTION_MAX_AGE_DAYS: '30',
    },
    { stdout: (line) => lines.push(line), stderr: () => undefined },
  );
  assert.equal(code, 0);
  const report = JSON.parse(lines.join('')) as { dryRun: boolean };
  assert.equal(report.dryRun, true);
  rmSync(dir, { recursive: true, force: true });
});

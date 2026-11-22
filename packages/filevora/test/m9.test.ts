import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { planRetention } from '../dist/retention/plan.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('retention dry-run lists candidates and pins are kept', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m9-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    retention: { enabled: true, maxAgeDays: 1, gracePeriodDays: 0 },
  });
  try {
    const session = await files.createUploadSession(
      { filename: 'old.png', mimeType: 'image/png', bytes: PNG.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, PNG, { principal });
    const record = await files.completeUpload(session.id, {}, { principal });
    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      record.id,
    );
    const preview = await files.retentionSweep({ dryRun: true }, { principal });
    assert.equal(preview.filesEligible, 1);
    assert.equal(preview.filesDeleted, 0);
    assert.equal(preview.items[0]?.reason, 'max-age');
    assert.equal((await files.get(record.id, { principal })).id, record.id);
    db.prepare('UPDATE files SET pinned = 1 WHERE id = ?').run(record.id);
    const pinned = await files.retentionSweep({ dryRun: true }, { principal });
    assert.equal(pinned.filesEligible, 0);
    db.prepare('UPDATE files SET pinned = 0 WHERE id = ?').run(record.id);
    const removed = await files.retentionSweep(
      { dryRun: false },
      { principal },
    );
    assert.equal(removed.filesDeleted, 1);
    await assert.rejects(files.get(record.id, { principal }));
    const untouched = planRetention(
      [
        {
          id: 'file_new',
          bytes: 10,
          pinned: 0,
          created_at: new Date().toISOString(),
          deleted_at: null,
          grace_until: null,
          last_touch_at: null,
          original_object_key: 'k',
        },
      ],
      {
        enabled: true,
        maxAgeDays: null,
        unusedAfterDays: 1,
        gracePeriodDays: 7,
      },
      Date.now(),
    );
    assert.equal(untouched.length, 0);
    db.close();
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

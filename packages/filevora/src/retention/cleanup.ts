import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RetentionInput } from './plan.js';
import { planRetention, type RetentionRow } from './plan.js';
import type { Sql } from '../metadata/sqlite.js';

export interface CleanupReport {
  dryRun: boolean;
  filesEligible: number;
  bytesEligible: number;
  filesDeleted: number;
  items: Array<{ fileId: string; bytes: number; reason: string }>;
  orphans: Array<{ path: string; reason: string }>;
}

const DAY_MS = 86_400_000;

/**
 * Delete expired assets and old orphan files.
 * An asset is never removed before max-age or the unused window.
 * Orphan files must be older than the cleanup interval.
 */
export async function runCleanup(input: {
  sql: Sql;
  root: string;
  retention: RetentionInput & { cleanupIntervalMinutes: number };
  sessionTtlSeconds: number;
  tenantId?: string;
  dryRun?: boolean;
  nowMs?: number;
  remove?: (key: string) => Promise<void>;
}): Promise<CleanupReport> {
  const now = input.nowMs ?? Date.now();
  const dryRun = Boolean(input.dryRun);
  const rows = await input.sql.all<RetentionRow>(
    input.tenantId
      ? `SELECT id, bytes, pinned, created_at, deleted_at, grace_until, last_touch_at, last_accessed_at, original_object_key
         FROM files WHERE tenant_id = ?`
      : `SELECT id, bytes, pinned, created_at, deleted_at, grace_until, last_touch_at, last_accessed_at, original_object_key
         FROM files`,
    input.tenantId ? [input.tenantId] : [],
  );
  const plan = planRetention(rows, input.retention, now);
  let filesDeleted = 0;
  if (!dryRun) {
    for (const item of plan) {
      const row = rows.find((candidate) => candidate.id === item.fileId);
      if (!row) continue;
      const immediate =
        item.reason === 'grace-elapsed' ||
        input.retention.gracePeriodDays === 0;
      if (immediate) {
        const keys = await input.sql.all<{ storage_key: string }>(
          'SELECT storage_key FROM variants WHERE file_id = ?',
          [row.id],
        );
        const paths = [
          ...(row.original_object_key ? [row.original_object_key] : []),
          ...keys.map((key) => key.storage_key),
        ];
        for (const key of paths) {
          if (input.remove) await input.remove(key).catch(() => undefined);
          else
            await rm(path.join(input.root, key), { force: true }).catch(
              () => undefined,
            );
        }
        filesDeleted += 1;
      }
      const stamp = new Date(now).toISOString();
      const grace = new Date(
        now + input.retention.gracePeriodDays * DAY_MS,
      ).toISOString();
      await input.sql.run(
        `UPDATE files SET deleted_at = COALESCE(deleted_at, ?), grace_until = ?, original_object_key = CASE WHEN ? = 1 THEN NULL ELSE original_object_key END,
         processing_state = CASE WHEN ? = 1 THEN 'deleted' ELSE processing_state END, updated_at = ? WHERE id = ?`,
        [
          stamp,
          immediate ? stamp : grace,
          immediate ? 1 : 0,
          immediate ? 1 : 0,
          stamp,
          row.id,
        ],
      );
      if (immediate) {
        await input.sql.run(
          `UPDATE variants SET status = 'deleted' WHERE file_id = ?`,
          [row.id],
        );
      }
    }
  }
  const orphans = await orphanFiles(input, now);
  if (!dryRun) {
    for (const orphan of orphans) {
      if (input.remove) await input.remove(orphan.path).catch(() => undefined);
      else
        await rm(path.join(input.root, orphan.path), { force: true }).catch(
          () => undefined,
        );
      if (orphan.reason === 'incomplete-upload') {
        await input.sql.run(
          `UPDATE files SET upload_state = 'expired', processing_state = 'deleted', deleted_at = ?, updated_at = ? WHERE original_object_key = ?`,
          [
            new Date(now).toISOString(),
            new Date(now).toISOString(),
            orphan.path,
          ],
        );
      }
    }
    if (plan.length > 0 || orphans.length > 0) {
      const logDir = path.join(input.root, '.filevora');
      await mkdir(logDir, { recursive: true });
      await appendFile(
        path.join(logDir, 'cleanup.log'),
        `${JSON.stringify({ at: new Date(now).toISOString(), files: plan.map((item) => item.fileId), orphans: orphans.map((item) => item.path) })}\n`,
      );
    }
  }
  return {
    dryRun,
    filesEligible: plan.length,
    bytesEligible: plan.reduce((sum, item) => sum + item.bytes, 0),
    filesDeleted: dryRun ? 0 : filesDeleted,
    items: plan.map((item) => ({
      fileId: item.fileId,
      bytes: item.bytes,
      reason: item.reason,
    })),
    orphans,
  };
}

async function orphanFiles(
  input: {
    root: string;
    retention: { cleanupIntervalMinutes: number };
    sessionTtlSeconds: number;
    sql: Sql;
  },
  now: number,
): Promise<Array<{ path: string; reason: string }>> {
  const minAge = Math.max(input.retention.cleanupIntervalMinutes, 1) * 60_000;
  const found: Array<{ path: string; reason: string }> = [];
  const folders = await readdir(input.root, { withFileTypes: true }).catch(
    () => [],
  );
  for (const folder of folders) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    const dir = path.join(input.root, folder.name);
    const names = await readdir(dir).catch(() => [] as string[]);
    const hasOriginal = names.some((name) => name.includes('_original.'));
    if (hasOriginal) continue;
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (now - info.mtimeMs < minAge) continue;
      const reason = name.endsWith('.partial')
        ? 'partial-download'
        : 'version-without-original';
      found.push({ path: path.join(folder.name, name), reason });
    }
  }
  const stale = await input.sql
    .all<{
      id: string;
      created_at: string;
      original_object_key: string | null;
    }>(
      `SELECT id, created_at, original_object_key FROM files WHERE upload_state IN ('authorized', 'uploading')`,
    )
    .catch(() => []);
  for (const row of stale) {
    if (now - Date.parse(row.created_at) < input.sessionTtlSeconds * 1000)
      continue;
    if (row.original_object_key) {
      found.push({
        path: row.original_object_key,
        reason: 'incomplete-upload',
      });
    }
  }
  return found;
}

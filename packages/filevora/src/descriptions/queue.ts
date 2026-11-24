import type { ResolvedConfig } from '../config/load.js';
import type { Sql } from '../metadata/sqlite.js';
import { enqueueProcessingJob } from '../queue/processing-queue.js';
import type { StorageDriver } from '../types/index.js';
import { runAssetDescription } from './run.js';

/** Queue a description without failing the asset. Sync mode runs it in process. */
export async function enqueueAssetDescription(
  sql: Sql,
  storage: StorageDriver,
  config: ResolvedConfig,
  fileId: string,
): Promise<void> {
  if (config.metadata.mode !== 'stored' || !config.gemini.apiKey) return;
  const row = await sql.get<{
    describe_requested: number | null;
    description_status: string | null;
    tenant_id: string;
  }>(
    'SELECT describe_requested, description_status, tenant_id FROM files WHERE id = ?',
    [fileId],
  );
  if (!row || row.describe_requested !== 1) return;
  if (
    row.description_status === 'done' ||
    row.description_status === 'failed'
  ) {
    return;
  }
  if (config.processing.mode === 'sync') {
    await runAssetDescription(sql, storage, config, fileId);
    return;
  }
  await enqueueProcessingJob({
    env: config.env,
    redisUrl: config.queue.redisUrl,
    id: `describe_${fileId}`,
    fileId,
    tenantId: row.tenant_id,
    type: 'describe',
    payload: { schemaVersion: 1 },
    maxAttempts: 1,
    backoffMs: config.queue.backoffBaseMs,
    scope: config.storage.root,
  });
}

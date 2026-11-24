import type { ResolvedConfig } from '../config/load.js';
import type { Sql } from '../metadata/sqlite.js';
import type { ProgressEvent } from '../progress/event.js';
import { streamsDetailedProgress } from '../progress/estimate.js';
import {
  plainDeliveryPath,
  resolveSigningSecrets,
  signDeliveryToken,
  versionTokenName,
} from '../security/delivery.js';

const TERMINAL = new Set([
  'none',
  'ready',
  'partially_ready',
  'failed',
  'quarantined',
  'deleted',
]);

/** Progress JSON for a webhook. Version URLs match the delivery tokens. */
export async function webhookProgress(
  sql: Sql,
  config: ResolvedConfig,
  fileId: string,
): Promise<ProgressEvent> {
  const row = await sql.get<{
    upload_state: string;
    processing_state: string;
    detected_mime: string | null;
    declared_mime: string;
    bytes: number;
    checksum: string | null;
    metadata_json: string;
    original_name: string;
    original_object_key: string | null;
    visibility: string | null;
    url_salt: string | null;
  }>(
    `SELECT upload_state, processing_state, detected_mime, declared_mime, bytes, checksum,
            metadata_json, original_name, original_object_key, visibility, url_salt
     FROM files WHERE id = ?`,
    [fileId],
  );
  if (!row) {
    return {
      fileId,
      assetId: fileId,
      jobId: null,
      phase: 'processing',
      state: 'failed',
      percentage: null,
      etaMs: null,
      quiet: true,
      terminal: true,
    };
  }
  const meta = parseMeta(row.metadata_json);
  const failed = row.processing_state === 'failed';
  const terminal = TERMINAL.has(row.processing_state);
  const event: ProgressEvent = {
    fileId,
    assetId: fileId,
    jobId: meta.filevoraJobId ?? null,
    phase: 'processing',
    state: row.processing_state,
    percentage: null,
    etaMs: null,
    quiet: !streamsDetailedProgress(row.detected_mime),
    terminal,
    ...(meta.filevoraImportError || meta.filevoraSafetyError
      ? { errorCode: meta.filevoraImportError ?? meta.filevoraSafetyError }
      : {}),
  };
  if (!terminal || row.upload_state !== 'verified' || failed || !row.checksum) {
    return event;
  }
  const base = (config.publicBaseUrl ?? 'http://localhost').replace(/\/$/, '');
  const exp = Math.floor(Date.now() / 1000) + config.delivery.urlTtlSeconds;
  const secrets = resolveSigningSecrets(config);
  const secret = secrets[0] ?? '';
  const visibility = row.visibility === 'public' ? 'public' : 'private';
  const salt = row.url_salt ?? '';
  const signed = (version: string) =>
    `${base}/content/${signDeliveryToken(secret, {
      assetId: fileId,
      version: versionTokenName(version),
      exp,
      salt,
    })}`;
  let originalUrl =
    visibility === 'public'
      ? `${base}${plainDeliveryPath(fileId, '_original')}`
      : signed('original');
  if (
    visibility === 'private' &&
    config.storage.driver === 's3' &&
    row.original_object_key
  ) {
    const { createS3Storage } = await import('../storage/s3.js');
    const storage = createS3Storage(config.storage.s3);
    try {
      if (storage.signDownload) {
        const presigned = await storage.signDownload({
          key: row.original_object_key,
          expiresInSeconds: config.delivery.urlTtlSeconds,
          contentType: row.detected_mime ?? row.declared_mime,
          fileName: row.original_name,
        });
        originalUrl = presigned.url;
      }
    } finally {
      await storage.close?.();
    }
  }
  await sql
    .run('UPDATE files SET last_accessed_at = ?, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      new Date().toISOString(),
      fileId,
    ])
    .catch(() => undefined);
  const versions: NonNullable<ProgressEvent['versions']> = {
    _original: {
      version: '_original',
      status: 'ready',
      url: originalUrl,
      mime: row.detected_mime ?? row.declared_mime,
      bytes: row.bytes,
    },
  };
  const variants = await sql.all<{
    id: string;
    name: string;
    mime: string;
    bytes: number;
  }>(
    `SELECT id, name, mime, bytes FROM variants WHERE file_id = ? AND status = 'ready' ORDER BY name ASC`,
    [fileId],
  );
  for (const variant of variants) {
    versions[variant.name] = {
      version: variant.name,
      status: 'ready',
      url:
        visibility === 'public'
          ? `${base}${plainDeliveryPath(fileId, variant.name)}`
          : signed(variant.name),
      mime: variant.mime,
      bytes: variant.bytes,
    };
  }
  event.versions = versions;
  return event;
}

function parseMeta(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { enqueueAssetDescription } from '../descriptions/queue.js';
import {
  cursorValue,
  encodeListCursor,
  isAfterCursor,
  parseListQuery,
  rowMatches,
  sortRows,
  storedListSql,
  type ListQueryInput,
} from './list-query.js';
import { describeIntent } from '../descriptions/policy.js';
import {
  DESCRIPTION_DATABASE_MESSAGE,
  DESCRIPTION_KEY_MESSAGE,
} from '../descriptions/messages.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  microsToScore,
  CURSOR_MISMATCH_MESSAGE,
} from '../search/cursor.js';
import { embedConfigFrom, embedText, toFloat32 } from '../search/embed.js';
import { fingerprintFor, parseSearchInput } from '../search/query.js';
import { QueryVectorCache } from '../search/query-cache.js';
import { rankEmbeddings } from '../search/rank.js';
import { fail, isFileSdkError } from '../errors/error.js';
import {
  addSeconds,
  assetObjectKey,
  createId,
  extensionForMime,
  nowIso,
  sha256,
  tenantPath,
} from '../ids.js';
import { openBackend } from '../metadata/backend.js';
import type { Sql } from '../metadata/sqlite.js';
import {
  metadataObject,
  mimeAllowed,
  sanitizeFilename,
  sniffMime,
} from '../mime.js';
import { assertRecipe, type MediaTransform } from '../processors/ffmpeg.js';
import {
  normalizeCsv,
  normalizeXlsx,
  readPdf,
} from '../processors/normalize.js';
import { renderPdfFirstPage } from '../processors/pdf-preview.js';
import { stripImageMetadata } from '../safety/exif.js';
import type { ProgressEvent } from '../progress/event.js';
import { streamsDetailedProgress } from '../progress/estimate.js';
import {
  closeProcessingQueue,
  enqueueProcessingJob,
  readProcessingJob,
  readProcessingProgress,
  removeProcessingJob,
} from '../queue/processing-queue.js';
import { assertTransformFits } from '../transform/schema.js';
import { measureOriginal } from '../transform/apply.js';
import {
  assertKnownPreset,
  expandTransform,
  presetQueueAction,
} from '../presets/expand.js';
import { downloadRemote } from '../remote/download.js';
import { assertDetectedSize } from '../safety/limits.js';
import { checkRemoteUrl } from '../remote/policy.js';
import { runCleanup } from '../retention/cleanup.js';
import {
  enqueueWebhookJob,
  type WebhookEventName,
} from '../webhooks/deliver.js';
import {
  assertWebhookUrl,
  webhookFields,
  type WebhookRequest,
} from '../webhooks/target.js';
import {
  plainDeliveryPath,
  safeDownloadName,
  signDeliveryToken,
  verifyDeliveryToken,
  versionTokenName,
} from '../security/delivery.js';
import { createFilesystemStorage } from '../storage/filesystem.js';
import { concatStored, readAll } from '../storage/stage.js';
import type {
  DeliveryResult,
  FileRecord,
  FileVariant,
  Page,
  Principal,
  SearchFilesInput,
  SearchFilesPage,
  ProcessingJob,
  StorageDriver,
  UploadPartRecord,
  UploadPolicy,
  UploadSession,
  Visibility,
} from '../types/index.js';
import type { AssetTransformInput } from '../transform/schema.js';
import type { DoctorReport } from '../diagnostics/doctor.js';
import { listPresets, type PresetSummary } from '../presets/catalog.js';
import { executeProcessingJob } from '../worker/run.js';
import {
  ensureEmbeddedWorker,
  filesOptionsFromResolved,
} from '../worker/supervisor.js';
import { toAssetInfo } from './asset-info.js';

export interface RequestContext {
  principal: Principal;
  /** Server policy owner. Ignored when absent. Never taken from the browser body. */
  ownerId?: string;
  /** Server-owned upload limits. They narrow the config limits and never widen them. */
  policy?: UploadPolicy;
}

/** Body of `transform`. Validated at runtime with the same rules as `POST /files/:fileId/transform`. */
export interface TransformRequest {
  preset?: string;
  replace?: boolean;
  operations?: AssetTransformInput['operations'];
  webhook?: WebhookRequest;
}

export interface TransformLaunch {
  launched: true;
  jobId: string;
  assetId: string;
  sourceAssetId: string;
  replace: boolean;
}

export interface DirectUploadGrant {
  mode: 'single' | 'multipart';
  sessionId: string;
  fileId: string;
  key: string;
  expiresAt: string;
  url?: string;
  headers?: Record<string, string>;
  uploadId?: string;
  partSize?: number;
  parts?: Array<{ partNumber: number; url: string; expiresAt: string }>;
}

/** Bytes of one delivered version. `body` is a stream, or a `Uint8Array` for a range read. */
export interface OpenedContent {
  record: FileRecord;
  body: Uint8Array | ReadableStream<Uint8Array>;
  start: number;
  end: number;
  total: number;
  contentType: string;
  fileName: string;
}

export interface WatchProgressOptions {
  /** Prefix for version URLs on the terminal event, for example `https://app.test/api/files`. */
  baseUrl?: string;
  /** Delay between snapshots. Default 100. */
  intervalMs?: number;
  signal?: AbortSignal;
}

const LITE_BATCH_CAP = 20;

export interface CreateSessionInput {
  filename: string;
  mimeType: string;
  bytes: number;
  checksum?: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  preset?: string;
  visibility?: Visibility;
  webhook?: WebhookRequest;
  describe?: boolean;
}

interface FileRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  original_name: string;
  declared_mime: string;
  detected_mime: string | null;
  bytes: number;
  checksum: string | null;
  original_object_key: string | null;
  visibility: string;
  upload_state: string;
  processing_state: string;
  preset: string | null;
  metadata_json: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  url_salt?: string | null;
  description_long?: string | null;
  description_short?: string | null;
  description_status?: string | null;
  description_error?: string | null;
  described_at?: string | null;
  description_model?: string | null;
  describe_requested?: number | null;
}

interface SessionRow {
  id: string;
  file_id: string;
  tenant_id: string;
  owner_id: string;
  status: string;
  transport: string;
  part_size: number;
  declared_bytes: number;
  part_count: number;
  expires_at: string;
  idempotency_key: string | null;
  declared_mime: string;
  filename: string;
  preset: string | null;
  metadata_json: string;
  checksum: string | null;
  created_at: string;
  storage_upload_id?: string | null;
  object_key?: string | null;
}

interface PartRow {
  upload_session_id: string;
  part_number: number;
  etag: string;
  checksum: string | null;
  bytes: number;
  object_key: string;
  completed_at: string;
}

/**
 * Filesystem and SQLite file service. The database opens on the first call,
 * not when `createFiles` validates configuration.
 */
function readJobFailure(reason: string | undefined): {
  code: string | null;
  message: string | null;
} {
  if (!reason) return { code: null, message: null };
  const match = /^([A-Z0-9_]+): ([\s\S]*)$/.exec(reason);
  if (!match?.[1]) return { code: 'FFMPEG_FAILED', message: reason };
  return { code: match[1], message: match[2] ?? reason };
}

export class FileService {
  private sql: Sql | undefined;
  private storage: StorageDriver | undefined;
  private storageReady = false;
  private secret: string | undefined;
  private worker: ChildProcess | undefined;
  private remoteProgress = new Map<
    string,
    { received: number; total: number | null }
  >();
  private remoteStops = new Set<AbortController>();

  constructor(readonly config: ResolvedConfig) {}

  private async db(): Promise<Sql> {
    if (this.sql) return this.sql;
    this.ensureStorage();
    this.sql = await openBackend(this.config);
    this.secret = this.secretFor();
    return this.sql;
  }

  private ensureStorage(): void {
    if (this.storage || this.storageReady) return;
    if (this.config.storage.driver === 'filesystem') {
      const root = path.resolve(this.config.storage.root);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.storage = createFilesystemStorage(root);
    } else if (this.config.storage.driver !== 's3') {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'That storage driver is not available.',
        context: { driver: this.config.storage.driver },
      });
    }
    this.storageReady = true;
  }

  private signingKeys(): string[] {
    if (this.config.signingSecrets.length > 0)
      return this.config.signingSecrets;
    return [this.secretFor()];
  }

  private freshSalt(): string {
    return randomBytes(16).toString('base64url');
  }

  private secretFor(): string {
    if (this.secret) return this.secret;
    if (this.config.signingSecret) return this.config.signingSecret;
    if (this.config.env === 'test') return 'filevora-test-signing-secret';
    if (this.config.env === 'production') {
      throw fail('INVALID_CONFIG', {
        message:
          'Set FILEVORA_SIGNING_SECRET. Lite mode does not keep a signing secret on the asset card.',
      });
    }
    return randomBytes(32).toString('base64url');
  }

  private requireStored(feature: string): void {
    if (this.config.metadata.mode === 'stored') return;
    throw fail('FEATURE_REQUIRES_STORED_MODE', {
      message: `${feature} requires stored metadata mode.`,
      context: {
        mode: 'lite',
        feature,
        env: 'FILEVORA_METADATA_MODE=stored',
        database: 'FILEVORA_DATABASE_URL',
      },
    });
  }

  private async locateOriginal(
    assetId: string,
    ctx: RequestContext,
  ): Promise<{ row: FileRow | null; key: string }> {
    const sql = await this.db();
    if (this.config.metadata.mode === 'lite') {
      const key = await this.probeOriginal(ctx.principal.tenantId, assetId);
      if (!key) {
        throw fail('ASSET_NOT_FOUND', {
          message: 'No {assetId}_original file was found for this asset.',
          context: { assetId },
        });
      }
      const row = await sql.get<FileRow>(
        'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
        [assetId, ctx.principal.tenantId],
      );
      return { row: row ?? null, key };
    }
    const row = await sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [assetId, ctx.principal.tenantId],
    );
    if (!row?.original_object_key) {
      throw fail('ASSET_NOT_FOUND', {
        message: 'The asset was not found in the metadata database.',
        context: { assetId },
      });
    }
    return { row, key: row.original_object_key };
  }

  private async probeOriginal(
    tenantId: string,
    assetId: string,
  ): Promise<string | null> {
    const storage = await this.driver();
    const prefix = `${tenantPath(tenantId)}/${assetId}_original.`;
    const listed = await storage.list(prefix);
    const hit = listed.find(
      (item) =>
        item.key.startsWith(prefix) &&
        !item.key.slice(prefix.length).includes('/'),
    );
    return hit?.key ?? null;
  }

  private async driver(): Promise<StorageDriver> {
    this.ensureStorage();
    if (this.storage) return this.storage;
    return this.s3();
  }

  private async uploadPercent(fileId: string): Promise<number | null> {
    try {
      const session = await (
        await this.db()
      ).get<{ id: string; part_count: number }>(
        'SELECT * FROM upload_sessions WHERE file_id = ?',
        [fileId],
      );
      if (!session?.part_count) return null;
      const parts = await (
        await this.db()
      ).all<PartRow>('SELECT * FROM upload_parts WHERE upload_session_id = ?', [
        session.id,
      ]);
      return Math.min(
        100,
        Math.round((parts.length / session.part_count) * 100),
      );
    } catch {
      return null;
    }
  }

  private async progressVersions(
    fileId: string,
    baseUrl: string,
    ctx: RequestContext,
  ): Promise<ProgressEvent['versions']> {
    const delivery = await this.getDeliveryUrls(fileId, { baseUrl }, ctx);
    const versions: NonNullable<ProgressEvent['versions']> = {};
    if (delivery.original) {
      versions._original = {
        version: '_original',
        status: 'ready',
        url: delivery.original.url,
        mime: delivery.original.mimeType,
        bytes: delivery.original.bytes,
      };
    }
    for (const [name, variant] of Object.entries(delivery.variants)) {
      versions[name] = {
        version: name,
        status: 'ready',
        url: variant.url,
        mime: variant.mimeType,
        bytes: variant.bytes,
      };
    }
    return versions;
  }

  private async deleteAssetObjects(
    tenantId: string,
    assetId: string,
    originalKey: string | null,
  ): Promise<void> {
    const storage = await this.driver();
    const prefix = `${tenantPath(tenantId)}/${assetId}_`;
    const listed = await storage.list(prefix);
    const keys = new Set(
      listed
        .filter((item) => item.key.startsWith(prefix))
        .map((item) => item.key),
    );
    if (originalKey) keys.add(originalKey);
    await Promise.all(
      [...keys].map((key) => storage.deleteObject(key).catch(() => undefined)),
    );
  }

  private root(): string {
    this.ensureStorage();
    return path.resolve(this.config.storage.root);
  }

  async close(): Promise<void> {
    for (const stop of this.remoteStops) stop.abort();
    if (this.worker && !this.worker.killed) this.worker.kill('SIGTERM');
    await this.sql?.close();
    this.sql = undefined;
    await this.storage?.close?.();
    this.storage = undefined;
    await closeProcessingQueue({
      env: this.config.env,
      scope: this.config.storage.root,
    });
  }

  /**
   * Queue a job and, in embedded worker mode, start the child if one is not
   * already alive. `delayMs` is a test-only hold so crash recovery can be
   * observed. Image and video processors are not registered yet.
   */
  async process(
    fileId: string,
    input: { delayMs?: number; transforms?: MediaTransform[] } = {},
    ctx: RequestContext,
  ): Promise<ProcessingJob> {
    await this.get(fileId, ctx);
    if (input.delayMs !== undefined && this.config.env !== 'test') {
      throw fail('INVALID_RECIPE', {
        message: 'delayMs is only available when env is test.',
      });
    }
    if (input.transforms) assertRecipe(input.transforms);
    const type =
      input.delayMs !== undefined
        ? 'test.hold'
        : input.transforms
          ? 'recipe'
          : 'preset';
    const now = nowIso();
    const id = type === 'preset' ? `preset_${fileId}` : createId('job');
    const jobId =
      this.config.processing.mode === 'sync' ? `inline_${fileId}` : id;
    await this.dispatchJob({
      id: jobId,
      fileId,
      tenantId: ctx.principal.tenantId,
      type,
      payload: {
        schemaVersion: 1,
        ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
        ...(input.transforms ? { transforms: input.transforms } : {}),
      },
      maxAttempts: this.config.queue.maxAttempts,
    });
    if (this.config.processing.mode !== 'sync') {
      await (
        await this.db()
      ).run(
        `UPDATE files SET processing_state = 'queued', updated_at = ? WHERE id = ?`,
        [now, fileId],
      );
    }
    return {
      id: jobId,
      fileId,
      tenantId: ctx.principal.tenantId,
      type,
      state: this.config.processing.mode === 'sync' ? 'succeeded' : 'queued',
      attempts: 0,
      maxAttempts: this.config.queue.maxAttempts,
      schemaVersion: 1,
      errorCode: null,
      errorMessage: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      runAfter: now,
    };
  }

  /**
   * Authorize a browser or client to upload straight to S3.
   * `single` is one presigned PUT. `multipart` is a resumable part list.
   * Filesystem storage cannot sign an upload.
   */
  async createDirectUpload(
    input: {
      filename: string;
      mimeType: string;
      bytes: number;
      mode?: 'single' | 'multipart';
      preset?: string;
      describe?: boolean;
    },
    ctx: RequestContext,
  ): Promise<DirectUploadGrant> {
    assertUploadFields(input);
    if (this.config.storage.driver !== 's3') {
      throw fail('INVALID_CONFIG', {
        message:
          'Direct upload needs S3 storage. Filesystem uploads use the chunked session API.',
      });
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 1) {
      throw fail('FILE_TOO_LARGE', {
        message: 'bytes must be a positive integer.',
      });
    }
    if (input.bytes > this.config.defaults.maxFileBytes) {
      throw fail('FILE_TOO_LARGE', {
        message: `The file is larger than the ${this.config.defaults.maxFileBytes} byte limit.`,
      });
    }
    const filename = sanitizeFilename(input.filename);
    const mimeType = input.mimeType;
    if (!mimeAllowed(mimeType, this.config.defaults.allowedMimeTypes)) {
      throw fail('UNSUPPORTED_MIME', { context: { detectedType: mimeType } });
    }
    const wanted = describeIntent(input.describe, this.config);
    const mode =
      input.mode ??
      (input.bytes >= this.config.storage.s3.multipartThresholdBytes
        ? 'multipart'
        : 'single');
    const now = nowIso();
    const fileId = createId('file');
    const sessionId = createId('upl');
    const partSize = this.config.upload.chunkBytes;
    const partCount = mode === 'single' ? 1 : Math.ceil(input.bytes / partSize);
    if (partCount > 10_000) throw fail('FILE_TOO_LARGE');
    const expiresAt = addSeconds(now, this.config.upload.sessionTtlSeconds);
    const key = assetObjectKey(
      ctx.principal.tenantId,
      fileId,
      'original',
      extensionForMime(mimeType),
    );
    const preset = input.preset ?? this.config.defaults.preset;
    if (input.preset) assertKnownPreset(input.preset, this.config.presets);
    const sql = await this.db();
    await sql.transaction(async () => {
      await sql.run(
        `INSERT INTO files (
          id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
          original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
          pinned, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 'private', 'authorized', 'none', ?, '{}', 0, ?, ?, NULL)`,
        [
          fileId,
          ctx.principal.tenantId,
          ctx.principal.id,
          filename,
          mimeType,
          input.bytes,
          preset,
          now,
          now,
        ],
      );
      await sql.run('UPDATE files SET url_salt = ? WHERE id = ?', [
        this.freshSalt(),
        fileId,
      ]);
      await sql.run(
        `INSERT INTO upload_sessions (
          id, file_id, tenant_id, owner_id, status, transport, part_size, declared_bytes, part_count,
          expires_at, idempotency_key, declared_mime, filename, preset, metadata_json, checksum, created_at
        ) VALUES (?, ?, ?, ?, 'authorized', ?, ?, ?, ?, ?, NULL, ?, ?, ?, '{}', NULL, ?)`,
        [
          sessionId,
          fileId,
          ctx.principal.tenantId,
          ctx.principal.id,
          mode === 'single' ? 's3-put' : 's3-multipart',
          mode === 'single' ? input.bytes : partSize,
          input.bytes,
          partCount,
          expiresAt,
          mimeType,
          filename,
          preset,
          now,
        ],
      );
    });
    if (wanted) await this.markDescribe(fileId);
    const storage = await this.s3();
    const grant = this.config.storage.s3.uploadGrantTtlSeconds;
    if (mode === 'single') {
      await sql.run('UPDATE upload_sessions SET object_key = ? WHERE id = ?', [
        key,
        sessionId,
      ]);
      const signed = await storage.signPutObject?.({
        key,
        contentType: mimeType,
        contentLength: input.bytes,
        expiresInSeconds: grant,
      });
      if (!signed) {
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'S3 did not sign the upload.',
        });
      }
      return {
        mode,
        sessionId,
        fileId,
        key,
        expiresAt: signed.expiresAt,
        url: signed.url,
        headers: signed.headers,
      };
    }
    const upload = await storage.createMultipartUpload?.({
      key,
      contentType: mimeType,
    });
    if (!upload) {
      throw fail('STORAGE_UNAVAILABLE', {
        message: 'S3 did not open a multipart upload.',
      });
    }
    await sql.run(
      'UPDATE upload_sessions SET storage_upload_id = ?, object_key = ? WHERE id = ?',
      [upload.uploadId, key, sessionId],
    );
    const parts: Array<{ partNumber: number; url: string; expiresAt: string }> =
      [];
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const signed = await storage.signUploadPart?.({
        key,
        uploadId: upload.uploadId,
        partNumber,
        expiresInSeconds: grant,
      });
      if (!signed) {
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'S3 did not sign an upload part.',
        });
      }
      parts.push({
        partNumber,
        url: signed.url,
        expiresAt: signed.expiresAt,
      });
    }
    return {
      mode,
      sessionId,
      fileId,
      key,
      uploadId: upload.uploadId,
      partSize,
      parts,
      expiresAt,
    };
  }

  /** Head the S3 object, verify it, and start the normal processing pipeline. */
  async completeDirectUpload(
    sessionId: string,
    input: {
      parts?: Array<{ partNumber: number; etag: string }>;
      describe?: boolean;
    },
    ctx: RequestContext,
  ) {
    const session = await this.requireSession(sessionId, ctx.principal);
    if (input.describe === false) {
      await (
        await this.db()
      ).run(
        `UPDATE files SET describe_requested = 0, description_status = NULL, updated_at = ? WHERE id = ?`,
        [nowIso(), session.file_id],
      );
    } else if (input.describe === true) {
      describeIntent(true, this.config);
      await this.markDescribe(session.file_id);
    }
    await this.assertSessionOpen(session);
    if (session.transport === 's3-multipart') {
      return this.completeS3(session, input, ctx);
    }
    if (session.transport !== 's3-put' || !session.object_key) {
      throw fail('INVALID_CONFIG', {
        message: 'This session is not a direct S3 upload.',
      });
    }
    const storage = await this.s3();
    const head = await storage.headObject(session.object_key);
    if (!head) {
      throw fail('UPLOAD_PART_MISSING', {
        message: 'The object is not in the bucket yet.',
      });
    }
    if (head.bytes !== session.declared_bytes) {
      throw fail('UPLOAD_SIZE_MISMATCH');
    }
    let bytes = Buffer.from(
      await readAll(await storage.getObject(session.object_key)),
    );
    const stripped = stripImageMetadata(bytes, this.config.safety.exif);
    if (stripped.byteLength !== bytes.byteLength || stripped !== bytes) {
      const changed = Buffer.from(stripped);
      if (!changed.equals(bytes)) {
        await storage.putObject({
          key: session.object_key,
          body: changed,
          contentType: session.declared_mime,
        });
        bytes = changed;
      }
    }
    const detected = sniffMime(bytes.subarray(0, 64));
    if (!detected) {
      throw fail('UNSUPPORTED_MIME', {
        message: 'The uploaded bytes did not match a supported type.',
      });
    }
    if (
      detected !== session.declared_mime &&
      !compatibleMime(session.declared_mime, detected)
    ) {
      throw fail('MIME_MISMATCH', {
        context: { declared: session.declared_mime, detected },
      });
    }
    if (!mimeAllowed(detected, this.config.defaults.allowedMimeTypes)) {
      throw fail('UNSUPPORTED_MIME', { context: { detectedType: detected } });
    }
    const now = nowIso();
    const checksum = sha256(bytes);
    await (
      await this.db()
    ).run(
      `UPDATE files SET detected_mime = ?, bytes = ?, checksum = ?, original_object_key = ?, upload_state = 'verified', updated_at = ? WHERE id = ?`,
      [
        detected,
        bytes.byteLength,
        checksum,
        session.object_key,
        now,
        session.file_id,
      ],
    );
    await (
      await this.db()
    ).run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
      'verified',
      session.id,
    ]);
    if (
      await this.acceptOriginal(
        session.file_id,
        session.object_key,
        detected,
        bytes.byteLength,
        bytes,
      )
    ) {
      const queued = await this.enqueuePreset(session.file_id, detected, ctx);
      if (!queued) {
        await this.queueWebhook(session.file_id, ctx, 'upload.completed');
      }
    }
    await this.finishDescribe(session.file_id);
    return this.get(session.file_id, ctx);
  }

  /** Merge PDF assets into one new PDF. The sources stay in place. */
  async mergePdfs(
    assetIds: string[],
    ctx: RequestContext,
    describe?: boolean,
  ): Promise<{ assetId: string; jobId: string; sourceAssetIds: string[] }> {
    if (assetIds.length < 2 || assetIds.length > 20) {
      throw fail('TRANSFORM_REJECTED', {
        message: 'Merge needs between 2 and 20 PDF assets.',
        context: {
          field: 'assetIds',
          reason: 'Merge needs between 2 and 20 PDF assets.',
          detectedType: 'application/pdf',
          validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
        },
      });
    }
    for (const assetId of assetIds) {
      const record = await this.get(assetId, ctx);
      if (record.detectedMime !== 'application/pdf') {
        throw fail('TRANSFORM_REJECTED', {
          message: `Asset ${assetId} is not a PDF.`,
          context: {
            field: 'assetIds',
            reason: `Asset ${assetId} is ${record.detectedMime ?? 'unknown'}.`,
            detectedType: record.detectedMime,
            validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
          },
        });
      }
    }
    const assetId = createId('file');
    const jobId =
      this.config.processing.mode === 'sync'
        ? `inline_${assetId}`
        : createId('job');
    await this.insertQueuedPdf(assetId, 'merged.pdf', ctx);
    if (describeIntent(describe, this.config)) await this.markDescribe(assetId);
    await this.dispatchJob({
      id: jobId,
      fileId: assetId,
      tenantId: ctx.principal.tenantId,
      type: 'pdf.merge',
      payload: { schemaVersion: 1, sourceIds: assetIds },
      maxAttempts: 1,
    });
    return { assetId, jobId, sourceAssetIds: assetIds };
  }

  /** Split one PDF into new assets, one per page range. */
  async splitPdf(
    assetId: string,
    ranges: number[][],
    ctx: RequestContext,
    describe?: boolean,
  ): Promise<{
    sourceAssetId: string;
    assetIds: string[];
    jobId: string;
  }> {
    const source = await this.get(assetId, ctx);
    if (source.detectedMime !== 'application/pdf') {
      throw fail('TRANSFORM_REJECTED', {
        message: 'Split applies to PDF assets.',
        context: {
          field: 'assetId',
          reason: `Asset ${assetId} is ${source.detectedMime ?? 'unknown'}.`,
          detectedType: source.detectedMime,
          validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
        },
      });
    }
    if (ranges.length < 1 || ranges.length > 20) {
      throw fail('TRANSFORM_REJECTED', {
        message: 'Split needs between 1 and 20 page ranges.',
        context: {
          field: 'ranges',
          reason: 'Split needs between 1 and 20 page ranges.',
          detectedType: 'application/pdf',
          validOperations: ['pdf.text', 'pdf.pages', 'pdf.removePages'],
        },
      });
    }
    const assetIds = ranges.map(() => createId('file'));
    const wanted = describeIntent(describe, this.config);
    for (const id of assetIds) {
      await this.insertQueuedPdf(id, 'split.pdf', ctx);
      if (wanted) await this.markDescribe(id);
    }
    const jobId =
      this.config.processing.mode === 'sync'
        ? `inline_${assetId}`
        : createId('job');
    await this.dispatchJob({
      id: jobId,
      fileId: assetId,
      tenantId: ctx.principal.tenantId,
      type: 'pdf.split',
      payload: {
        schemaVersion: 1,
        outputs: assetIds.map((id, index) => ({
          assetId: id,
          pages: ranges[index] ?? [],
        })),
      },
      maxAttempts: 1,
    });
    return { sourceAssetId: assetId, assetIds, jobId };
  }

  private async insertQueuedPdf(
    id: string,
    name: string,
    ctx: RequestContext,
  ): Promise<void> {
    const now = nowIso();
    await (
      await this.db()
    ).run(
      `INSERT INTO files (
        id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
        original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
        pinned, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, 'application/pdf', 'application/pdf', 0, NULL, NULL, 'private', 'verified', 'queued', ?, '{}', 0, ?, ?, NULL)`,
      [
        id,
        ctx.principal.tenantId,
        ctx.principal.id,
        name,
        'pdf-text',
        now,
        now,
      ],
    );
    await (
      await this.db()
    ).run('UPDATE files SET url_salt = ? WHERE id = ?', [this.freshSalt(), id]);
  }

  /**
   * Queue a transform and return immediately. `replace` defaults to true and
   * keeps the same asset id. `false` creates a new asset id.
   */
  async transform(
    assetId: string,
    input: TransformRequest,
    ctx: RequestContext,
  ): Promise<TransformLaunch> {
    const raw = isRecord(input) ? input : {};
    const webhook = webhookRequest(raw.webhook);
    const body = withoutWebhook(raw);
    const located = await this.locateOriginal(assetId, ctx);
    const prefix = await (
      await this.driver()
    ).getObjectRange(located.key, 0, 63);
    const detected = sniffMime(prefix);
    if (!detected) {
      throw fail('TRANSFORM_REJECTED', {
        message: 'The original file did not match a supported type.',
        context: {
          field: 'operations',
          reason: 'The original bytes did not match image, video, or PDF.',
          detectedType: null,
          validOperations: [],
          validPresets: [],
        },
      });
    }
    const expanded = expandTransform(
      body,
      detected,
      this.config.presets,
      this.config.defaults.thumbnailWidth,
    );
    if (expanded.mode === 'versions') {
      const now = nowIso();
      const jobId =
        this.config.processing.mode === 'sync'
          ? `inline_${assetId}`
          : createId('job');
      await (
        await this.db()
      ).run(
        `UPDATE files SET preset = ?, processing_state = 'queued', updated_at = ? WHERE id = ?`,
        [expanded.preset.name, now, assetId],
      );
      if (this.config.processing.mode !== 'sync') {
        await removeProcessingJob({
          env: this.config.env,
          redisUrl: this.config.queue.redisUrl,
          id: `preset_${assetId}`,
          scope: this.config.storage.root,
        });
      }
      await this.dispatchJob({
        id: jobId,
        fileId: assetId,
        tenantId: ctx.principal.tenantId,
        type: 'preset',
        payload: {
          schemaVersion: 1,
          preset: expanded.preset.name,
          ...(expanded.preset.name === 'frames' ||
          expanded.preset.name === 'pdf-stills' ||
          expanded.preset.name === 'audio-tools'
            ? { outputs: expanded.preset.outputs }
            : {}),
        },
        maxAttempts: this.config.queue.maxAttempts,
      });
      return {
        launched: true,
        jobId,
        assetId,
        sourceAssetId: assetId,
        replace: false,
      };
    }
    const config = {
      replace: expanded.replace,
      operations: expanded.operations,
    };
    const bounds = await measureOriginal(
      await this.driver(),
      located.key,
      detected,
      this.config.processing.ffprobePath,
    );
    assertTransformFits(config.operations, detected, bounds);
    const replace = config.replace !== false;
    const targetId = replace ? assetId : createId('file');
    const now = nowIso();
    const jobId =
      this.config.processing.mode === 'sync'
        ? `inline_${targetId}`
        : createId('job');
    const metadata = {
      ...(located.row ? safeMeta(located.row.metadata_json) : {}),
      filevoraJobId: jobId,
      filevoraTransform: '1',
      ...(await this.checkedWebhook(webhook)),
    };
    if (!replace) {
      await (
        await this.db()
      ).run(
        `INSERT INTO files (
          id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
          original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
          pinned, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'private', 'verified', 'queued', ?, ?, 0, ?, ?, NULL)`,
        [
          targetId,
          ctx.principal.tenantId,
          ctx.principal.id,
          located.row?.original_name ?? 'transform',
          detected,
          detected,
          this.config.defaults.preset,
          JSON.stringify(metadata),
          now,
          now,
        ],
      );
      await (
        await this.db()
      ).run('UPDATE files SET url_salt = ? WHERE id = ?', [
        this.freshSalt(),
        targetId,
      ]);
    } else {
      await (
        await this.db()
      ).run(
        `UPDATE files SET processing_state = 'queued', metadata_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(metadata), now, targetId],
      );
    }
    if (this.config.processing.mode !== 'sync') {
      await removeProcessingJob({
        env: this.config.env,
        redisUrl: this.config.queue.redisUrl,
        id: `preset_${assetId}`,
        scope: this.config.storage.root,
      });
    }
    await this.dispatchJob({
      id: jobId,
      fileId: targetId,
      tenantId: ctx.principal.tenantId,
      type: 'transform',
      payload: {
        schemaVersion: 1,
        sourceFileId: assetId,
        sourceKey: located.key,
        mime: detected,
        operations: config.operations,
      },
      maxAttempts: 1,
    });
    return {
      launched: true,
      jobId,
      assetId: targetId,
      sourceAssetId: assetId,
      replace,
    };
  }

  async touch(fileId: string, ctx: RequestContext): Promise<void> {
    await this.get(fileId, ctx);
    const now = nowIso();
    await (
      await this.db()
    ).run('UPDATE files SET last_touch_at = ?, updated_at = ? WHERE id = ?', [
      now,
      now,
      fileId,
    ]);
  }

  async retentionSweep(opts: { dryRun?: boolean } = {}, ctx: RequestContext) {
    const storage = await this.driver();
    return runCleanup({
      sql: await this.db(),
      root: this.root(),
      storage,
      retention: this.config.retention,
      sessionTtlSeconds: this.config.upload.sessionTtlSeconds,
      tenantId: ctx.principal.tenantId,
      purgeEmbeddings: this.config.metadata.mode === 'stored',
      dryRun: Boolean(opts.dryRun),
      remove: async (key) => {
        await storage.deleteObject(key);
      },
    });
  }

  async normalize(
    fileId: string,
    input: {
      kind: 'tabular' | 'pdf';
      schema?: {
        columns: Record<string, import('../types/index.js').NormalizeColumn>;
      };
      invalidRows?: 'collect' | 'fail';
      sheet?: string;
    },
    ctx: RequestContext,
  ) {
    const record = await this.get(fileId, ctx);
    const row = await (
      await this.db()
    ).get<FileRow>('SELECT * FROM files WHERE id = ? AND tenant_id = ?', [
      fileId,
      ctx.principal.tenantId,
    ]);
    if (!row?.original_object_key) throw fail('NOT_FOUND');
    const bytes = Buffer.from(
      await readAll(
        await (await this.driver()).getObject(row.original_object_key),
      ),
    );
    let body: Record<string, unknown>;
    if (input.kind === 'pdf' || row.detected_mime === 'application/pdf') {
      const pdf = readPdf(bytes);
      const preview = await renderPdfFirstPage(bytes);
      let previewBody: Record<string, unknown> = {
        available: false,
        code: 'PROCESSOR_UNAVAILABLE' as const,
      };
      if (preview.available) {
        const previewId = createId('variant');
        const previewKey = assetObjectKey(
          ctx.principal.tenantId,
          fileId,
          'page-1',
          'png',
        );
        await (
          await this.driver()
        ).putObject({
          key: previewKey,
          body: preview.png,
          contentType: 'image/png',
        });
        await (
          await this.db()
        ).run(
          `INSERT INTO variants (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, width, height, status, created_at)
           VALUES (?, ?, 'page-1', 'pdf-preview', 1, ?, 'image/png', ?, ?, ?, ?, 'ready', ?)`,
          [
            previewId,
            fileId,
            previewKey,
            preview.png.byteLength,
            sha256(preview.png),
            preview.width,
            preview.height,
            nowIso(),
          ],
        );
        previewBody = {
          available: true,
          variantId: previewId,
          width: preview.width,
          height: preview.height,
          mime: 'image/png',
        };
      }
      body = {
        text: pdf.text,
        pageCount: pdf.pageCount,
        preview: previewBody,
        ...(pdf.code ? { code: pdf.code } : {}),
      };
    } else if (
      row.detected_mime === 'text/csv' ||
      record.declaredMime === 'text/csv'
    ) {
      const table = normalizeCsv(
        bytes.toString('utf8'),
        input.schema?.columns ?? {},
        input.invalidRows ?? 'collect',
      );
      body = { ...table };
    } else if (
      row.detected_mime === 'application/zip' ||
      record.declaredMime.includes('spreadsheetml')
    ) {
      const table = await normalizeXlsx(
        bytes,
        input.schema?.columns ?? {},
        input.sheet,
      );
      body = { ...table };
    } else throw fail('UNSUPPORTED_MIME');
    const payload = Buffer.from(JSON.stringify(body));
    const id = createId('variant');
    const key = assetObjectKey(
      ctx.principal.tenantId,
      fileId,
      'normalized',
      'json',
    );
    await (
      await this.driver()
    ).putObject({
      key,
      body: payload,
      contentType: 'application/json',
    });
    await (
      await this.db()
    ).run(
      `INSERT INTO variants (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status, created_at)
       VALUES (?, ?, 'normalized', 'normalize', 1, ?, 'application/json', ?, ?, 'ready', ?)`,
      [id, fileId, key, payload.byteLength, sha256(payload), nowIso()],
    );
    return {
      fileId,
      schemaVersion: 1,
      output: { format: 'json', variantId: id },
      body,
    };
  }

  async cancelJob(jobId: string, ctx: RequestContext): Promise<ProcessingJob> {
    const job = await this.getJob(jobId, ctx);
    if (
      job.state === 'succeeded' ||
      job.state === 'failed' ||
      job.state === 'cancelled'
    )
      return job;
    await removeProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id: jobId,
      scope: this.config.storage.root,
    });
    await (
      await this.db()
    ).run(
      `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
      [nowIso(), job.fileId],
    );
    return { ...job, state: 'cancelled' };
  }

  async processingSnapshot(
    fileId: string,
    ctx: RequestContext,
    opts?: { baseUrl?: string },
  ): Promise<ProgressEvent> {
    const record = await this.get(fileId, ctx);
    const jobId = record.metadata.filevoraJobId ?? null;
    const errorCode =
      record.metadata.filevoraImportError ??
      record.metadata.filevoraSafetyError;
    const base = { fileId: record.id, assetId: record.id, jobId };
    if (
      record.metadata.filevoraSource === 'remote-url' &&
      record.uploadState !== 'verified'
    ) {
      const progress = this.remoteProgress.get(fileId);
      const failed = record.processingState === 'failed';
      const total = progress?.total ?? null;
      const received = progress?.received ?? 0;
      return {
        ...base,
        state: failed ? 'failed' : 'downloading',
        phase: 'download',
        percentage:
          total && total > 0
            ? Math.min(100, Math.round((received / total) * 100))
            : null,
        etaMs: null,
        quiet: false,
        terminal: failed,
        ...(errorCode ? { errorCode } : {}),
      };
    }
    if (
      record.uploadState === 'uploading' ||
      record.uploadState === 'authorized'
    ) {
      return {
        ...base,
        phase: 'upload',
        state: record.uploadState,
        percentage: await this.uploadPercent(record.id),
        etaMs: null,
        quiet: false,
        terminal: false,
      };
    }
    const progress = await readProcessingProgress(fileId);
    const quiet = !streamsDetailedProgress(record.detectedMime);
    const failed = record.processingState === 'failed';
    const terminal =
      record.processingState === 'none' ||
      record.processingState === 'ready' ||
      record.processingState === 'partially_ready' ||
      failed ||
      record.processingState === 'quarantined' ||
      record.processingState === 'deleted';
    const versions =
      terminal && record.uploadState === 'verified' && !failed && opts?.baseUrl
        ? await this.progressVersions(record.id, opts.baseUrl, ctx)
        : undefined;
    return {
      ...base,
      phase: 'processing',
      state: record.processingState,
      percentage:
        progress.ratio == null ? null : Math.round(progress.ratio * 100),
      etaMs: quiet ? null : progress.etaMs,
      quiet,
      terminal,
      ...(errorCode ? { errorCode } : {}),
      ...(versions ? { versions } : {}),
    };
  }

  /**
   * Yield each changed progress snapshot until the terminal one. Quiet
   * (image and document) jobs yield only the terminal event. This is the
   * stream `GET /files/:fileId/progress` sends as SSE.
   */
  async *watchProgress(
    fileId: string,
    ctx: RequestContext,
    opts: WatchProgressOptions = {},
  ): AsyncGenerator<ProgressEvent, void, undefined> {
    const intervalMs = opts.intervalMs ?? 100;
    let previous = '';
    while (!opts.signal?.aborted) {
      const snapshot = await this.processingSnapshot(
        fileId,
        ctx,
        opts.baseUrl ? { baseUrl: opts.baseUrl } : {},
      );
      const line = JSON.stringify(snapshot);
      if ((!snapshot.quiet || snapshot.terminal) && line !== previous) {
        previous = line;
        yield snapshot;
      }
      if (snapshot.terminal) return;
      await pause(intervalMs, opts.signal);
    }
  }

  async getJob(jobId: string, ctx: RequestContext): Promise<ProcessingJob> {
    const job = await readProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id: jobId,
      scope: this.config.storage.root,
    });
    if (!job || job.data.tenantId !== ctx.principal.tenantId)
      throw fail('NOT_FOUND');
    const state = await job.getState();
    const mapped =
      state === 'active'
        ? 'processing'
        : state === 'completed'
          ? 'succeeded'
          : state === 'failed'
            ? 'failed'
            : 'queued';
    const now = new Date(job.timestamp).toISOString();
    return {
      id: job.id ?? jobId,
      fileId: job.data.fileId,
      tenantId: job.data.tenantId,
      type: job.data.type,
      state: mapped,
      attempts:
        job.attemptsMade + job.stalledCounter + (state === 'active' ? 1 : 0),
      maxAttempts: job.opts.attempts ?? this.config.queue.maxAttempts,
      schemaVersion: job.data.schemaVersion,
      errorCode:
        state === 'failed' ? readJobFailure(job.failedReason).code : null,
      errorMessage:
        state === 'failed' ? readJobFailure(job.failedReason).message : null,
      result:
        job.returnvalue && typeof job.returnvalue === 'object'
          ? (job.returnvalue as Record<string, unknown>)
          : null,
      createdAt: now,
      updatedAt: now,
      runAfter: now,
    };
  }

  ensureWorker(): number {
    const started = ensureEmbeddedWorker(this.config);
    if (started.child) this.worker = started.child;
    return started.pid;
  }

  /** The `filevora doctor` report for this instance's config. `GET /health` serves it. */
  async doctor(): Promise<DoctorReport> {
    const { runDoctor } = await import('../diagnostics/doctor.js');
    return runDoctor(filesOptionsFromResolved(this.config));
  }

  /** Create the Filevora tables in the host database, like `filevora migrate`. Stored mode only. */
  async migrate(): Promise<{ ok: true; mode: 'stored' }> {
    const { migrateHost } = await import('../metadata/migrate-host.js');
    await migrateHost(this.config);
    return { ok: true, mode: 'stored' };
  }

  /** Built-in presets plus the custom presets in this instance's config. */
  listPresets(): PresetSummary[] {
    return listPresets(this.config.presets);
  }

  async createUploadSession(
    input: CreateSessionInput,
    ctx: RequestContext,
  ): Promise<UploadSession> {
    assertUploadFields(input);
    const policy = ctx.policy ?? {};
    const maxFileBytes = Math.min(
      this.config.defaults.maxFileBytes,
      policy.maxFileBytes ?? Number.POSITIVE_INFINITY,
    );
    const mimeType = input.mimeType.toLowerCase();
    if (
      !Number.isInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > maxFileBytes
    ) {
      throw fail('FILE_TOO_LARGE');
    }
    if (
      (policy.allowedMimeTypes &&
        !mimeAllowed(mimeType, policy.allowedMimeTypes)) ||
      !mimeAllowed(mimeType, this.config.defaults.allowedMimeTypes)
    )
      throw fail('UNSUPPORTED_MIME');
    const sql = await this.db();
    const filename = sanitizeFilename(input.filename);
    const ownerId = ctx.ownerId || policy.ownerId;
    if (input.checksum && !/^[a-f0-9]{64}$/i.test(input.checksum)) {
      throw fail('CHECKSUM_MISMATCH', {
        message: 'checksum must be a SHA-256 hex digest.',
      });
    }
    let metadata: Record<string, string>;
    try {
      metadata = {
        ...metadataObject(input.metadata),
        ...(await this.checkedWebhook(input.webhook)),
      };
    } catch (error) {
      if (isFileSdkError(error)) throw error;
      throw fail('INVALID_CONFIG', {
        message: error instanceof Error ? error.message : 'Invalid metadata.',
      });
    }
    const preset = input.preset ?? this.config.defaults.preset;
    assertKnownPreset(preset, this.config.presets);
    const wanted = describeIntent(input.describe, this.config);
    const visibility = this.resolveVisibility(input.visibility);
    await this.assertQuota(ctx.principal.tenantId, input.bytes);
    if (input.idempotencyKey) {
      const existing = await sql.get<SessionRow>(
        'SELECT * FROM upload_sessions WHERE tenant_id = ? AND idempotency_key = ?',
        [ctx.principal.tenantId, input.idempotencyKey],
      );
      if (existing) {
        if (
          existing.declared_bytes !== input.bytes ||
          existing.declared_mime !== mimeType ||
          existing.filename !== filename
        ) {
          throw fail('IDEMPOTENCY_CONFLICT');
        }
        if (wanted) await this.markDescribe(existing.file_id);
        return await this.mapSession(existing);
      }
    }
    const now = nowIso();
    const fileId = createId('file');
    const sessionId = createId('upl');
    const partSize = this.config.upload.chunkBytes;
    const partCount = Math.ceil(input.bytes / partSize);
    if (partCount > 10_000) throw fail('FILE_TOO_LARGE');
    const expiresAt = addSeconds(now, this.config.upload.sessionTtlSeconds);
    await sql.transaction(async () => {
      await sql.run(
        `INSERT INTO files (
          id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
          original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
          pinned, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, 'authorized', 'none', ?, ?, 0, ?, ?, NULL)`,
        [
          fileId,
          ctx.principal.tenantId,
          ownerId || ctx.principal.id,
          filename,
          mimeType,
          input.bytes,
          visibility,
          preset,
          JSON.stringify(metadata),
          now,
          now,
        ],
      );
      await sql.run('UPDATE files SET url_salt = ? WHERE id = ?', [
        this.freshSalt(),
        fileId,
      ]);
      await sql.run(
        `INSERT INTO upload_sessions (
          id, file_id, tenant_id, owner_id, status, transport, part_size, declared_bytes, part_count,
          expires_at, idempotency_key, declared_mime, filename, preset, metadata_json, checksum, created_at
        ) VALUES (?, ?, ?, ?, 'authorized', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          fileId,
          ctx.principal.tenantId,
          ctx.principal.id,
          this.config.storage.driver === 's3' ? 's3-multipart' : 'chunked-http',
          partSize,
          input.bytes,
          partCount,
          expiresAt,
          input.idempotencyKey ?? null,
          mimeType,
          filename,
          preset,
          JSON.stringify(metadata),
          input.checksum?.toLowerCase() ?? null,
          now,
        ],
      );
      await this.audit(sql, ctx.principal, fileId, 'session.create', {
        sessionId,
      });
    });
    if (this.config.storage.driver === 's3') {
      const key = assetObjectKey(
        ctx.principal.tenantId,
        fileId,
        'original',
        extensionForMime(mimeType),
      );
      const storage = await this.s3();
      const upload = await storage.createMultipartUpload?.({
        key,
        contentType: mimeType,
      });
      if (!upload)
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'S3 did not open a multipart upload.',
        });
      await sql.run(
        'UPDATE upload_sessions SET storage_upload_id = ?, object_key = ? WHERE id = ?',
        [upload.uploadId, key, sessionId],
      );
    }
    const created = await sql.get<SessionRow>(
      'SELECT * FROM upload_sessions WHERE id = ?',
      [sessionId],
    );
    if (!created)
      throw fail('STORAGE_UNAVAILABLE', {
        message: 'The upload session was not stored.',
      });
    if (wanted) await this.markDescribe(fileId);
    return await this.mapSession(created);
  }

  /**
   * Create an asset from a remote URL and return its id immediately.
   * The download and the normal encoding queue continue after this returns.
   */
  async createFromUrl(
    input: {
      url: string;
      webhook?: WebhookRequest;
      preset?: string;
      visibility?: Visibility;
      describe?: boolean;
    },
    ctx: RequestContext,
  ): Promise<FileRecord> {
    if (typeof input.url !== 'string' || !input.url) {
      throw fail('INVALID_CONFIG', { message: 'url is required.' });
    }
    await checkRemoteUrl(input.url, this.config.remote, 'request');
    const preset = input.preset ?? this.config.defaults.preset;
    assertKnownPreset(preset, this.config.presets);
    const wanted = describeIntent(input.describe, this.config);
    const visibility = this.resolveVisibility(input.visibility);
    const sql = await this.db();
    if (this.config.storage.driver === 's3') await this.s3();
    const now = nowIso();
    const fileId = createId('file');
    const filename = sanitizeFilename(remoteFilename(input.url));
    await sql.run(
      `INSERT INTO files (
        id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
        original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
        pinned, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, 'application/octet-stream', NULL, 0, NULL, NULL, ?, 'uploading', 'none', ?, ?, 0, ?, ?, NULL)`,
      [
        fileId,
        ctx.principal.tenantId,
        ctx.principal.id,
        filename,
        visibility,
        preset,
        JSON.stringify({
          filevoraSource: 'remote-url',
          ...(await this.checkedWebhook(input.webhook)),
        }),
        now,
        now,
      ],
    );
    await sql.run('UPDATE files SET url_salt = ? WHERE id = ?', [
      this.freshSalt(),
      fileId,
    ]);
    if (wanted) await this.markDescribe(fileId);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.config.remote.timeoutMs);
    this.remoteStops.add(stop);
    this.remoteProgress.set(fileId, { received: 0, total: null });
    void this.finishRemote(fileId, input.url, ctx, stop.signal).finally(() => {
      clearTimeout(timer);
      this.remoteStops.delete(stop);
      this.remoteProgress.delete(fileId);
    });
    return this.get(fileId, ctx);
  }

  private async finishRemote(
    fileId: string,
    url: string,
    ctx: RequestContext,
    signal: AbortSignal,
  ): Promise<void> {
    let key: string | undefined;
    try {
      const remote = await downloadRemote({
        url,
        policy: this.config.remote,
        signal,
        onProgress: (received, total) => {
          this.remoteProgress.set(fileId, { received, total });
        },
      });
      if (!mimeAllowed(remote.mime, this.config.defaults.allowedMimeTypes)) {
        throw fail('UNSUPPORTED_MIME', {
          message: 'The remote file type is not allowed.',
          context: { detectedType: remote.mime },
        });
      }
      key = assetObjectKey(
        ctx.principal.tenantId,
        fileId,
        'original',
        extensionForMime(remote.mime),
      );
      const storage =
        this.storage ??
        (this.config.storage.driver === 's3' ? await this.s3() : undefined);
      if (!storage) throw fail('STORAGE_UNAVAILABLE');
      const stored = await storage.putObject({
        key,
        body: remote.bytes,
        contentType: remote.mime,
      });
      const now = nowIso();
      await (
        await this.db()
      ).run(
        `UPDATE files SET detected_mime = ?, bytes = ?, checksum = ?, original_object_key = ?,
         upload_state = 'verified', updated_at = ? WHERE id = ?`,
        [remote.mime, stored.bytes, stored.checksum, key, now, fileId],
      );
      assertDetectedSize(
        remote.mime,
        stored.bytes,
        this.config.safety.typeMaxBytes,
        this.config.defaults.maxFileBytes,
      );
      if (await this.acceptOriginal(fileId, key, remote.mime, stored.bytes)) {
        const queued = await this.enqueuePreset(fileId, remote.mime, ctx);
        if (!queued) await this.queueWebhook(fileId, ctx, 'upload.completed');
      }
      await this.finishDescribe(fileId);
    } catch (error) {
      if (key) await this.storage?.deleteObject(key).catch(() => undefined);
      const code = isFileSdkError(error) ? error.code : 'REMOTE_URL_BLOCKED';
      const now = nowIso();
      const current = await (
        await this.db()
      ).get<{ metadata_json: string }>(
        'SELECT metadata_json FROM files WHERE id = ?',
        [fileId],
      );
      const meta = safeMeta(current?.metadata_json);
      await (
        await this.db()
      ).run(
        `UPDATE files SET upload_state = 'expired', processing_state = 'failed', metadata_json = ?, updated_at = ? WHERE id = ?`,
        [
          JSON.stringify({
            ...meta,
            filevoraSource: 'remote-url',
            filevoraImportError: code,
          }),
          now,
          fileId,
        ],
      );
      await this.queueWebhook(fileId, ctx, 'processing.failed').catch(
        () => undefined,
      );
    }
  }

  private async s3(): Promise<NonNullable<FileService['storage']>> {
    if (this.storage?.capabilities().driver === 's3') return this.storage;
    const { createS3Storage } = await import('../storage/s3.js');
    this.storage = createS3Storage(this.config.storage.s3);
    return this.storage;
  }

  async partUploadUrls(
    sessionId: string,
    ctx: RequestContext,
  ): Promise<Record<string, string>> {
    const session = await this.requireSession(sessionId, ctx.principal);
    if (
      session.transport !== 's3-multipart' ||
      !session.storage_upload_id ||
      !session.object_key
    )
      return {};
    const storage = await this.s3();
    if (!storage.signUploadPart) return {};
    const urls: Record<string, string> = {};
    for (
      let partNumber = 1;
      partNumber <= session.part_count;
      partNumber += 1
    ) {
      const signed = await storage.signUploadPart({
        key: session.object_key,
        uploadId: session.storage_upload_id,
        partNumber,
        expiresInSeconds: this.config.storage.s3.uploadGrantTtlSeconds,
      });
      urls[String(partNumber)] = signed.url;
    }
    return urls;
  }

  private async completeS3(
    session: SessionRow,
    input: {
      parts?: Array<{ partNumber: number; etag: string }>;
      checksum?: string;
    },
    ctx: RequestContext,
  ): Promise<FileRecord> {
    const claimed = [...(input.parts ?? [])].sort(
      (left, right) => left.partNumber - right.partNumber,
    );
    const storage = await this.s3();
    if (
      claimed.length !== session.part_count ||
      !session.object_key ||
      !session.storage_upload_id ||
      !storage.completeMultipartUpload
    ) {
      throw fail('UPLOAD_PART_MISSING');
    }
    const stored = await storage.completeMultipartUpload({
      key: session.object_key,
      uploadId: session.storage_upload_id,
      parts: claimed,
    });
    if (stored.bytes !== session.declared_bytes)
      throw fail('UPLOAD_SIZE_MISMATCH');
    const stream = await storage.getObject(session.object_key);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const checksum = sha256(bytes);
    const detected = sniffMime(bytes.subarray(0, 64));
    if (!detected) throw fail('UNSUPPORTED_MIME');
    if (
      detected !== session.declared_mime &&
      !compatibleMime(session.declared_mime, detected)
    ) {
      throw fail('MIME_MISMATCH', {
        context: { declared: session.declared_mime, detected },
      });
    }
    if (input.checksum && input.checksum.toLowerCase() !== checksum)
      throw fail('CHECKSUM_MISMATCH');
    const now = nowIso();
    await (
      await this.db()
    ).transaction(async () => {
      await (
        await this.db()
      ).run(
        `UPDATE files SET detected_mime = ?, bytes = ?, checksum = ?, original_object_key = ?, upload_state = 'verified', updated_at = ? WHERE id = ?`,
        [
          detected,
          stored.bytes,
          checksum,
          session.object_key,
          now,
          session.file_id,
        ],
      );
      await (
        await this.db()
      ).run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'verified',
        session.id,
      ]);
      await this.audit(
        await this.db(),
        ctx.principal,
        session.file_id,
        'upload.complete',
        {
          checksum,
          transport: 's3-multipart',
        },
      );
    });
    assertDetectedSize(
      detected,
      stored.bytes,
      this.config.safety.typeMaxBytes,
      this.config.defaults.maxFileBytes,
    );
    if (
      await this.acceptOriginal(
        session.file_id,
        session.object_key ?? '',
        detected,
        stored.bytes,
        bytes,
      )
    ) {
      const queued = await this.enqueuePreset(session.file_id, detected, ctx);
      if (!queued)
        await this.queueWebhook(session.file_id, ctx, 'upload.completed');
    }
    await this.finishDescribe(session.file_id);
    return this.get(session.file_id, ctx);
  }

  async getUploadSession(
    id: string,
    ctx: RequestContext,
  ): Promise<UploadSession> {
    return await this.mapSession(await this.requireSession(id, ctx.principal));
  }

  async writePart(
    sessionId: string,
    partNumber: number,
    body: Uint8Array,
    ctx: RequestContext,
  ): Promise<{ partNumber: number; etag: string; bytes: number }> {
    const sql = await this.db();
    const session = await this.requireSession(sessionId, ctx.principal);
    await this.assertSessionOpen(session);
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.part_count
    ) {
      throw fail('UPLOAD_PART_MISSING', {
        message: 'The part number is outside the session.',
      });
    }
    const expected =
      partNumber === session.part_count
        ? session.declared_bytes - session.part_size * (session.part_count - 1)
        : session.part_size;
    if (body.byteLength !== expected) throw fail('UPLOAD_SIZE_MISMATCH');
    const key = assetObjectKey(
      session.tenant_id,
      session.file_id,
      `part-${partNumber}`,
      'bin',
    );
    await (
      await this.driver()
    ).putObject({ key, body, contentType: 'application/octet-stream' });
    const etag = sha256(body);
    const now = nowIso();
    await sql.transaction(async () => {
      await sql.run(
        'DELETE FROM upload_parts WHERE upload_session_id = ? AND part_number = ?',
        [session.id, partNumber],
      );
      await sql.run(
        `INSERT INTO upload_parts (upload_session_id, part_number, etag, checksum, bytes, object_key, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [session.id, partNumber, etag, etag, body.byteLength, key, now],
      );
      await sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'uploading',
        session.id,
      ]);
      await sql.run(
        'UPDATE files SET upload_state = ?, updated_at = ? WHERE id = ?',
        ['uploading', now, session.file_id],
      );
    });
    return { partNumber, etag, bytes: body.byteLength };
  }

  async completeUpload(
    sessionId: string,
    input: {
      parts?: Array<{ partNumber: number; etag: string }>;
      checksum?: string;
    },
    ctx: RequestContext,
  ): Promise<FileRecord> {
    const sql = await this.db();
    const session = await this.requireSession(sessionId, ctx.principal);
    if (session.status === 'verified') return this.get(session.file_id, ctx);
    await this.assertSessionOpen(session);
    if (session.transport === 's3-multipart')
      return this.completeS3(session, input, ctx);
    const parts = await sql.all<PartRow>(
      'SELECT * FROM upload_parts WHERE upload_session_id = ? ORDER BY part_number ASC',
      [session.id],
    );
    if (parts.length !== session.part_count) throw fail('UPLOAD_PART_MISSING');
    for (let index = 0; index < session.part_count; index += 1) {
      if (parts[index]?.part_number !== index + 1)
        throw fail('UPLOAD_PART_MISSING');
    }
    if (input.parts) {
      for (const claimed of input.parts) {
        const stored = parts.find(
          (part) => part.part_number === claimed.partNumber,
        );
        if (!stored || stored.etag !== claimed.etag)
          throw fail('UPLOAD_PART_MISSING');
      }
    }
    const storedBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
    if (storedBytes !== session.declared_bytes)
      throw fail('UPLOAD_SIZE_MISMATCH');
    const prefix = await (
      await this.driver()
    ).getObjectRange(parts[0]?.object_key ?? '', 0, 63);
    let detected = sniffMime(prefix);
    if (
      !detected &&
      session.declared_mime === 'text/csv' &&
      isMostlyText(prefix)
    )
      detected = 'text/csv';
    if (!detected) {
      throw fail('UNSUPPORTED_MIME', {
        message: 'The uploaded bytes did not match a supported type.',
      });
    }
    if (
      detected !== session.declared_mime &&
      !compatibleMime(session.declared_mime, detected)
    ) {
      throw fail('MIME_MISMATCH', {
        context: { declared: session.declared_mime, detected },
      });
    }
    if (!mimeAllowed(detected, this.config.defaults.allowedMimeTypes)) {
      throw fail('UNSUPPORTED_MIME', {
        context: { detectedType: detected },
      });
    }
    assertDetectedSize(
      detected,
      storedBytes,
      this.config.safety.typeMaxBytes,
      this.config.defaults.maxFileBytes,
    );
    const originalKey = assetObjectKey(
      session.tenant_id,
      session.file_id,
      'original',
      extensionForMime(detected),
    );
    const storage = await this.driver();
    const assembled = await concatStored(
      storage,
      parts.map((part) => part.object_key),
      originalKey,
    );
    if (assembled.bytes !== session.declared_bytes)
      throw fail('UPLOAD_SIZE_MISMATCH');
    const expectedChecksum = (
      input.checksum ?? session.checksum
    )?.toLowerCase();
    if (expectedChecksum && expectedChecksum !== assembled.checksum) {
      await storage.deleteObject(originalKey);
      throw fail('CHECKSUM_MISMATCH');
    }
    const now = nowIso();
    await sql.transaction(async () => {
      await sql.run(
        `UPDATE files SET detected_mime = ?, bytes = ?, checksum = ?, original_object_key = ?,
         upload_state = 'verified', updated_at = ? WHERE id = ?`,
        [
          detected,
          assembled.bytes,
          assembled.checksum,
          originalKey,
          now,
          session.file_id,
        ],
      );
      await sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'verified',
        session.id,
      ]);
      await this.audit(sql, ctx.principal, session.file_id, 'upload.complete', {
        checksum: assembled.checksum,
      });
    });
    for (const part of parts) {
      await storage.deleteObject(part.object_key);
    }
    if (
      await this.acceptOriginal(
        session.file_id,
        originalKey,
        detected,
        assembled.bytes,
      )
    ) {
      const queued = await this.enqueuePreset(session.file_id, detected, ctx);
      if (!queued)
        await this.queueWebhook(session.file_id, ctx, 'upload.completed');
    }
    await this.finishDescribe(session.file_id);
    return this.get(session.file_id, ctx);
  }

  async abortUpload(sessionId: string, ctx: RequestContext): Promise<void> {
    const sql = await this.db();
    const session = await this.requireSession(sessionId, ctx.principal);
    if (session.status === 'verified')
      throw fail('INVALID_CONFIG', {
        message: 'A verified upload cannot be aborted.',
      });
    const parts = await sql.all<PartRow>(
      'SELECT * FROM upload_parts WHERE upload_session_id = ?',
      [session.id],
    );
    const storage = await this.driver();
    for (const part of parts) await storage.deleteObject(part.object_key);
    const now = nowIso();
    await sql.transaction(async () => {
      await sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'aborted',
        session.id,
      ]);
      await sql.run(
        `UPDATE files SET upload_state = 'aborted', deleted_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, session.file_id],
      );
      await this.audit(
        sql,
        ctx.principal,
        session.file_id,
        'session.abort',
        {},
      );
    });
  }

  async get(
    fileId: string,
    ctx: RequestContext,
    opts?: { detailed?: boolean },
  ): Promise<FileRecord> {
    const row = await (
      await this.db()
    ).get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [fileId, ctx.principal.tenantId],
    );
    if (!row || row.upload_state === 'aborted') throw fail('ASSET_NOT_FOUND');
    const record = mapFile(row);
    record.variants = await loadVariants(await this.db(), row.id);
    await attachTags(await this.db(), record);
    record.asset = toAssetInfo(record, { detailed: opts?.detailed ?? true });
    return record;
  }

  /**
   * Read many assets in request order. Missing or deleted ids are skipped.
   * Lite mode accepts at most 20 ids. More than 20 ids return summary
   * `asset` blocks instead of detailed ones.
   */
  async getMany(
    assetIds: string[],
    ctx: RequestContext,
  ): Promise<FileRecord[]> {
    const ids = Array.isArray(assetIds) ? assetIds : [];
    if (this.config.metadata.mode === 'lite' && ids.length > LITE_BATCH_CAP) {
      throw fail('FEATURE_REQUIRES_STORED_MODE', {
        message: `Lite batch get is capped at ${LITE_BATCH_CAP} asset ids.`,
        context: { mode: 'lite', cap: LITE_BATCH_CAP },
      });
    }
    const detailed = ids.length <= LITE_BATCH_CAP;
    const assets: FileRecord[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      try {
        assets.push(await this.get(id, ctx, { detailed }));
      } catch (error) {
        if (!isFileSdkError(error) || error.code !== 'ASSET_NOT_FOUND')
          throw error;
      }
    }
    return assets;
  }

  async listAssetIds(
    query: { limit?: number; cursor?: string },
    ctx: RequestContext,
  ): Promise<{ assetIds: string[]; nextCursor: string | null }> {
    this.requireStored('Listing asset ids');
    const page = await this.list(query, ctx);
    return {
      assetIds: page.items.map((item) => item.id),
      nextCursor: page.nextCursor,
    };
  }

  async list(
    query: ListQueryInput,
    ctx: RequestContext,
  ): Promise<Page<FileRecord>> {
    const parsed = parseListQuery(query, this.config);
    const rows =
      this.config.metadata.mode === 'stored'
        ? await this.listStored(parsed, ctx)
        : await this.listLite(parsed, ctx);
    const page: FileRecord[] = [];
    for (const row of rows.slice(0, parsed.limit)) {
      const record = mapFile(row);
      record.variants = await loadVariants(await this.db(), row.id);
      await attachTags(await this.db(), record);
      record.asset = toAssetInfo(record, { detailed: true });
      page.push(record);
    }
    const last = rows[parsed.limit - 1];
    const next =
      rows.length > parsed.limit && last
        ? encodeListCursor(cursorValue(last, parsed.sort), last.id)
        : null;
    return { items: page, nextCursor: next };
  }

  private readonly queryVectors = new QueryVectorCache();

  /** Semantic search over described assets. Stored mode and a Gemini key are required. */
  async search(
    input: SearchFilesInput,
    ctx: RequestContext,
  ): Promise<SearchFilesPage> {
    if (this.config.metadata.mode !== 'stored') {
      throw fail('DESCRIPTION_REQUIRES_DATABASE', {
        message: DESCRIPTION_DATABASE_MESSAGE,
      });
    }
    const { gemini } = this.config;
    if (!gemini.apiKey) {
      throw fail('DESCRIPTION_NOT_CONFIGURED', {
        message: DESCRIPTION_KEY_MESSAGE,
      });
    }
    const parsed = parseSearchInput(input, {
      minScore: gemini.searchMinScore,
      maxResults: gemini.searchMaxResults,
      config: this.config,
    });
    const fingerprint = fingerprintFor(
      parsed,
      gemini.embeddingModel,
      gemini.embeddingDimensions,
    );
    const cursor = parsed.cursor
      ? decodeSearchCursor(parsed.cursor, fingerprint)
      : undefined;
    const returned = cursor?.n ?? 0;
    const remaining = parsed.maxResults - returned;
    if (remaining <= 0) {
      throw fail('SEARCH_QUERY_INVALID', { message: CURSOR_MISMATCH_MESSAGE });
    }
    const pageSize = Math.min(parsed.limit, remaining);
    const cacheKey = QueryVectorCache.key(
      gemini.embeddingModel,
      gemini.embeddingDimensions,
      parsed.query,
    );
    let queryBytes = this.queryVectors.get(cacheKey);
    if (!queryBytes) {
      queryBytes = await embedText(embedConfigFrom(this.config), {
        text: parsed.query,
        task: 'RETRIEVAL_QUERY',
      });
      this.queryVectors.set(cacheKey, queryBytes);
    }
    const sql = await this.db();
    const ranked = await rankEmbeddings({
      sql,
      tenantId: ctx.principal.tenantId,
      model: gemini.embeddingModel,
      dimensions: gemini.embeddingDimensions,
      queryVector: toFloat32(queryBytes),
      filters: parsed.filters,
      minScoreMicros: parsed.minScoreMicros,
      ...(cursor
        ? { after: { scoreMicros: cursor.s, assetId: cursor.id } }
        : {}),
      pageSize,
    });
    const rows = ranked.hits.length
      ? await sql.all<FileRow>(
          `SELECT * FROM files WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${ranked.hits.map(() => '?').join(', ')})`,
          [ctx.principal.tenantId, ...ranked.hits.map((hit) => hit.assetId)],
        )
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: SearchFilesPage['items'] = [];
    for (const hit of ranked.hits) {
      const row = byId.get(hit.assetId);
      if (!row) continue;
      const file = mapFile(row);
      file.variants = await loadVariants(sql, row.id);
      await attachTags(sql, file);
      file.asset = toAssetInfo(file, { detailed: true });
      items.push({ score: microsToScore(hit.scoreMicros), file });
    }
    const last = ranked.hits[ranked.hits.length - 1];
    const capped = ranked.hasMore && pageSize === remaining;
    return {
      items,
      nextCursor:
        ranked.hasMore && !capped && last
          ? encodeSearchCursor({
              v: 1,
              s: last.scoreMicros,
              id: last.assetId,
              n: returned + ranked.hits.length,
              qh: fingerprint,
            })
          : null,
      meta: {
        model: gemini.embeddingModel,
        dimensions: gemini.embeddingDimensions,
        minScore: parsed.minScore,
        maxResults: parsed.maxResults,
        candidatesScored: ranked.candidatesScored,
        capped,
      },
    };
  }

  private async listStored(
    query: ReturnType<typeof parseListQuery>,
    ctx: RequestContext,
  ): Promise<FileRow[]> {
    const compiled = storedListSql(query, ctx.principal.tenantId);
    return (await this.db()).all<FileRow>(compiled.sql, compiled.params);
  }

  private async listLite(
    query: ReturnType<typeof parseListQuery>,
    ctx: RequestContext,
  ): Promise<FileRow[]> {
    const sql = await this.db();
    const rows = await sql.all<FileRow>(
      'SELECT * FROM files WHERE tenant_id = ? AND deleted_at IS NULL AND upload_state = ?',
      [ctx.principal.tenantId, 'verified'],
    );
    const needsDimensions =
      query.durationMin !== undefined ||
      query.durationMax !== undefined ||
      query.widthMin !== undefined ||
      query.heightMin !== undefined;
    const matched: FileRow[] = [];
    for (const row of rows) {
      const variants = needsDimensions
        ? await sql.all<{
            width: number | null;
            height: number | null;
            duration_ms: number | null;
            status: string;
          }>(
            'SELECT width, height, duration_ms, status FROM variants WHERE file_id = ?',
            [row.id],
          )
        : [];
      if (rowMatches(row, variants, query)) matched.push(row);
    }
    return sortRows(matched, query)
      .filter((row) => isAfterCursor(row, query))
      .slice(0, query.limit + 1);
  }

  async delete(fileId: string, ctx: RequestContext): Promise<void> {
    const sql = await this.db();
    const row = await sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [fileId, ctx.principal.tenantId],
    );
    if (!row) throw fail('ASSET_NOT_FOUND');
    await this.deleteAssetObjects(
      row.tenant_id,
      row.id,
      row.original_object_key,
    );
    const now = nowIso();
    await sql.transaction(async () => {
      await sql.run(
        `UPDATE files SET deleted_at = ?, processing_state = 'deleted', updated_at = ? WHERE id = ?`,
        [now, now, row.id],
      );
      await sql.run(
        `UPDATE variants SET status = 'deleted' WHERE file_id = ?`,
        [row.id],
      );
      if (this.config.metadata.mode === 'stored') {
        await sql.run(
          'DELETE FROM filevora_asset_embeddings WHERE asset_id = ?',
          [row.id],
        );
      }
      await this.audit(sql, ctx.principal, row.id, 'file.delete', {});
    });
  }

  async getDeliveryUrls(
    fileId: string,
    input: { expiresInSeconds?: number; baseUrl: string },
    ctx: RequestContext,
  ): Promise<DeliveryResult> {
    const record = await this.get(fileId, ctx);
    if (record.uploadState !== 'verified' || !record.checksum)
      throw fail('NOT_FOUND');
    await (
      await this.db()
    )
      .run(
        'UPDATE files SET last_accessed_at = ?, updated_at = ? WHERE id = ?',
        [nowIso(), nowIso(), record.id],
      )
      .catch(() => undefined);
    const ttl = input.expiresInSeconds ?? this.config.delivery.urlTtlSeconds;
    if (ttl < 30 || ttl > 86_400)
      throw fail('INVALID_CONFIG', {
        message: 'Delivery TTL is outside the allowed range.',
      });
    const row = await (
      await this.db()
    ).get<FileRow>('SELECT * FROM files WHERE id = ?', [record.id]);
    const salt = row?.url_salt ?? '';
    const visibility = row?.visibility === 'public' ? 'public' : 'private';
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const base = input.baseUrl.replace(/\/$/, '');
    const signed = (version: string) =>
      `${base}${this.contentPath(record.id, version, salt, exp)}`;
    let originalUrl =
      visibility === 'public'
        ? `${base}${plainDeliveryPath(record.id, '_original')}`
        : signed('original');
    if (visibility === 'private' && this.config.storage.driver === 's3') {
      const storage = await this.s3();
      if (row?.original_object_key && storage.signDownload) {
        const presigned = await storage.signDownload({
          key: row.original_object_key,
          expiresInSeconds: ttl,
          contentType: record.detectedMime ?? record.declaredMime,
          fileName: record.originalName,
        });
        originalUrl = presigned.url;
      }
    }
    const variants: DeliveryResult['variants'] = {};
    for (const variant of await loadVariants(await this.db(), record.id)) {
      variants[variant.name] = {
        url:
          visibility === 'public'
            ? `${base}${plainDeliveryPath(record.id, variant.name)}`
            : signed(variant.name),
        expiresAt: new Date(exp * 1000).toISOString(),
        mimeType: variant.mimeType,
        bytes: variant.bytes,
        variantId: variant.id,
        ...(variant.width ? { width: variant.width } : {}),
        ...(variant.height ? { height: variant.height } : {}),
      };
    }
    const original = {
      url: originalUrl,
      expiresAt: new Date(exp * 1000).toISOString(),
      mimeType: record.detectedMime ?? record.declaredMime,
      bytes: row?.bytes ?? record.bytes,
    };
    const versions = {
      _original: original,
      ...variants,
    };
    const asset = toAssetInfo(record, { detailed: true, originalUrl });
    for (const [name, target] of Object.entries(versions)) {
      const version = asset.versions[name];
      if (version) version.url = target.url;
    }
    return {
      id: record.id,
      assetId: record.id,
      status: record.processingState,
      original,
      variants,
      versions,
      asset,
    };
  }

  async openOriginal(
    token: string,
    range?: { start: number; end?: number },
    ip?: string,
  ): Promise<OpenedContent> {
    const claims = verifyDeliveryToken(token, this.signingKeys());
    if (claims.ip && claims.ip !== ip) {
      throw fail('DELIVERY_IP_DENIED', {
        message: `This URL is bound to ${claims.ip}.`,
      });
    }
    const opened = await this.readDeliveredObject(
      claims.assetId,
      claims.version,
      claims.salt,
    );
    const storage = await this.driver();
    if (range) {
      const start = range.start;
      const end = range.end ?? opened.total - 1;
      this.assertRange(start, end, opened.total);
      const body = await storage.getObjectRange(opened.objectKey, start, end);
      return {
        ...opened,
        body,
        start,
        end,
        fileName: claims.download ?? opened.fileName,
      };
    }
    const stream = await storage.getObject(opened.objectKey);
    return {
      ...opened,
      body: stream,
      start: 0,
      end: opened.total - 1,
      fileName: claims.download ?? opened.fileName,
    };
  }

  async openPublic(
    assetId: string,
    version: string,
    range?: { start: number; end?: number },
  ): Promise<OpenedContent> {
    const sql = await this.db();
    const row = await sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
      [assetId],
    );
    if (!row || row.visibility !== 'public') {
      throw fail('DELIVERY_PRIVATE', {
        message: 'A missing or private asset is not served from /public.',
      });
    }
    const opened = await this.readDeliveredObject(
      assetId,
      versionTokenName(version),
      row.url_salt ?? '',
      true,
    );
    const storage = await this.driver();
    if (range) {
      const start = range.start;
      const end = range.end ?? opened.total - 1;
      this.assertRange(start, end, opened.total);
      const body = await storage.getObjectRange(opened.objectKey, start, end);
      return { ...opened, body, start, end };
    }
    const stream = await storage.getObject(opened.objectKey);
    return { ...opened, body: stream, start: 0, end: opened.total - 1 };
  }

  async signUrl(
    assetId: string,
    options: {
      version?: string;
      expiresIn?: number;
      download?: string;
      ip?: string;
      baseUrl?: string;
    },
    ctx: RequestContext,
  ): Promise<{ url: string; expiresAt: string }> {
    await this.get(assetId, ctx);
    const row = await (
      await this.db()
    ).get<FileRow>('SELECT * FROM files WHERE id = ?', [assetId]);
    if (!row) throw fail('DELIVERY_NOT_FOUND');
    const ttl = options.expiresIn ?? this.config.delivery.urlTtlSeconds;
    if (ttl < 30 || ttl > 86_400) {
      throw fail('INVALID_CONFIG', {
        message: 'Delivery TTL is outside the allowed range.',
      });
    }
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const pathName = this.contentPath(
      assetId,
      versionTokenName(options.version ?? '_original'),
      row.url_salt ?? '',
      exp,
      options.download,
      options.ip,
    );
    await this.touchAccess(assetId);
    const base = (
      options.baseUrl ??
      this.config.publicBaseUrl ??
      'http://localhost'
    ).replace(/\/$/, '');
    return {
      url: `${base}${pathName}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async setVisibility(
    assetId: string,
    visibility: Visibility,
    ctx: RequestContext,
  ): Promise<FileRecord> {
    if (visibility !== 'public' && visibility !== 'private') {
      throw fail('INVALID_CONFIG', {
        message: 'visibility must be public or private.',
      });
    }
    await this.get(assetId, ctx);
    const next = this.resolveVisibility(visibility);
    await (
      await this.db()
    ).run('UPDATE files SET visibility = ?, updated_at = ? WHERE id = ?', [
      next,
      nowIso(),
      assetId,
    ]);
    return this.get(assetId, ctx);
  }

  async revokeUrls(
    assetId: string,
    ctx: RequestContext,
  ): Promise<{ assetId: string; revoked: true }> {
    await this.get(assetId, ctx);
    await (
      await this.db()
    ).run('UPDATE files SET url_salt = ?, updated_at = ? WHERE id = ?', [
      this.freshSalt(),
      nowIso(),
      assetId,
    ]);
    return { assetId, revoked: true };
  }

  private contentPath(
    assetId: string,
    version: string,
    salt: string,
    exp: number,
    download?: string,
    ip?: string,
  ): string {
    const token = signDeliveryToken(this.signingKeys()[0] ?? '', {
      assetId,
      version: versionTokenName(version),
      exp,
      salt,
      ...(download ? { download } : {}),
      ...(ip ? { ip } : {}),
    });
    return `/content/${token}`;
  }

  private async touchAccess(assetId: string): Promise<void> {
    await (
      await this.db()
    )
      .run(
        'UPDATE files SET last_accessed_at = ?, updated_at = ? WHERE id = ?',
        [nowIso(), nowIso(), assetId],
      )
      .catch(() => undefined);
  }

  private assertRange(start: number, end: number, total: number): void {
    if (start < 0 || start >= total || end < start || end >= total) {
      throw fail('INVALID_CONFIG', {
        message: 'The requested byte range is outside the object.',
      });
    }
  }

  private async readDeliveredObject(
    assetId: string,
    version: string,
    salt: string,
    skipSalt = false,
  ): Promise<{
    record: FileRecord;
    objectKey: string;
    total: number;
    contentType: string;
    fileName: string;
  }> {
    const sql = await this.db();
    const row = await sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
      [assetId],
    );
    if (!row?.original_object_key) throw fail('DELIVERY_NOT_FOUND');
    if (!skipSalt && (row.url_salt ?? '') !== salt) {
      throw fail('DELIVERY_REVOKED');
    }
    let objectKey = row.original_object_key;
    let total = row.bytes;
    let contentType = row.detected_mime ?? row.declared_mime;
    if (version !== 'original' && version !== '_original') {
      const variant =
        (await sql.get<{
          storage_key: string;
          bytes: number;
          mime: string;
        }>(
          `SELECT storage_key, bytes, mime FROM variants WHERE file_id = ? AND name = ? AND status = 'ready'`,
          [assetId, version],
        )) ??
        (await sql.get<{
          storage_key: string;
          bytes: number;
          mime: string;
        }>(
          `SELECT storage_key, bytes, mime FROM variants WHERE id = ? AND file_id = ? AND status = 'ready'`,
          [version, assetId],
        ));
      if (!variant) throw fail('DELIVERY_NOT_FOUND');
      objectKey = variant.storage_key;
      total = variant.bytes;
      contentType = variant.mime;
    }
    await this.touchAccess(assetId);
    return {
      record: mapFile(row),
      objectKey,
      total,
      contentType,
      fileName: safeDownloadName(row.original_name),
    };
  }

  private async requireSession(
    id: string,
    principal: Principal,
  ): Promise<SessionRow> {
    const row = await (
      await this.db()
    ).get<SessionRow>(
      'SELECT * FROM upload_sessions WHERE id = ? AND tenant_id = ? AND owner_id = ?',
      [id, principal.tenantId, principal.id],
    );
    if (!row) throw fail('NOT_FOUND');
    return row;
  }

  private async assertSessionOpen(session: SessionRow): Promise<void> {
    if (session.status === 'aborted' || session.status === 'expired')
      throw fail('UPLOAD_SESSION_EXPIRED');
    if (Date.parse(session.expires_at) <= Date.now()) {
      await (
        await this.db()
      ).run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'expired',
        session.id,
      ]);
      throw fail('UPLOAD_SESSION_EXPIRED');
    }
  }

  private async assertQuota(tenantId: string, incoming: number): Promise<void> {
    const quota = this.config.defaults.tenantQuotaBytes;
    if (!quota) return;
    const files = await (
      await this.db()
    ).get<{ total: number }>(
      'SELECT COALESCE(SUM(bytes), 0) AS total FROM files WHERE tenant_id = ? AND deleted_at IS NULL',
      [tenantId],
    );
    if (Number(files?.total ?? 0) + incoming > quota)
      throw fail('QUOTA_EXCEEDED');
  }

  private resolveVisibility(requested: Visibility | undefined): Visibility {
    if (requested === 'public') {
      if (!this.config.defaults.allowPublicFiles) {
        throw fail('FORBIDDEN', { message: 'Public files are disabled.' });
      }
      return 'public';
    }
    return 'private';
  }

  private async acceptOriginal(
    fileId: string,
    key: string,
    mime: string,
    bytes: number,
    body?: Uint8Array,
  ): Promise<boolean> {
    assertDetectedSize(
      mime,
      bytes,
      this.config.safety.typeMaxBytes,
      this.config.defaults.maxFileBytes,
    );
    const scanner = this.config.safety.scanner;
    if (!scanner) return true;
    try {
      const storage = await this.driver();
      const scanBytes =
        body ??
        (storage.localPath
          ? undefined
          : await readAll(await storage.getObject(key)));
      const verdict = await scanner.scan({
        assetId: fileId,
        mime,
        ...(scanBytes ? { bytes: scanBytes } : {}),
        ...(storage.localPath && !body ? { path: storage.localPath(key) } : {}),
      });
      if (verdict === 'infected') {
        await this.quarantine(fileId, key, 'MALWARE_DETECTED');
        return false;
      }
      return true;
    } catch (error) {
      const code = isFileSdkError(error) ? error.code : 'MALWARE_SCAN_FAILED';
      await this.quarantine(
        fileId,
        key,
        code === 'MALWARE_DETECTED'
          ? 'MALWARE_DETECTED'
          : 'MALWARE_SCAN_FAILED',
      );
      return false;
    }
  }

  private async quarantine(
    fileId: string,
    key: string,
    code: 'MALWARE_DETECTED' | 'MALWARE_SCAN_FAILED',
  ): Promise<void> {
    if (key && this.config.storage.driver === 'filesystem') {
      const { mkdir, rename } = await import('node:fs/promises');
      const held = path.join(
        this.root(),
        '.filevora',
        'quarantine',
        path.basename(key),
      );
      await mkdir(path.dirname(held), { recursive: true });
      await rename(path.join(this.root(), key), held).catch(() => undefined);
    } else if (key) {
      await this.storage?.deleteObject(key).catch(() => undefined);
    }
    await (
      await this.db()
    ).run(
      `UPDATE files SET upload_state = 'expired', processing_state = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
      [
        code === 'MALWARE_DETECTED' ? 'quarantined' : 'failed',
        JSON.stringify({ filevoraSafetyError: code }),
        nowIso(),
        fileId,
      ],
    );
  }

  /** Queue or refresh a Gemini description. Stored mode and a key are required. */
  async describeAsset(
    fileId: string,
    ctx: RequestContext,
  ): Promise<FileRecord> {
    await this.get(fileId, ctx);
    describeIntent(true, this.config);
    await this.markDescribe(fileId);
    await this.finishDescribe(fileId, { retrigger: true });
    return this.get(fileId, ctx);
  }

  private async markDescribe(fileId: string): Promise<void> {
    await (
      await this.db()
    ).run(
      `UPDATE files SET describe_requested = 1, description_status = 'pending', description_error = NULL, updated_at = ? WHERE id = ?`,
      [nowIso(), fileId],
    );
  }

  private async finishDescribe(
    fileId: string,
    opts: { retrigger?: boolean } = {},
  ): Promise<void> {
    if (this.config.metadata.mode !== 'stored') return;
    try {
      const row = await (
        await this.db()
      ).get<{
        detected_mime: string | null;
        declared_mime: string;
        processing_state: string;
      }>(
        'SELECT detected_mime, declared_mime, processing_state FROM files WHERE id = ?',
        [fileId],
      );
      const mime = row?.detected_mime || row?.declared_mime || '';
      const media = /^(image|video|audio)\//.test(mime);
      // Media is described when its optimized variant finishes, unless it already finished.
      if (media && !(opts.retrigger && row?.processing_state === 'ready')) {
        return;
      }
      await enqueueAssetDescription(
        await this.db(),
        await this.driver(),
        this.config,
        fileId,
        {
          allowOriginal: true,
          ...(opts.retrigger ? { retrigger: true } : {}),
        },
      );
    } catch {
      // The asset stays available when a description cannot be queued.
    }
  }

  private async enqueuePreset(
    fileId: string,
    mime: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    const row = await (
      await this.db()
    ).get<{ preset: string | null }>('SELECT preset FROM files WHERE id = ?', [
      fileId,
    ]);
    const action = presetQueueAction(
      row?.preset || this.config.defaults.preset,
      mime,
      this.config.presets,
    );
    if (action === 'skip') return false;
    await this.queueWebhook(fileId, ctx, 'upload.completed');
    const sync = this.config.processing.mode === 'sync';
    await this.dispatchJob({
      id: sync ? `inline_${fileId}` : `preset_${fileId}`,
      fileId,
      tenantId: ctx.principal.tenantId,
      type: 'preset',
      payload: { schemaVersion: 1 },
      maxAttempts: this.config.queue.maxAttempts,
    });
    if (!sync) {
      await (
        await this.db()
      ).run(
        `UPDATE files SET processing_state = 'queued', updated_at = ? WHERE id = ? AND processing_state = 'none'`,
        [nowIso(), fileId],
      );
    }
    return true;
  }

  private async checkedWebhook(
    request: WebhookRequest | undefined,
  ): Promise<Record<string, string>> {
    if (!request?.url && !this.config.webhooks.url) return {};
    const url = request?.url ?? this.config.webhooks.url;
    if (!url) return {};
    await assertWebhookUrl(url, this.config);
    const secret = request?.secret || this.config.webhooks.secret;
    if (!secret) {
      throw fail('WEBHOOK_REJECTED', {
        message:
          'A webhook URL needs a secret, from the request or FILEVORA_WEBHOOK_SECRET.',
      });
    }
    return webhookFields(
      { url, ...(request?.secret ? { secret: request.secret } : {}) },
      this.config.webhooks.secret,
    );
  }

  private async queueWebhook(
    fileId: string,
    ctx: RequestContext,
    event: WebhookEventName,
  ): Promise<void> {
    const row = await (
      await this.db()
    ).get<{ metadata_json: string }>(
      'SELECT metadata_json FROM files WHERE id = ?',
      [fileId],
    );
    const meta = safeMeta(row?.metadata_json);
    const url = meta.filevoraWebhookUrl || this.config.webhooks.url;
    const secret = meta.filevoraWebhookSecret || this.config.webhooks.secret;
    if (!url || !secret) return;
    const progress = await this.processingSnapshot(fileId, ctx, {
      baseUrl: this.config.publicBaseUrl ?? 'http://localhost',
    });
    await enqueueWebhookJob({
      config: this.config,
      fileId,
      tenantId: ctx.principal.tenantId,
      event,
      url,
      secret,
      body: JSON.stringify(progress),
    });
    if (this.config.processing.mode !== 'sync') this.ensureWorker();
  }

  /** BullMQ in every mode except test `sync`, which finishes the job before returning. */
  private async dispatchJob(input: {
    id: string;
    fileId: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    maxAttempts: number;
  }): Promise<void> {
    if (this.config.processing.mode === 'sync') {
      try {
        await executeProcessingJob(
          await this.db(),
          {
            id: input.id,
            data: {
              fileId: input.fileId,
              tenantId: input.tenantId,
              type: input.type,
              payload: input.payload,
              schemaVersion: 1,
            },
            opts: { attempts: input.maxAttempts },
            attemptsMade: 0,
          },
          this.config,
        );
      } catch {
        // The job records the failed asset before throwing.
      }
      return;
    }
    await enqueueProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id: input.id,
      fileId: input.fileId,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
      backoffMs: this.config.queue.backoffBaseMs,
      scope: this.config.storage.root,
    });
    this.ensureWorker();
  }

  private async mapSession(row: SessionRow): Promise<UploadSession> {
    const parts = await (
      await this.db()
    ).all<PartRow>(
      'SELECT * FROM upload_parts WHERE upload_session_id = ? ORDER BY part_number ASC',
      [row.id],
    );
    return {
      id: row.id,
      assetId: row.file_id,
      fileId: row.file_id,
      tenantId: row.tenant_id,
      ownerId: row.owner_id,
      status: row.status as UploadSession['status'],
      transport:
        row.transport === 's3-multipart' ? 's3-multipart' : 'chunked-http',
      partSize: row.part_size,
      declaredBytes: row.declared_bytes,
      partCount: row.part_count,
      expiresAt: row.expires_at,
      receivedParts: parts.map(mapPart),
    };
  }

  private async audit(
    sql: Sql,
    principal: Principal,
    fileId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await sql.run(
      `INSERT INTO audit_events (id, tenant_id, file_id, action, actor_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('aud'),
        principal.tenantId,
        fileId,
        action,
        principal.id,
        JSON.stringify(details),
        nowIso(),
      ],
    );
  }
}

function mapPart(row: PartRow): UploadPartRecord {
  return {
    partNumber: row.part_number,
    etag: row.etag,
    bytes: row.bytes,
    checksum: row.checksum,
    completedAt: row.completed_at,
  };
}

async function loadVariants(sql: Sql, fileId: string): Promise<FileVariant[]> {
  const rows = await sql.all<{
    id: string;
    file_id: string;
    name: string;
    recipe_id: string;
    recipe_version: number;
    mime: string;
    bytes: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    checksum: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id, file_id, name, recipe_id, recipe_version, mime, bytes, width, height, duration_ms, checksum, status, created_at
     FROM variants WHERE file_id = ? AND status = 'ready' ORDER BY name ASC`,
    [fileId],
  );
  return rows.map((row) => ({
    id: row.id,
    fileId: row.file_id,
    name: row.name,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    mimeType: row.mime,
    bytes: row.bytes,
    ...(row.width ? { width: row.width } : {}),
    ...(row.height ? { height: row.height } : {}),
    ...(row.duration_ms ? { durationMs: row.duration_ms } : {}),
    checksum: row.checksum,
    status: 'ready' as const,
    createdAt: row.created_at,
  }));
}

async function attachTags(sql: Sql, record: FileRecord): Promise<void> {
  if (!record.description) return;
  const tags = await sql
    .all<{ tag: string; category: string }>(
      'SELECT tag, category FROM filevora_asset_tags WHERE asset_id = ? ORDER BY category, tag',
      [record.id],
    )
    .catch(() => []);
  record.description.tags = tags;
}

function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    originalName: row.original_name,
    declaredMime: row.declared_mime,
    detectedMime: row.detected_mime,
    bytes: row.bytes,
    checksum: row.checksum,
    visibility: row.visibility === 'public' ? 'public' : 'private',
    uploadState: row.upload_state as FileRecord['uploadState'],
    processingState: row.processing_state as FileRecord['processingState'],
    preset: row.preset,
    metadata: publicMetadata(row.metadata_json),
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    ...(row.describe_requested || row.description_status
      ? {
          description: {
            long: row.description_long ?? null,
            short: row.description_short ?? null,
            status:
              row.description_status === 'pending' ||
              row.description_status === 'done' ||
              row.description_status === 'failed'
                ? row.description_status
                : null,
            error: row.description_error ?? null,
            describedAt: row.described_at ?? null,
            model: row.description_model ?? null,
            tags: [],
          },
        }
      : {}),
    variants: [],
  };
}

function publicMetadata(raw: string): Record<string, string> {
  const metadata = safeMeta(raw);
  delete metadata.filevoraWebhookSecret;
  return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUploadFields(input: {
  filename: unknown;
  mimeType: unknown;
  bytes: unknown;
}): void {
  if (
    typeof input?.filename !== 'string' ||
    !input.filename ||
    typeof input.mimeType !== 'string' ||
    !input.mimeType ||
    typeof input.bytes !== 'number' ||
    !Number.isFinite(input.bytes)
  ) {
    throw fail('INVALID_CONFIG', {
      message: 'filename, mimeType, and bytes are required.',
    });
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function webhookRequest(value: unknown): WebhookRequest | undefined {
  if (!isRecord(value) || typeof value.url !== 'string') return undefined;
  return {
    url: value.url,
    ...(typeof value.secret === 'string' ? { secret: value.secret } : {}),
  };
}

function withoutWebhook(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...value };
  delete next.webhook;
  return next;
}

function safeMeta(raw: string | null | undefined): Record<string, string> {
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

function remoteFilename(raw: string): string {
  try {
    const name = new URL(raw).pathname.split('/').pop() ?? '';
    return name.length > 0 ? name : 'remote';
  } catch {
    return 'remote';
  }
}

function isMostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if (byte === 0) return false;
  }
  return true;
}

function compatibleMime(declared: string, detected: string): boolean {
  if (
    (declared ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      declared ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      declared ===
        'application/vnd.openxmlformats-officedocument.presentationml.presentation') &&
    detected === 'application/zip'
  ) {
    return true;
  }
  return false;
}

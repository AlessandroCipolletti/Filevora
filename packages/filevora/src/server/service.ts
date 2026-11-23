import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import {
  addSeconds,
  assetObjectKey,
  createId,
  extensionForMime,
  nowIso,
  sha256,
} from '../ids.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite, type Sql } from '../metadata/sqlite.js';
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
import { streamsDetailedProgress } from '../progress/estimate.js';
import {
  closeProcessingQueue,
  enqueueProcessingJob,
  readProcessingJob,
  readProcessingProgress,
  removeProcessingJob,
} from '../queue/processing-queue.js';
import { planRetention, type RetentionRow } from '../retention/plan.js';
import { assertUnexpired, readToken, signToken } from '../security/token.js';
import {
  concatFiles,
  createFilesystemStorage,
  readObjectRange,
  readPrefix,
  writeBytes,
} from '../storage/filesystem.js';
import type {
  DeliveryResult,
  FileRecord,
  FileVariant,
  Page,
  Principal,
  ProcessingJob,
  StorageDriver,
  UploadPartRecord,
  UploadSession,
  Visibility,
} from '../types/index.js';
import { ensureEmbeddedWorker } from '../worker/supervisor.js';

export interface RequestContext {
  principal: Principal;
  /** Server policy owner. Ignored when absent. Never taken from the browser body. */
  ownerId?: string;
}

export interface CreateSessionInput {
  filename: string;
  mimeType: string;
  bytes: number;
  checksum?: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  preset?: string;
  visibility?: Visibility;
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
  private secret: string | undefined;
  private worker: ChildProcess | undefined;

  constructor(readonly config: ResolvedConfig) {}

  private db(): Sql {
    if (this.sql) return this.sql;
    if (this.config.metadata.driver !== 'sqlite') {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'Only SQLite metadata is implemented.',
        context: { driver: this.config.metadata.driver },
      });
    }
    if (this.config.storage.driver === 'filesystem') {
      const root = path.resolve(this.config.storage.root);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.storage = createFilesystemStorage(root);
    } else if (this.config.storage.driver === 's3') {
      // The S3 client is loaded on the first S3 call so filesystem installs do not require the AWS SDK.
    } else {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'That storage driver is not available.',
        context: { driver: this.config.storage.driver },
      });
    }
    this.sql = openSqlite(this.config.metadata.filename);
    migrate(this.sql);
    this.secret = this.loadSecret(this.sql);
    return this.sql;
  }

  private loadSecret(sql: Sql): string {
    if (this.config.signingSecret) return this.config.signingSecret;
    const existing = sql.get<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      ['signing_secret'],
    );
    if (existing?.value) return existing.value;
    const value = randomBytes(32).toString('base64url');
    sql.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'signing_secret',
      value,
    ]);
    return value;
  }

  private root(): string {
    this.db();
    return path.resolve(this.config.storage.root);
  }

  async close(): Promise<void> {
    if (this.worker && !this.worker.killed) this.worker.kill('SIGTERM');
    this.sql?.close();
    this.sql = undefined;
    await closeProcessingQueue({
      env: this.config.env,
      scope: this.config.metadata.filename,
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
    await enqueueProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id,
      fileId,
      tenantId: ctx.principal.tenantId,
      type,
      payload: {
        schemaVersion: 1,
        ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
        ...(input.transforms ? { transforms: input.transforms } : {}),
      },
      maxAttempts: this.config.queue.maxAttempts,
      backoffMs: this.config.queue.backoffBaseMs,
      scope: this.config.metadata.filename,
    });
    this.db().run(
      `UPDATE files SET processing_state = 'queued', updated_at = ? WHERE id = ?`,
      [now, fileId],
    );
    this.ensureWorker();
    return {
      id,
      fileId,
      tenantId: ctx.principal.tenantId,
      type,
      state: 'queued',
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

  async touch(fileId: string, ctx: RequestContext): Promise<void> {
    await this.get(fileId, ctx);
    const now = nowIso();
    this.db().run(
      'UPDATE files SET last_touch_at = ?, updated_at = ? WHERE id = ?',
      [now, now, fileId],
    );
  }

  async retentionSweep(opts: { dryRun?: boolean } = {}, ctx: RequestContext) {
    const rows = this.db().all<RetentionRow>(
      `SELECT id, bytes, pinned, created_at, deleted_at, grace_until, last_touch_at, original_object_key
       FROM files WHERE tenant_id = ?`,
      [ctx.principal.tenantId],
    );
    const plan = planRetention(rows, this.config.retention, Date.now());
    let filesDeleted = 0;
    if (!opts.dryRun) {
      for (const item of plan) {
        const row = rows.find((candidate) => candidate.id === item.fileId);
        if (!row) continue;
        const now = nowIso();
        const immediate =
          item.reason === 'grace-elapsed' ||
          this.config.retention.gracePeriodDays === 0;
        if (
          immediate &&
          row.original_object_key &&
          this.config.storage.driver === 'filesystem'
        ) {
          const { rm } = await import('node:fs/promises');
          await rm(path.join(this.root(), row.original_object_key), {
            force: true,
          });
          filesDeleted += 1;
        }
        const grace = new Date(
          Date.now() + this.config.retention.gracePeriodDays * 86_400_000,
        ).toISOString();
        this.db().run(
          `UPDATE files SET deleted_at = COALESCE(deleted_at, ?), grace_until = ?, original_object_key = CASE WHEN ? THEN NULL ELSE original_object_key END,
           processing_state = CASE WHEN ? THEN 'deleted' ELSE processing_state END, updated_at = ? WHERE id = ?`,
          [
            now,
            immediate ? now : grace,
            immediate ? 1 : 0,
            immediate ? 1 : 0,
            now,
            row.id,
          ],
        );
        this.audit(
          this.db(),
          ctx.principal,
          row.id,
          immediate ? 'retention.delete' : 'retention.soft',
          { reason: item.reason },
        );
      }
    }
    return {
      dryRun: Boolean(opts.dryRun),
      filesEligible: plan.length,
      bytesEligible: plan.reduce((sum, item) => sum + item.bytes, 0),
      filesDeleted,
      items: plan.map((item) => ({
        fileId: item.fileId,
        bytes: item.bytes,
        reason: item.reason,
      })),
    };
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
    const row = this.db().get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ?',
      [fileId, ctx.principal.tenantId],
    );
    if (!row?.original_object_key) throw fail('NOT_FOUND');
    if (this.config.storage.driver !== 'filesystem') {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'Normalization currently reads filesystem originals.',
      });
    }
    const bytes = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(this.root(), row.original_object_key ?? '')),
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
        await writeBytes(this.root(), previewKey, preview.png);
        this.db().run(
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
    await writeBytes(this.root(), key, payload);
    this.db().run(
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
      scope: this.config.metadata.filename,
    });
    this.db().run(
      `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
      [nowIso(), job.fileId],
    );
    return { ...job, state: 'cancelled' };
  }

  async processingSnapshot(fileId: string, ctx: RequestContext) {
    const record = await this.get(fileId, ctx);
    const progress = await readProcessingProgress(fileId);
    const quiet = !streamsDetailedProgress(record.detectedMime);
    const fileDone =
      record.processingState === 'none' ||
      record.processingState === 'ready' ||
      record.processingState === 'partially_ready' ||
      record.processingState === 'failed' ||
      record.processingState === 'deleted';
    return {
      fileId,
      state: record.processingState,
      percentage:
        progress.ratio == null ? null : Math.round(progress.ratio * 100),
      etaMs: quiet ? null : progress.etaMs,
      quiet,
      terminal: fileDone,
    };
  }

  async getJob(jobId: string, ctx: RequestContext): Promise<ProcessingJob> {
    const job = await readProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id: jobId,
      scope: this.config.metadata.filename,
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
    const started = ensureEmbeddedWorker(this.db(), this.config);
    if (started.child) this.worker = started.child;
    return started.pid;
  }

  async createUploadSession(
    input: CreateSessionInput,
    ctx: RequestContext,
  ): Promise<UploadSession> {
    const sql = this.db();
    const filename = sanitizeFilename(input.filename);
    const mimeType = input.mimeType.toLowerCase();
    if (
      !Number.isInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > this.config.defaults.maxFileBytes
    ) {
      throw fail('FILE_TOO_LARGE');
    }
    if (!mimeAllowed(mimeType, this.config.defaults.allowedMimeTypes))
      throw fail('UNSUPPORTED_MIME');
    if (input.checksum && !/^[a-f0-9]{64}$/i.test(input.checksum)) {
      throw fail('CHECKSUM_MISMATCH', {
        message: 'checksum must be a SHA-256 hex digest.',
      });
    }
    let metadata: Record<string, string>;
    try {
      metadata = metadataObject(input.metadata);
    } catch (error) {
      throw fail('INVALID_CONFIG', {
        message: error instanceof Error ? error.message : 'Invalid metadata.',
      });
    }
    const preset = input.preset ?? this.config.defaults.preset;
    const visibility = this.resolveVisibility(input.visibility);
    this.assertQuota(ctx.principal.tenantId, input.bytes);
    if (input.idempotencyKey) {
      const existing = sql.get<SessionRow>(
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
        return this.mapSession(existing);
      }
    }
    const now = nowIso();
    const fileId = createId('file');
    const sessionId = createId('upl');
    const partSize = this.config.upload.chunkBytes;
    const partCount = Math.ceil(input.bytes / partSize);
    if (partCount > 10_000) throw fail('FILE_TOO_LARGE');
    const expiresAt = addSeconds(now, this.config.upload.sessionTtlSeconds);
    sql.transaction(() => {
      sql.run(
        `INSERT INTO files (
          id, tenant_id, owner_id, original_name, declared_mime, detected_mime, bytes, checksum,
          original_object_key, visibility, upload_state, processing_state, preset, metadata_json,
          pinned, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, 'authorized', 'none', ?, ?, 0, ?, ?, NULL)`,
        [
          fileId,
          ctx.principal.tenantId,
          ctx.ownerId && ctx.ownerId.length > 0
            ? ctx.ownerId
            : ctx.principal.id,
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
      sql.run(
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
      this.audit(sql, ctx.principal, fileId, 'session.create', { sessionId });
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
      sql.run(
        'UPDATE upload_sessions SET storage_upload_id = ?, object_key = ? WHERE id = ?',
        [upload.uploadId, key, sessionId],
      );
    }
    const created = sql.get<SessionRow>(
      'SELECT * FROM upload_sessions WHERE id = ?',
      [sessionId],
    );
    if (!created)
      throw fail('STORAGE_UNAVAILABLE', {
        message: 'The upload session was not stored.',
      });
    return this.mapSession(created);
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
    const session = this.requireSession(sessionId, ctx.principal);
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
      !(
        session.declared_mime ===
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
        detected === 'application/zip'
      )
    ) {
      throw fail('MIME_MISMATCH', {
        context: { declared: session.declared_mime, detected },
      });
    }
    if (input.checksum && input.checksum.toLowerCase() !== checksum)
      throw fail('CHECKSUM_MISMATCH');
    const now = nowIso();
    this.db().transaction(() => {
      this.db().run(
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
      this.db().run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'verified',
        session.id,
      ]);
      this.audit(this.db(), ctx.principal, session.file_id, 'upload.complete', {
        checksum,
        transport: 's3-multipart',
      });
    });
    await this.enqueuePreset(session.file_id, detected, ctx);
    return this.get(session.file_id, ctx);
  }

  async getUploadSession(
    id: string,
    ctx: RequestContext,
  ): Promise<UploadSession> {
    return this.mapSession(this.requireSession(id, ctx.principal));
  }

  async writePart(
    sessionId: string,
    partNumber: number,
    body: Uint8Array,
    ctx: RequestContext,
  ): Promise<{ partNumber: number; etag: string; bytes: number }> {
    const sql = this.db();
    const session = this.requireSession(sessionId, ctx.principal);
    this.assertSessionOpen(session);
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
    await writeBytes(this.root(), key, body);
    const etag = sha256(body);
    const now = nowIso();
    sql.transaction(() => {
      sql.run(
        'DELETE FROM upload_parts WHERE upload_session_id = ? AND part_number = ?',
        [session.id, partNumber],
      );
      sql.run(
        `INSERT INTO upload_parts (upload_session_id, part_number, etag, checksum, bytes, object_key, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [session.id, partNumber, etag, etag, body.byteLength, key, now],
      );
      sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'uploading',
        session.id,
      ]);
      sql.run(
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
    const sql = this.db();
    const session = this.requireSession(sessionId, ctx.principal);
    if (session.status === 'verified') return this.get(session.file_id, ctx);
    this.assertSessionOpen(session);
    if (session.transport === 's3-multipart')
      return this.completeS3(session, input, ctx);
    const parts = sql.all<PartRow>(
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
    const prefix = await readPrefix(this.root(), parts[0]?.object_key ?? '');
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
      throw fail('UNSUPPORTED_MIME');
    }
    const originalKey = assetObjectKey(
      session.tenant_id,
      session.file_id,
      'original',
      extensionForMime(detected),
    );
    const assembled = await concatFiles(
      this.root(),
      parts.map((part) => part.object_key),
      originalKey,
    );
    if (assembled.bytes !== session.declared_bytes)
      throw fail('UPLOAD_SIZE_MISMATCH');
    const expectedChecksum = (
      input.checksum ?? session.checksum
    )?.toLowerCase();
    if (expectedChecksum && expectedChecksum !== assembled.checksum) {
      await this.storage?.deleteObject(originalKey);
      throw fail('CHECKSUM_MISMATCH');
    }
    const now = nowIso();
    sql.transaction(() => {
      sql.run(
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
      sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'verified',
        session.id,
      ]);
      this.audit(sql, ctx.principal, session.file_id, 'upload.complete', {
        checksum: assembled.checksum,
      });
    });
    for (const part of parts) {
      await this.storage?.deleteObject(part.object_key);
    }
    await this.enqueuePreset(session.file_id, detected, ctx);
    return this.get(session.file_id, ctx);
  }

  async abortUpload(sessionId: string, ctx: RequestContext): Promise<void> {
    const sql = this.db();
    const session = this.requireSession(sessionId, ctx.principal);
    if (session.status === 'verified')
      throw fail('INVALID_CONFIG', {
        message: 'A verified upload cannot be aborted.',
      });
    const parts = sql.all<PartRow>(
      'SELECT * FROM upload_parts WHERE upload_session_id = ?',
      [session.id],
    );
    for (const part of parts) await this.storage?.deleteObject(part.object_key);
    const now = nowIso();
    sql.transaction(() => {
      sql.run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'aborted',
        session.id,
      ]);
      sql.run(
        `UPDATE files SET upload_state = 'aborted', deleted_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, session.file_id],
      );
      this.audit(sql, ctx.principal, session.file_id, 'session.abort', {});
    });
  }

  async get(fileId: string, ctx: RequestContext): Promise<FileRecord> {
    const row = this.db().get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [fileId, ctx.principal.tenantId],
    );
    if (!row || row.upload_state === 'aborted') throw fail('NOT_FOUND');
    const record = mapFile(row);
    record.variants = loadVariants(this.db(), row.id);
    return record;
  }

  async listAssetIds(
    query: { limit?: number; cursor?: string },
    ctx: RequestContext,
  ): Promise<{ assetIds: string[]; nextCursor: string | null }> {
    const page = await this.list(query, ctx);
    return {
      assetIds: page.items.map((item) => item.id),
      nextCursor: page.nextCursor,
    };
  }

  async list(
    query: { limit?: number; cursor?: string },
    ctx: RequestContext,
  ): Promise<Page<FileRecord>> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const params: unknown[] = [ctx.principal.tenantId];
    let where =
      "tenant_id = ? AND deleted_at IS NULL AND upload_state = 'verified'";
    if (cursor) {
      where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);
    const rows = this.db().all<FileRow>(
      `SELECT * FROM files WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
    const page = rows.slice(0, limit).map((row) => {
      const record = mapFile(row);
      record.variants = loadVariants(this.db(), row.id);
      return record;
    });
    const last = page[page.length - 1];
    const next =
      rows.length > limit && last
        ? encodeCursor(last.createdAt, last.id)
        : null;
    return { items: page, nextCursor: next };
  }

  async delete(fileId: string, ctx: RequestContext): Promise<void> {
    const sql = this.db();
    const row = sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [fileId, ctx.principal.tenantId],
    );
    if (!row) throw fail('NOT_FOUND');
    if (row.original_object_key)
      await this.storage?.deleteObject(row.original_object_key);
    const now = nowIso();
    sql.transaction(() => {
      sql.run(
        `UPDATE files SET deleted_at = ?, processing_state = 'deleted', updated_at = ? WHERE id = ?`,
        [now, now, row.id],
      );
      this.audit(sql, ctx.principal, row.id, 'file.delete', {});
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
    const ttl = input.expiresInSeconds ?? this.config.delivery.urlTtlSeconds;
    if (ttl < 30 || ttl > 86_400)
      throw fail('INVALID_CONFIG', {
        message: 'Delivery TTL is outside the allowed range.',
      });
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = signToken(this.secret ?? '', {
      f: record.id,
      n: 'original',
      exp,
    });
    const base = input.baseUrl.replace(/\/$/, '');
    let originalUrl = `${base}/content/${token}`;
    if (this.config.storage.driver === 's3') {
      const stored = this.db().get<FileRow>(
        'SELECT * FROM files WHERE id = ?',
        [record.id],
      );
      const storage = await this.s3();
      if (stored?.original_object_key && storage.signDownload) {
        const signed = await storage.signDownload({
          key: stored.original_object_key,
          expiresInSeconds: ttl,
          contentType: record.detectedMime ?? record.declaredMime,
          fileName: record.originalName,
        });
        originalUrl = signed.url;
      }
    }
    const row = this.db().get<FileRow>('SELECT * FROM files WHERE id = ?', [
      record.id,
    ]);
    const variants: DeliveryResult['variants'] = {};
    for (const variant of loadVariants(this.db(), record.id)) {
      const variantToken = signToken(this.secret ?? '', {
        f: record.id,
        n: variant.id,
        exp,
      });
      variants[variant.name] = {
        url: `${base}/content/${variantToken}`,
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
    return {
      id: record.id,
      assetId: record.id,
      status: record.processingState,
      original,
      variants,
      versions: {
        _original: original,
        ...variants,
      },
    };
  }

  async openOriginal(
    token: string,
    range?: { start: number; end?: number },
  ): Promise<{
    record: FileRecord;
    body: Uint8Array | ReadableStream<Uint8Array>;
    start: number;
    end: number;
    total: number;
    contentType: string;
  }> {
    const sql = this.db();
    const payload = readToken(this.secret ?? '', token);
    const kind = payload?.n;
    const fileId = payload?.f;
    const exp = payload?.exp;
    if (typeof kind !== 'string' || typeof fileId !== 'string') {
      throw fail('UNAUTHORIZED', {
        message: 'The delivery token is expired or invalid.',
      });
    }
    assertUnexpired(exp);
    const row = sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
      [fileId],
    );
    if (!row?.original_object_key) throw fail('NOT_FOUND');
    let objectKey = row.original_object_key;
    let total = row.bytes;
    let contentType = row.detected_mime ?? row.declared_mime;
    if (kind !== 'original') {
      const variant = sql.get<{
        storage_key: string;
        bytes: number;
        mime: string;
      }>(
        `SELECT storage_key, bytes, mime FROM variants WHERE id = ? AND file_id = ? AND status = 'ready'`,
        [kind, fileId],
      );
      if (!variant) throw fail('NOT_FOUND');
      objectKey = variant.storage_key;
      total = variant.bytes;
      contentType = variant.mime;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? total - 1;
    if (start < 0 || start >= total || end < start || end >= total) {
      throw fail('INVALID_CONFIG', {
        message: 'The requested byte range is outside the object.',
      });
    }
    if (range) {
      const body = await readObjectRange(this.root(), objectKey, start, end);
      return { record: mapFile(row), body, start, end, total, contentType };
    }
    const stream = await this.storage?.getObject(objectKey);
    if (!stream) throw fail('STORAGE_UNAVAILABLE');
    return {
      record: mapFile(row),
      body: stream,
      start,
      end,
      total,
      contentType,
    };
  }

  private requireSession(id: string, principal: Principal): SessionRow {
    const row = this.db().get<SessionRow>(
      'SELECT * FROM upload_sessions WHERE id = ? AND tenant_id = ? AND owner_id = ?',
      [id, principal.tenantId, principal.id],
    );
    if (!row) throw fail('NOT_FOUND');
    return row;
  }

  private assertSessionOpen(session: SessionRow): void {
    if (session.status === 'aborted' || session.status === 'expired')
      throw fail('UPLOAD_SESSION_EXPIRED');
    if (Date.parse(session.expires_at) <= Date.now()) {
      this.db().run('UPDATE upload_sessions SET status = ? WHERE id = ?', [
        'expired',
        session.id,
      ]);
      throw fail('UPLOAD_SESSION_EXPIRED');
    }
  }

  private assertQuota(tenantId: string, incoming: number): void {
    const quota = this.config.defaults.tenantQuotaBytes;
    if (!quota) return;
    const files = this.db().get<{ total: number }>(
      'SELECT COALESCE(SUM(bytes), 0) AS total FROM files WHERE tenant_id = ? AND deleted_at IS NULL',
      [tenantId],
    );
    if ((files?.total ?? 0) + incoming > quota) throw fail('QUOTA_EXCEEDED');
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

  private async enqueuePreset(
    fileId: string,
    mime: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (!/^(image|video|audio)\//.test(mime)) return;
    await enqueueProcessingJob({
      env: this.config.env,
      redisUrl: this.config.queue.redisUrl,
      id: `preset_${fileId}`,
      fileId,
      tenantId: ctx.principal.tenantId,
      type: 'preset',
      payload: { schemaVersion: 1 },
      maxAttempts: this.config.queue.maxAttempts,
      backoffMs: this.config.queue.backoffBaseMs,
      scope: this.config.metadata.filename,
    });
    this.db().run(
      `UPDATE files SET processing_state = 'queued', updated_at = ? WHERE id = ? AND processing_state = 'none'`,
      [nowIso(), fileId],
    );
    this.ensureWorker();
  }

  private mapSession(row: SessionRow): UploadSession {
    const parts = this.db().all<PartRow>(
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

  private audit(
    sql: Sql,
    principal: Principal,
    fileId: string,
    action: string,
    details: Record<string, unknown>,
  ): void {
    sql.run(
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

function loadVariants(sql: Sql, fileId: string): FileVariant[] {
  return sql
    .all<{
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
    )
    .map((row) => ({
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
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    variants: [],
  };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const splitAt = raw.indexOf('\n');
  if (splitAt <= 0)
    throw fail('INVALID_CONFIG', { message: 'The list cursor is invalid.' });
  return { createdAt: raw.slice(0, splitAt), id: raw.slice(splitAt + 1) };
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
    declared ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
    detected === 'application/zip'
  ) {
    return true;
  }
  return false;
}

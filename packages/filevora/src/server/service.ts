import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { addSeconds, createId, nowIso, sha256, tenantPath } from '../ids.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite, type Sql } from '../metadata/sqlite.js';
import {
  metadataObject,
  mimeAllowed,
  sanitizeFilename,
  sniffMime,
} from '../mime.js';
import { readToken, signToken } from '../security/token.js';
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
  Page,
  Principal,
  StorageDriver,
  UploadPartRecord,
  UploadSession,
  Visibility,
} from '../types/index.js';

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
export class FileService {
  private sql: Sql | undefined;
  private storage: StorageDriver | undefined;
  private secret: string | undefined;

  constructor(readonly config: ResolvedConfig) {}

  private db(): Sql {
    if (this.sql) return this.sql;
    if (this.config.metadata.driver !== 'sqlite') {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'Only SQLite metadata is implemented.',
        context: { driver: this.config.metadata.driver },
      });
    }
    if (this.config.storage.driver !== 'filesystem') {
      throw fail('FEATURE_NOT_AVAILABLE', {
        message: 'Only filesystem storage is implemented.',
        context: { driver: this.config.storage.driver },
      });
    }
    const root = path.resolve(this.config.storage.root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.storage = createFilesystemStorage(root);
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
    this.sql?.close();
    this.sql = undefined;
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
        ) VALUES (?, ?, ?, ?, 'authorized', 'chunked-http', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          fileId,
          ctx.principal.tenantId,
          ctx.principal.id,
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
    const key = `${tenantPath(session.tenant_id)}/files/${session.file_id}/sessions/${session.id}/parts/${partNumber}`;
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
    const originalKey = `${tenantPath(session.tenant_id)}/files/${session.file_id}/original/${createId('obj')}`;
    const assembled = await concatFiles(
      this.root(),
      parts.map((part) => part.object_key),
      originalKey,
    );
    if (assembled.bytes !== session.declared_bytes)
      throw fail('UPLOAD_SIZE_MISMATCH');
    const prefix = await readPrefix(this.root(), originalKey);
    const detected = sniffMime(prefix);
    if (!detected) {
      await this.storage?.deleteObject(originalKey);
      throw fail('UNSUPPORTED_MIME', {
        message: 'The uploaded bytes did not match a supported type.',
      });
    }
    if (
      detected !== session.declared_mime &&
      !compatibleMime(session.declared_mime, detected)
    ) {
      await this.storage?.deleteObject(originalKey);
      throw fail('MIME_MISMATCH', {
        context: { declared: session.declared_mime, detected },
      });
    }
    if (!mimeAllowed(detected, this.config.defaults.allowedMimeTypes)) {
      await this.storage?.deleteObject(originalKey);
      throw fail('UNSUPPORTED_MIME');
    }
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
    return mapFile(row);
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
    const page = rows.slice(0, limit).map((row) => mapFile(row));
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
    const row = this.db().get<FileRow>('SELECT * FROM files WHERE id = ?', [
      record.id,
    ]);
    return {
      id: record.id,
      status: record.processingState,
      original: {
        url: `${base}/content/${token}`,
        expiresAt: new Date(exp * 1000).toISOString(),
        mimeType: record.detectedMime ?? record.declaredMime,
        bytes: row?.bytes ?? record.bytes,
      },
      variants: {},
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
  }> {
    const sql = this.db();
    const payload = readToken(this.secret ?? '', token);
    const kind = payload?.n;
    const fileId = payload?.f;
    const exp = payload?.exp;
    if (
      kind !== 'original' ||
      typeof fileId !== 'string' ||
      typeof exp !== 'number' ||
      exp * 1000 < Date.now()
    ) {
      throw fail('UNAUTHORIZED', {
        message: 'The delivery token is expired or invalid.',
      });
    }
    const row = sql.get<FileRow>(
      'SELECT * FROM files WHERE id = ? AND deleted_at IS NULL',
      [fileId],
    );
    if (!row?.original_object_key) throw fail('NOT_FOUND');
    const total = row.bytes;
    const start = range?.start ?? 0;
    const end = range?.end ?? total - 1;
    if (start < 0 || start >= total || end < start || end >= total) {
      throw fail('INVALID_CONFIG', {
        message: 'The requested byte range is outside the object.',
      });
    }
    if (range) {
      const body = await readObjectRange(
        this.root(),
        row.original_object_key,
        start,
        end,
      );
      return { record: mapFile(row), body, start, end, total };
    }
    const stream = await this.storage?.getObject(row.original_object_key);
    if (!stream) throw fail('STORAGE_UNAVAILABLE');
    return { record: mapFile(row), body: stream, start, end, total };
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

  private mapSession(row: SessionRow): UploadSession {
    const parts = this.db().all<PartRow>(
      'SELECT * FROM upload_parts WHERE upload_session_id = ? ORDER BY part_number ASC',
      [row.id],
    );
    return {
      id: row.id,
      fileId: row.file_id,
      tenantId: row.tenant_id,
      ownerId: row.owner_id,
      status: row.status as UploadSession['status'],
      transport: 'chunked-http',
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

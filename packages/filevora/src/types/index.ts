import type { ErrorCategory } from '../errors/catalog.js';

/** Who is calling. The host application creates this after its own authentication. */
export interface Principal {
  /** Stable user id inside the host application. Never taken from the browser body. */
  id: string;
  /** Tenant boundary. Every query is filtered by this value. */
  tenantId: string;
}

export type Visibility = 'private' | 'public';

/** Bytes moving into storage. Independent from processing. */
export type UploadState =
  | 'created'
  | 'authorized'
  | 'uploading'
  | 'uploaded'
  | 'verified'
  | 'aborted'
  | 'expired';

/** Derivative work. A verified upload can still fail processing. */
export type ProcessingState =
  | 'none'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'partially_ready'
  | 'failed'
  | 'retrying'
  | 'deleting'
  | 'deleted'
  | 'quarantined';

export type JobState =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'cancelled';

export type FileOperation =
  | 'session.create'
  | 'session.read'
  | 'session.write'
  | 'session.complete'
  | 'session.abort'
  | 'file.read'
  | 'file.list'
  | 'file.delete'
  | 'file.restore'
  | 'file.touch'
  | 'delivery.sign'
  | 'process.request'
  | 'job.read'
  | 'job.cancel'
  | 'webhook.register'
  | 'retention.read'
  | 'retention.run'
  | 'metadata.export'
  | 'metadata.import';

export interface FileVariant {
  id: string;
  fileId: string;
  name: string;
  recipeId: string;
  recipeVersion: number;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  checksum: string;
  status: 'ready' | 'failed';
  createdAt: string;
}

export interface FileRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  originalName: string;
  declaredMime: string;
  detectedMime: string | null;
  bytes: number;
  checksum: string | null;
  visibility: Visibility;
  uploadState: UploadState;
  processingState: ProcessingState;
  preset: string | null;
  metadata: Record<string, string>;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  variants: FileVariant[];
}

export interface UploadPartRecord {
  partNumber: number;
  etag: string;
  bytes: number;
  checksum: string | null;
  completedAt: string;
}

export type UploadTransport = 'chunked-http' | 's3-multipart';

export interface UploadSession {
  id: string;
  /** Stable asset id. The host stores this. Same value as `fileId`. */
  assetId: string;
  fileId: string;
  tenantId: string;
  ownerId: string;
  status: UploadState;
  transport: UploadTransport;
  partSize: number;
  declaredBytes: number;
  partCount: number;
  expiresAt: string;
  receivedParts: UploadPartRecord[];
  /** Present for S3. Not a permanent credential. */
  storageUploadId?: string;
}

export interface SignedPart {
  partNumber: number;
  method: 'PUT';
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface ProcessingJob {
  id: string;
  fileId: string;
  tenantId: string;
  type: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  schemaVersion: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  runAfter: string;
}

export interface DeliveryTarget {
  url: string;
  expiresAt: string;
  mimeType: string;
  bytes: number;
  variantId?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface DeliveryResult {
  id: string;
  /** Stable asset id. Same value as `id`. */
  assetId: string;
  status: ProcessingState;
  original?: DeliveryTarget;
  variants: Record<string, DeliveryTarget>;
  /**
   * Every URL the host can use now. `_original` is present once the upload
   * is verified, including while encoding is queued, running, or failed.
   */
  versions: Record<string, DeliveryTarget>;
}

export interface UploadPolicy {
  /** Server-side owner. Ignored when it disagrees with the authenticated principal. */
  ownerId?: string;
  maxFileBytes?: number;
  allowedMimeTypes?: string[];
  preset?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type InactivityEvidence =
  'application-touch' | 'url-issued' | 'proxy-access';

export interface RetentionReport {
  dryRun: boolean;
  filesEligible: number;
  bytesEligible: number;
  filesDeleted: number;
  items: Array<{
    fileId: string;
    bytes: number;
    reason: string;
  }>;
}

export interface NormalizeColumn {
  type: 'string' | 'number' | 'boolean' | 'email' | 'date';
  required?: boolean;
}

export interface NormalizeRequest {
  kind: 'tabular';
  output?: 'json' | 'jsonl' | 'csv';
  schema?: {
    columns: Record<string, NormalizeColumn>;
  };
  invalidRows?: 'collect' | 'fail';
  sheet?: string;
  locale?: string;
}

export interface RowError {
  row: number;
  column: string;
  code: string;
  valuePreview: string;
}

export interface NormalizeResult {
  fileId: string;
  schemaVersion: number;
  output: { format: string; variantId: string };
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  errors: RowError[];
}

export type TransformRecipe =
  | {
      id: string;
      kind: 'image.resize';
      width: number;
      format?: 'webp' | 'jpeg' | 'png' | 'avif';
      quality?: number;
    }
  | {
      id: string;
      kind: 'video.thumbnail';
      atSeconds?: number;
      width: number;
      format?: 'webp' | 'png';
    }
  | {
      id: string;
      kind: 'video.transcode';
      source?: string;
      codec?: 'h264';
      maxHeight?: number;
      width?: number;
      container?: 'mp4';
    }
  | {
      id: string;
      kind: 'video.trim';
      startSeconds: number;
      endSeconds: number;
    }
  | {
      id: string;
      kind: 'video.crop';
      width: number;
      height: number;
      x: number;
      y: number;
    }
  | {
      id: string;
      kind: 'audio.transcode';
      codec?: 'aac' | 'mp3' | 'opus';
      normalize?: boolean;
    }
  | {
      id: string;
      kind: 'audio.trim';
      startSeconds: number;
      endSeconds: number;
    }
  | {
      id: string;
      kind: 'pdf.extract';
    }
  | {
      id: string;
      kind: 'tabular.normalize';
      request: NormalizeRequest;
    };

export interface ProcessRequest {
  preset?: string;
  transforms?: TransformRecipe[];
  execution?: 'background' | 'inline';
}

export interface StorageCapabilities {
  driver: 'filesystem' | 's3' | 'managed';
  multipart: boolean;
  presignedUpload: boolean;
  presignedDownload: boolean;
  rangeReads: boolean;
}

export interface StoredObject {
  key: string;
  bytes: number;
  etag: string;
  checksum: string | null;
}

export interface ObjectMetadata {
  key: string;
  bytes: number;
  etag: string | null;
  contentType: string | null;
}

export interface PutObjectInput {
  key: string;
  body: Uint8Array | AsyncIterable<Uint8Array>;
  contentType?: string;
}

export interface MultipartInit {
  key: string;
  contentType?: string;
}

export interface MultipartSession {
  key: string;
  uploadId: string;
}

export interface SignPartInput {
  key: string;
  uploadId: string;
  partNumber: number;
  expiresInSeconds: number;
}

export interface CompleteMultipartInput {
  key: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface AbortMultipartInput {
  key: string;
  uploadId: string;
}

export interface SignDownloadInput {
  key: string;
  expiresInSeconds: number;
  fileName?: string;
  contentType?: string;
}

export interface SignedUrl {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Object storage. Filesystem and S3 implement this. `managed` is reserved and
 * must not be constructed in this package.
 */
export interface StorageDriver {
  capabilities(): StorageCapabilities;
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(key: string): Promise<ReadableStream<Uint8Array>>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  deleteObject(key: string): Promise<void>;
  createMultipartUpload?(input: MultipartInit): Promise<MultipartSession>;
  signUploadPart?(input: SignPartInput): Promise<SignedUrl>;
  completeMultipartUpload?(
    input: CompleteMultipartInput,
  ): Promise<StoredObject>;
  abortMultipartUpload?(input: AbortMultipartInput): Promise<void>;
  signDownload?(input: SignDownloadInput): Promise<SignedUrl>;
}

export interface ProbeResult {
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  pages?: number;
  hasText?: boolean;
  codecs?: string[];
}

export interface ProducedArtifact {
  name: string;
  mimeType: string;
  bytes: number;
  checksum: string;
  width?: number;
  height?: number;
  durationMs?: number;
  body: Uint8Array;
  metadata?: Record<string, unknown>;
}

export interface ProcessorContext {
  file: FileRecord;
  inputPath: string;
  workDir: string;
  signal: AbortSignal;
  limits: {
    maxPixels: number;
    maxDurationSeconds: number;
    maxOutputHeight: number;
    tempMaxBytes: number;
    timeoutMs: number;
  };
  onProgress?: (update: { ratio: number; message?: string }) => void;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

/**
 * Trusted server plugin. Recipes are validated before `execute`.
 * Implementations must not accept shell strings.
 */
export interface ProcessorPlugin {
  id: string;
  supportedInputs: string[];
  operations: string[];
  probe(input: { path: string; mimeType: string }): Promise<ProbeResult>;
  validate(recipe: TransformRecipe): ValidationResult;
  execute(
    ctx: ProcessorContext,
    recipe: TransformRecipe,
  ): Promise<ProducedArtifact[]>;
}

/** Reserved. Calling a managed provider throws FEATURE_NOT_AVAILABLE. */
export interface ManagedProvider {
  readonly kind: 'managed';
  readonly unsupported: true;
}

export interface FileSdkErrorShape {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  requestId: string;
  context?: Record<string, unknown>;
}

export interface MetadataExport {
  version: number;
  exportedAt: string;
  tenantId: string;
  files: FileRecord[];
}

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

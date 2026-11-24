import { z } from 'zod';
import type { MalwareScanner } from '../safety/scan.js';
import { customPresetsSchema } from '../presets/schema.js';

const byteString = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value));
const boolString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const DEFAULT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const filesOptionsSchema = z
  .object({
    env: z.enum(['development', 'test', 'production']).optional(),
    provider: z
      .enum(['embedded', 'distributed', 'managed', 'hybrid'])
      .optional(),
    runtime: z.enum(['long-running', 'serverless', 'edge']).optional(),
    singleHostAcknowledged: z.boolean().optional(),
    strict: z.boolean().optional(),
    publicBaseUrl: z.string().url().optional(),
    signingSecret: z.string().min(16).optional(),
    signingSecrets: z.array(z.string().min(16)).max(8).optional(),
    storage: z
      .object({
        driver: z.enum(['filesystem', 's3', 'managed']).optional(),
        root: z.string().min(1).optional(),
        s3: z
          .object({
            endpoint: z.string().url().optional(),
            region: z.string().min(1).optional(),
            bucket: z.string().min(1).optional(),
            accessKeyId: z.string().min(1).optional(),
            secretAccessKey: z.string().min(1).optional(),
            sessionToken: z.string().min(1).optional(),
            forcePathStyle: z.boolean().optional(),
            multipartThresholdBytes: z.number().int().positive().optional(),
            partSizeBytes: z.number().int().positive().optional(),
            signedUrlTtlSeconds: z
              .number()
              .int()
              .positive()
              .max(60 * 60 * 24)
              .optional(),
            uploadGrantTtlSeconds: z
              .number()
              .int()
              .positive()
              .max(60 * 60 * 24)
              .optional(),
          })
          .optional(),
      })
      .optional(),
    metadata: z
      .object({
        mode: z.enum(['lite', 'stored']).optional(),
        driver: z.enum(['sqlite', 'postgres', 'mysql']).optional(),
        filename: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
        autoMigrate: z.boolean().optional(),
        schema: z
          .string()
          .regex(/^[a-z_][a-z0-9_]*$/i)
          .optional(),
      })
      .optional(),
    queue: z
      .object({
        driver: z.enum(['bullmq']).optional(),
        redisUrl: z.string().min(1).optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        maxAttempts: z.number().int().min(1).max(20).optional(),
        leaseSeconds: z.number().int().min(1).max(3600).optional(),
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
        backoffBaseMs: z.number().int().min(100).max(60_000).optional(),
      })
      .optional(),
    processing: z
      .object({
        mode: z
          .enum(['worker', 'inline', 'distributed', 'cloud', 'sync'])
          .optional(),
        spawn: z.enum(['on-demand', 'never']).optional(),
        concurrency: z.number().int().min(1).max(32).optional(),
        tempDir: z.string().min(1).optional(),
        tempMaxBytes: z.number().int().positive().optional(),
        shutdownGraceMs: z.number().int().min(0).max(120_000).optional(),
        ffmpegPath: z.string().min(1).optional(),
        ffprobePath: z.string().min(1).optional(),
        videoMaxDurationSeconds: z.number().int().positive().optional(),
        videoMaxOutputHeight: z.number().int().min(16).max(4320).optional(),
        imageMaxPixels: z.number().int().positive().optional(),
      })
      .optional(),
    defaults: z
      .object({
        visibility: z.enum(['private', 'public']).optional(),
        preserveOriginal: z.boolean().optional(),
        preset: z.string().min(1).optional(),
        maxFileBytes: z.number().int().positive().optional(),
        allowedMimeTypes: z.array(z.string().min(1)).optional(),
        maxFilesPerBatch: z.number().int().min(1).max(100).optional(),
        tenantQuotaBytes: z.number().int().positive().optional(),
        allowPublicFiles: z.boolean().optional(),
      })
      .optional(),
    presets: customPresetsSchema.optional(),
    upload: z
      .object({
        chunkBytes: z
          .number()
          .int()
          .min(64 * 1024)
          .max(5 * 1024 * 1024 * 1024)
          .optional(),
        partConcurrency: z.number().int().min(1).max(16).optional(),
        fileConcurrency: z.number().int().min(1).max(16).optional(),
        retryMaxAttempts: z.number().int().min(1).max(10).optional(),
        sessionTtlSeconds: z
          .number()
          .int()
          .min(60)
          .max(60 * 60 * 24 * 7)
          .optional(),
      })
      .optional(),
    retention: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeDays: z.number().int().positive().nullable().optional(),
        unusedAfterDays: z.number().int().positive().nullable().optional(),
        inactivityEvidence: z
          .enum(['application-touch', 'url-issued', 'proxy-access'])
          .optional(),
        gracePeriodDays: z.number().int().min(0).max(3650).optional(),
        keepOriginal: z.boolean().optional(),
        cleanupIntervalMinutes: z.number().int().min(1).max(10_080).optional(),
      })
      .optional(),
    delivery: z
      .object({
        urlTtlSeconds: z.number().int().min(30).max(86_400).optional(),
        accessLoggingEnabled: z.boolean().optional(),
      })
      .optional(),
    diagnostics: z
      .object({
        aiEnabled: z.boolean().optional(),
        aiProvider: z
          .enum(['openai', 'anthropic', 'gemini', 'custom'])
          .optional(),
        aiModel: z.string().min(1).optional(),
        aiMaxCostUsd: z.number().min(0).max(100).optional(),
        aiRedact: z.boolean().optional(),
      })
      .optional(),
    cloud: z
      .object({
        apiKey: z.string().min(1).optional(),
        endpoint: z.string().url().optional(),
        projectId: z.string().min(1).optional(),
      })
      .optional(),
    webhooks: z
      .object({
        allowLoopback: z.boolean().optional(),
        url: z.string().url().optional(),
        secret: z.string().min(1).optional(),
      })
      .optional(),
    safety: z
      .object({
        exif: z.enum(['gps', 'all', 'none']).optional(),
        typeMaxBytes: z
          .record(z.string(), z.number().int().positive())
          .optional(),
        scanner: z
          .custom<MalwareScanner>(
            (value) =>
              !value || typeof (value as MalwareScanner).scan === 'function',
          )
          .optional(),
      })
      .optional(),
    remote: z
      .object({
        maxBytes: z.number().int().positive().optional(),
        connectTimeoutMs: z.number().int().min(100).max(120_000).optional(),
        timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
        maxRedirects: z.number().int().min(0).max(10).optional(),
        allowedPorts: z.array(z.number().int().min(1).max(65535)).optional(),
        allowPrivate: z.boolean().optional(),
        allowHosts: z.array(z.string().min(1)).optional(),
        denyHosts: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  })
  .strict();

export type FilesOptions = z.input<typeof filesOptionsSchema>;

const envShape = {
  FILES_ENV: z.enum(['development', 'test', 'production']).optional(),
  FILES_PROVIDER: z
    .enum(['embedded', 'distributed', 'managed', 'hybrid'])
    .optional(),
  FILES_RUNTIME: z.enum(['long-running', 'serverless', 'edge']).optional(),
  FILES_SINGLE_HOST_ACK: boolString.optional(),
  FILES_CONFIG_STRICT: boolString.optional(),
  FILES_PUBLIC_BASE_URL: z.string().url().optional(),
  FILES_SIGNING_SECRET: z.string().min(16).optional(),
  FILEVORA_SIGNING_SECRET: z.string().optional(),
  FILEVORA_DEFAULT_VISIBILITY: z.enum(['private', 'public']).optional(),
  FILES_STORAGE_DRIVER: z.enum(['filesystem', 's3', 'managed']).optional(),
  FILES_STORAGE_ROOT: z.string().optional(),
  FILES_S3_ENDPOINT: z.string().url().optional(),
  FILES_S3_REGION: z.string().optional(),
  FILES_S3_BUCKET: z.string().optional(),
  FILES_S3_ACCESS_KEY_ID: z.string().optional(),
  FILES_S3_SECRET_ACCESS_KEY: z.string().optional(),
  FILES_S3_SESSION_TOKEN: z.string().optional(),
  FILES_S3_FORCE_PATH_STYLE: boolString.optional(),
  FILES_S3_MULTIPART_THRESHOLD_BYTES: byteString.optional(),
  FILES_S3_PART_SIZE_BYTES: byteString.optional(),
  FILES_S3_SIGNED_URL_TTL_SECONDS: byteString.optional(),
  FILES_S3_UPLOAD_GRANT_TTL_SECONDS: byteString.optional(),
  FILEVORA_METADATA_MODE: z.enum(['lite', 'stored']).optional(),
  FILEVORA_DATABASE_URL: z.string().optional(),
  FILEVORA_AUTO_MIGRATE: boolString.optional(),
  FILES_METADATA_DRIVER: z.enum(['sqlite', 'postgres', 'mysql']).optional(),
  FILES_SQLITE_PATH: z.string().optional(),
  FILES_POSTGRES_URL: z.string().optional(),
  FILES_POSTGRES_SCHEMA: z.string().optional(),
  FILES_QUEUE_DRIVER: z.enum(['bullmq']).optional(),
  FILES_QUEUE_POLL_INTERVAL_MS: byteString.optional(),
  FILES_JOB_MAX_ATTEMPTS: byteString.optional(),
  FILES_JOB_LEASE_SECONDS: byteString.optional(),
  FILES_JOB_TIMEOUT_SECONDS: byteString.optional(),
  FILES_JOB_BACKOFF_BASE_MS: byteString.optional(),
  FILES_PROCESSING_MODE: z
    .enum(['worker', 'inline', 'distributed', 'cloud', 'sync'])
    .optional(),
  FILES_WORKER_AUTOSPAWN: boolString.optional(),
  FILES_WORKER_CONCURRENCY: byteString.optional(),
  FILES_WORKER_TEMP_DIR: z.string().optional(),
  FILES_WORKER_TEMP_MAX_BYTES: byteString.optional(),
  FILES_WORKER_SHUTDOWN_GRACE_MS: byteString.optional(),
  FILES_FFMPEG_PATH: z.string().optional(),
  FILES_FFPROBE_PATH: z.string().optional(),
  FILES_VIDEO_MAX_DURATION_SECONDS: byteString.optional(),
  FILES_VIDEO_MAX_OUTPUT_HEIGHT: byteString.optional(),
  FILES_IMAGE_MAX_PIXELS: byteString.optional(),
  FILES_DEFAULT_VISIBILITY: z.enum(['private', 'public']).optional(),
  FILES_KEEP_ORIGINAL: boolString.optional(),
  FILES_DEFAULT_PRESET: z.string().optional(),
  FILEVORA_PRESETS: z.string().optional(),
  FILES_MAX_FILE_BYTES: byteString.optional(),
  FILES_ALLOWED_MIME_TYPES: z.string().optional(),
  FILES_MAX_FILES_PER_BATCH: byteString.optional(),
  FILES_TENANT_QUOTA_BYTES: byteString.optional(),
  FILES_ALLOW_PUBLIC_FILES: boolString.optional(),
  FILES_RETENTION_ENABLED: boolString.optional(),
  FILES_RETENTION_MAX_AGE_DAYS: byteString.optional(),
  FILES_UNUSED_RETENTION_DAYS: byteString.optional(),
  FILES_INACTIVITY_EVIDENCE: z
    .enum(['application-touch', 'url-issued', 'proxy-access'])
    .optional(),
  FILES_RETENTION_GRACE_DAYS: byteString.optional(),
  FILES_CLEANUP_INTERVAL_MINUTES: byteString.optional(),
  FILES_DELIVERY_URL_TTL_SECONDS: byteString.optional(),
  FILES_ACCESS_LOGGING_ENABLED: boolString.optional(),
  FILES_DIAGNOSTICS_AI_ENABLED: boolString.optional(),
  FILES_DIAGNOSTICS_AI_PROVIDER: z
    .enum(['openai', 'anthropic', 'gemini', 'custom'])
    .optional(),
  FILES_DIAGNOSTICS_AI_MODEL: z.string().optional(),
  FILES_DIAGNOSTICS_AI_MAX_COST_USD: z.string().optional(),
  FILES_DIAGNOSTICS_AI_REDACT: boolString.optional(),
  FILES_CLOUD_API_KEY: z.string().optional(),
  FILES_CLOUD_ENDPOINT: z.string().optional(),
  FILES_CLOUD_PROJECT_ID: z.string().optional(),
  FILES_WEBHOOKS_ALLOW_LOOPBACK: boolString.optional(),
  FILEVORA_WEBHOOK_URL: z.string().url().optional(),
  FILEVORA_WEBHOOK_SECRET: z.string().min(1).optional(),
  FILEVORA_REMOTE_MAX_BYTES: byteString.optional(),
  FILEVORA_REMOTE_CONNECT_TIMEOUT_MS: byteString.optional(),
  FILEVORA_REMOTE_TIMEOUT_MS: byteString.optional(),
  FILEVORA_REMOTE_MAX_REDIRECTS: byteString.optional(),
  FILEVORA_REMOTE_ALLOWED_PORTS: z.string().optional(),
  FILEVORA_REMOTE_ALLOW_PRIVATE: boolString.optional(),
  FILEVORA_REMOTE_HOST_ALLOW: z.string().optional(),
  FILEVORA_REMOTE_HOST_DENY: z.string().optional(),
  FILEVORA_MALWARE_SCAN: z.enum(['off', 'clamav']).optional(),
  FILEVORA_CLAMAV_HOST: z.string().optional(),
  FILEVORA_CLAMAV_PORT: byteString.optional(),
  FILEVORA_EXIF_STRIP: z.enum(['gps', 'all', 'none']).optional(),
  FILEVORA_TYPE_MAX_BYTES: z.string().optional(),
  REDIS_URL: z.string().min(1).optional(),
  FILES_REDIS_URL: z.string().min(1).optional(),
  FILES_UPLOAD_CHUNK_BYTES: byteString.optional(),
  FILES_UPLOAD_SESSION_TTL_SECONDS: byteString.optional(),
};

export const envSchema = z.object(envShape).strip();

import os from 'node:os';
import type { ZodError } from 'zod';
import { fail } from '../errors/error.js';
import { assertConfiguredPreset } from '../presets/expand.js';
import { customPresetMap } from '../presets/catalog.js';
import { type CustomPresetMap, parsePresetJson } from '../presets/schema.js';
import { parseTypeLimits } from '../safety/limits.js';
import { createClamAvScanner } from '../safety/scan.js';
import { redactValue } from '../redact.js';
import { detectRuntime, isEphemeralPath } from './runtime.js';
import {
  DEFAULT_MIME_TYPES,
  envSchema,
  type FilesOptions,
  filesOptionsSchema,
} from './schema.js';

export interface ResolvedConfig {
  env: 'development' | 'test' | 'production';
  provider: 'embedded' | 'distributed';
  runtime: 'long-running' | 'serverless' | 'edge';
  singleHostAcknowledged: boolean;
  strict: boolean;
  publicBaseUrl?: string;
  signingSecret?: string;
  storage: {
    driver: 'filesystem' | 's3';
    root: string;
    s3: {
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      forcePathStyle: boolean;
      multipartThresholdBytes: number;
      partSizeBytes: number;
      signedUrlTtlSeconds: number;
      uploadGrantTtlSeconds: number;
    };
  };
  metadata: {
    mode: 'lite' | 'stored';
    driver: 'sqlite' | 'postgres' | 'mysql';
    filename: string;
    url?: string;
    schema: string;
    autoMigrate: boolean;
  };
  queue: {
    driver: 'bullmq';
    redisUrl: string;
    pollIntervalMs: number;
    maxAttempts: number;
    leaseSeconds: number;
    timeoutSeconds: number;
    backoffBaseMs: number;
  };
  processing: {
    mode: 'worker' | 'inline' | 'distributed' | 'sync';
    spawn: 'on-demand' | 'never';
    concurrency: number;
    tempDir: string;
    tempMaxBytes: number;
    shutdownGraceMs: number;
    ffmpegPath: string;
    ffprobePath: string;
    videoMaxDurationSeconds: number;
    videoMaxOutputHeight: number;
    imageMaxPixels: number;
  };
  defaults: {
    visibility: 'private' | 'public';
    preserveOriginal: boolean;
    preset: string;
    maxFileBytes: number;
    allowedMimeTypes: string[];
    maxFilesPerBatch: number;
    tenantQuotaBytes?: number;
    allowPublicFiles: boolean;
  };
  presets: CustomPresetMap;
  upload: {
    chunkBytes: number;
    partConcurrency: number;
    fileConcurrency: number;
    retryMaxAttempts: number;
    sessionTtlSeconds: number;
  };
  retention: {
    enabled: boolean;
    maxAgeDays: number | null;
    unusedAfterDays: number | null;
    inactivityEvidence: 'application-touch' | 'url-issued' | 'proxy-access';
    gracePeriodDays: number;
    keepOriginal: boolean;
    cleanupIntervalMinutes: number;
  };
  delivery: {
    urlTtlSeconds: number;
    accessLoggingEnabled: boolean;
  };
  diagnostics: {
    format: 'structured';
    aiEnabled: boolean;
    aiProvider?: 'openai' | 'anthropic' | 'gemini' | 'custom';
    aiModel?: string;
    aiMaxCostUsd: number;
    aiRedact: boolean;
  };
  cloud: {
    apiKey?: string;
    endpoint?: string;
    projectId?: string;
  };
  webhooks: {
    allowLoopback: boolean;
    url?: string;
    secret?: string;
  };
  safety: {
    exif: 'gps' | 'all' | 'none';
    typeMaxBytes: Record<string, number>;
    scanner?: import('../safety/scan.js').MalwareScanner;
  };
  remote: {
    maxBytes: number;
    connectTimeoutMs: number;
    timeoutMs: number;
    maxRedirects: number;
    allowedPorts: number[];
    allowPrivate: boolean;
    allowHosts: string[];
    denyHosts: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDefined(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override;
  if (isRecord(base) && isRecord(override)) {
    const output: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      output[key] = mergeDefined(base[key], value);
    }
    return output;
  }
  return override;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value;
}

/** Map `FILES_*` environment variables into the typed options object. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function optionsFromEnv(env: NodeJS.ProcessEnv): FilesOptions {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw invalidConfig(parsed.error);
  }
  const e = parsed.data;
  const mime = e.FILES_ALLOWED_MIME_TYPES?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const aiCost = e.FILES_DIAGNOSTICS_AI_MAX_COST_USD;
  return {
    ...(e.FILES_ENV ? { env: e.FILES_ENV } : {}),
    ...(e.FILES_PROVIDER ? { provider: e.FILES_PROVIDER } : {}),
    ...(e.FILES_RUNTIME ? { runtime: e.FILES_RUNTIME } : {}),
    ...(e.FILES_SINGLE_HOST_ACK !== undefined
      ? { singleHostAcknowledged: e.FILES_SINGLE_HOST_ACK }
      : {}),
    ...(e.FILES_CONFIG_STRICT !== undefined
      ? { strict: e.FILES_CONFIG_STRICT }
      : {}),
    ...(e.FILES_PUBLIC_BASE_URL
      ? { publicBaseUrl: e.FILES_PUBLIC_BASE_URL }
      : {}),
    ...(e.FILES_UPLOAD_CHUNK_BYTES !== undefined ||
    e.FILES_UPLOAD_SESSION_TTL_SECONDS !== undefined
      ? {
          upload: {
            ...(e.FILES_UPLOAD_CHUNK_BYTES !== undefined
              ? { chunkBytes: e.FILES_UPLOAD_CHUNK_BYTES }
              : {}),
            ...(e.FILES_UPLOAD_SESSION_TTL_SECONDS !== undefined
              ? { sessionTtlSeconds: e.FILES_UPLOAD_SESSION_TTL_SECONDS }
              : {}),
          },
        }
      : {}),
    ...(e.FILES_SIGNING_SECRET
      ? { signingSecret: e.FILES_SIGNING_SECRET }
      : {}),
    ...(e.FILEVORA_REMOTE_MAX_BYTES !== undefined ||
    e.FILEVORA_REMOTE_CONNECT_TIMEOUT_MS !== undefined ||
    e.FILEVORA_REMOTE_TIMEOUT_MS !== undefined ||
    e.FILEVORA_REMOTE_MAX_REDIRECTS !== undefined ||
    e.FILEVORA_REMOTE_ALLOWED_PORTS !== undefined ||
    e.FILEVORA_REMOTE_ALLOW_PRIVATE !== undefined ||
    e.FILEVORA_REMOTE_HOST_ALLOW !== undefined ||
    e.FILEVORA_REMOTE_HOST_DENY !== undefined
      ? {
          remote: {
            ...(e.FILEVORA_REMOTE_MAX_BYTES !== undefined
              ? { maxBytes: e.FILEVORA_REMOTE_MAX_BYTES }
              : {}),
            ...(e.FILEVORA_REMOTE_CONNECT_TIMEOUT_MS !== undefined
              ? { connectTimeoutMs: e.FILEVORA_REMOTE_CONNECT_TIMEOUT_MS }
              : {}),
            ...(e.FILEVORA_REMOTE_TIMEOUT_MS !== undefined
              ? { timeoutMs: e.FILEVORA_REMOTE_TIMEOUT_MS }
              : {}),
            ...(e.FILEVORA_REMOTE_MAX_REDIRECTS !== undefined
              ? { maxRedirects: e.FILEVORA_REMOTE_MAX_REDIRECTS }
              : {}),
            ...(e.FILEVORA_REMOTE_ALLOWED_PORTS
              ? {
                  allowedPorts: e.FILEVORA_REMOTE_ALLOWED_PORTS.split(',')
                    .map((item) => Number(item.trim()))
                    .filter((item) => Number.isInteger(item)),
                }
              : {}),
            ...(e.FILEVORA_REMOTE_ALLOW_PRIVATE !== undefined
              ? { allowPrivate: e.FILEVORA_REMOTE_ALLOW_PRIVATE }
              : {}),
            ...(e.FILEVORA_REMOTE_HOST_ALLOW
              ? { allowHosts: splitList(e.FILEVORA_REMOTE_HOST_ALLOW) }
              : {}),
            ...(e.FILEVORA_REMOTE_HOST_DENY
              ? { denyHosts: splitList(e.FILEVORA_REMOTE_HOST_DENY) }
              : {}),
          },
        }
      : {}),
    ...(e.FILEVORA_EXIF_STRIP ||
    e.FILEVORA_TYPE_MAX_BYTES ||
    e.FILEVORA_MALWARE_SCAN === 'clamav'
      ? {
          safety: {
            ...(e.FILEVORA_EXIF_STRIP ? { exif: e.FILEVORA_EXIF_STRIP } : {}),
            ...(e.FILEVORA_TYPE_MAX_BYTES
              ? { typeMaxBytes: parseTypeLimits(e.FILEVORA_TYPE_MAX_BYTES) }
              : {}),
          },
        }
      : {}),
    storage: {
      ...(e.FILES_STORAGE_DRIVER ? { driver: e.FILES_STORAGE_DRIVER } : {}),
      ...(e.FILES_STORAGE_ROOT ? { root: e.FILES_STORAGE_ROOT } : {}),
      s3: {
        ...(e.FILES_S3_ENDPOINT ? { endpoint: e.FILES_S3_ENDPOINT } : {}),
        ...(e.FILES_S3_REGION ? { region: e.FILES_S3_REGION } : {}),
        ...(e.FILES_S3_BUCKET ? { bucket: e.FILES_S3_BUCKET } : {}),
        ...(e.FILES_S3_ACCESS_KEY_ID
          ? { accessKeyId: e.FILES_S3_ACCESS_KEY_ID }
          : {}),
        ...(e.FILES_S3_SECRET_ACCESS_KEY
          ? { secretAccessKey: e.FILES_S3_SECRET_ACCESS_KEY }
          : {}),
        ...(e.FILES_S3_SESSION_TOKEN
          ? { sessionToken: e.FILES_S3_SESSION_TOKEN }
          : {}),
        ...(e.FILES_S3_FORCE_PATH_STYLE !== undefined
          ? { forcePathStyle: e.FILES_S3_FORCE_PATH_STYLE }
          : {}),
        ...(e.FILES_S3_MULTIPART_THRESHOLD_BYTES !== undefined
          ? { multipartThresholdBytes: e.FILES_S3_MULTIPART_THRESHOLD_BYTES }
          : {}),
        ...(e.FILES_S3_PART_SIZE_BYTES !== undefined
          ? { partSizeBytes: e.FILES_S3_PART_SIZE_BYTES }
          : {}),
        ...(e.FILES_S3_SIGNED_URL_TTL_SECONDS !== undefined
          ? { signedUrlTtlSeconds: e.FILES_S3_SIGNED_URL_TTL_SECONDS }
          : {}),
        ...(e.FILES_S3_UPLOAD_GRANT_TTL_SECONDS !== undefined
          ? { uploadGrantTtlSeconds: e.FILES_S3_UPLOAD_GRANT_TTL_SECONDS }
          : {}),
      },
    },
    metadata: {
      ...(e.FILEVORA_METADATA_MODE ? { mode: e.FILEVORA_METADATA_MODE } : {}),
      ...(e.FILEVORA_AUTO_MIGRATE !== undefined
        ? { autoMigrate: e.FILEVORA_AUTO_MIGRATE }
        : {}),
      ...(e.FILES_METADATA_DRIVER ? { driver: e.FILES_METADATA_DRIVER } : {}),
      ...(e.FILES_SQLITE_PATH ? { filename: e.FILES_SQLITE_PATH } : {}),
      ...(e.FILEVORA_DATABASE_URL || e.FILES_POSTGRES_URL
        ? { url: e.FILEVORA_DATABASE_URL || e.FILES_POSTGRES_URL }
        : {}),
      ...(e.FILES_POSTGRES_SCHEMA ? { schema: e.FILES_POSTGRES_SCHEMA } : {}),
    },
    queue: {
      ...(e.REDIS_URL || e.FILES_REDIS_URL
        ? { redisUrl: e.REDIS_URL || e.FILES_REDIS_URL }
        : {}),
      ...(e.FILES_QUEUE_DRIVER ? { driver: e.FILES_QUEUE_DRIVER } : {}),
      ...(e.FILES_QUEUE_POLL_INTERVAL_MS !== undefined
        ? { pollIntervalMs: e.FILES_QUEUE_POLL_INTERVAL_MS }
        : {}),
      ...(e.FILES_JOB_MAX_ATTEMPTS !== undefined
        ? { maxAttempts: e.FILES_JOB_MAX_ATTEMPTS }
        : {}),
      ...(e.FILES_JOB_LEASE_SECONDS !== undefined
        ? { leaseSeconds: e.FILES_JOB_LEASE_SECONDS }
        : {}),
      ...(e.FILES_JOB_TIMEOUT_SECONDS !== undefined
        ? { timeoutSeconds: e.FILES_JOB_TIMEOUT_SECONDS }
        : {}),
      ...(e.FILES_JOB_BACKOFF_BASE_MS !== undefined
        ? { backoffBaseMs: e.FILES_JOB_BACKOFF_BASE_MS }
        : {}),
    },
    processing: {
      ...(e.FILES_PROCESSING_MODE ? { mode: e.FILES_PROCESSING_MODE } : {}),
      ...(e.FILES_WORKER_AUTOSPAWN !== undefined
        ? { spawn: e.FILES_WORKER_AUTOSPAWN ? 'on-demand' : 'never' }
        : {}),
      ...(e.FILES_WORKER_CONCURRENCY !== undefined
        ? { concurrency: e.FILES_WORKER_CONCURRENCY }
        : {}),
      ...(e.FILES_WORKER_TEMP_DIR ? { tempDir: e.FILES_WORKER_TEMP_DIR } : {}),
      ...(e.FILES_WORKER_TEMP_MAX_BYTES !== undefined
        ? { tempMaxBytes: e.FILES_WORKER_TEMP_MAX_BYTES }
        : {}),
      ...(e.FILES_WORKER_SHUTDOWN_GRACE_MS !== undefined
        ? { shutdownGraceMs: e.FILES_WORKER_SHUTDOWN_GRACE_MS }
        : {}),
      ...(e.FILES_FFMPEG_PATH ? { ffmpegPath: e.FILES_FFMPEG_PATH } : {}),
      ...(e.FILES_FFPROBE_PATH ? { ffprobePath: e.FILES_FFPROBE_PATH } : {}),
      ...(e.FILES_VIDEO_MAX_DURATION_SECONDS !== undefined
        ? { videoMaxDurationSeconds: e.FILES_VIDEO_MAX_DURATION_SECONDS }
        : {}),
      ...(e.FILES_VIDEO_MAX_OUTPUT_HEIGHT !== undefined
        ? { videoMaxOutputHeight: e.FILES_VIDEO_MAX_OUTPUT_HEIGHT }
        : {}),
      ...(e.FILES_IMAGE_MAX_PIXELS !== undefined
        ? { imageMaxPixels: e.FILES_IMAGE_MAX_PIXELS }
        : {}),
    },
    defaults: {
      ...(e.FILES_DEFAULT_VISIBILITY
        ? { visibility: e.FILES_DEFAULT_VISIBILITY }
        : {}),
      ...(e.FILES_KEEP_ORIGINAL !== undefined
        ? { preserveOriginal: e.FILES_KEEP_ORIGINAL }
        : {}),
      ...(e.FILES_DEFAULT_PRESET ? { preset: e.FILES_DEFAULT_PRESET } : {}),
      ...(e.FILES_MAX_FILE_BYTES !== undefined
        ? { maxFileBytes: e.FILES_MAX_FILE_BYTES }
        : {}),
      ...(mime && mime.length > 0 ? { allowedMimeTypes: mime } : {}),
      ...(e.FILES_MAX_FILES_PER_BATCH !== undefined
        ? { maxFilesPerBatch: e.FILES_MAX_FILES_PER_BATCH }
        : {}),
      ...(e.FILES_TENANT_QUOTA_BYTES !== undefined
        ? { tenantQuotaBytes: e.FILES_TENANT_QUOTA_BYTES }
        : {}),
      ...(e.FILES_ALLOW_PUBLIC_FILES !== undefined
        ? { allowPublicFiles: e.FILES_ALLOW_PUBLIC_FILES }
        : {}),
    },
    ...(e.FILEVORA_PRESETS
      ? {
          presets: parsePresetJson(
            e.FILEVORA_PRESETS,
          ) as FilesOptions['presets'],
        }
      : {}),
    retention: {
      ...(e.FILES_RETENTION_ENABLED !== undefined
        ? { enabled: e.FILES_RETENTION_ENABLED }
        : {}),
      ...(e.FILES_RETENTION_MAX_AGE_DAYS !== undefined
        ? { maxAgeDays: e.FILES_RETENTION_MAX_AGE_DAYS }
        : {}),
      ...(e.FILES_UNUSED_RETENTION_DAYS !== undefined
        ? { unusedAfterDays: e.FILES_UNUSED_RETENTION_DAYS }
        : {}),
      ...(e.FILES_INACTIVITY_EVIDENCE
        ? { inactivityEvidence: e.FILES_INACTIVITY_EVIDENCE }
        : {}),
      ...(e.FILES_RETENTION_GRACE_DAYS !== undefined
        ? { gracePeriodDays: e.FILES_RETENTION_GRACE_DAYS }
        : {}),
      ...(e.FILES_CLEANUP_INTERVAL_MINUTES !== undefined
        ? { cleanupIntervalMinutes: e.FILES_CLEANUP_INTERVAL_MINUTES }
        : {}),
    },
    delivery: {
      ...(e.FILES_DELIVERY_URL_TTL_SECONDS !== undefined
        ? { urlTtlSeconds: e.FILES_DELIVERY_URL_TTL_SECONDS }
        : {}),
      ...(e.FILES_ACCESS_LOGGING_ENABLED !== undefined
        ? { accessLoggingEnabled: e.FILES_ACCESS_LOGGING_ENABLED }
        : {}),
    },
    diagnostics: {
      ...(e.FILES_DIAGNOSTICS_AI_ENABLED !== undefined
        ? { aiEnabled: e.FILES_DIAGNOSTICS_AI_ENABLED }
        : {}),
      ...(e.FILES_DIAGNOSTICS_AI_PROVIDER
        ? { aiProvider: e.FILES_DIAGNOSTICS_AI_PROVIDER }
        : {}),
      ...(e.FILES_DIAGNOSTICS_AI_MODEL
        ? { aiModel: e.FILES_DIAGNOSTICS_AI_MODEL }
        : {}),
      ...(aiCost !== undefined ? { aiMaxCostUsd: Number(aiCost) } : {}),
      ...(e.FILES_DIAGNOSTICS_AI_REDACT !== undefined
        ? { aiRedact: e.FILES_DIAGNOSTICS_AI_REDACT }
        : {}),
    },
    cloud: {
      ...(emptyToUndefined(e.FILES_CLOUD_API_KEY)
        ? { apiKey: e.FILES_CLOUD_API_KEY }
        : {}),
      ...(emptyToUndefined(e.FILES_CLOUD_ENDPOINT)
        ? { endpoint: e.FILES_CLOUD_ENDPOINT }
        : {}),
      ...(emptyToUndefined(e.FILES_CLOUD_PROJECT_ID)
        ? { projectId: e.FILES_CLOUD_PROJECT_ID }
        : {}),
    },
    webhooks: {
      ...(e.FILES_WEBHOOKS_ALLOW_LOOPBACK !== undefined
        ? { allowLoopback: e.FILES_WEBHOOKS_ALLOW_LOOPBACK }
        : {}),
      ...(e.FILEVORA_WEBHOOK_URL ? { url: e.FILEVORA_WEBHOOK_URL } : {}),
      ...(e.FILEVORA_WEBHOOK_SECRET
        ? { secret: e.FILEVORA_WEBHOOK_SECRET }
        : {}),
    },
  };
}

function invalidConfig(error: ZodError): ReturnType<typeof fail> {
  return fail('INVALID_CONFIG', {
    context: {
      issues: error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    },
  });
}

/**
 * Resolve configuration. Explicit options override environment variables,
 * which override documented defaults. Does not read `.env` files and does not
 * open storage or spawn a worker.
 */
export function supportedDatabases(): string {
  return 'Stored mode supports PostgreSQL (postgres:// or postgresql://), MySQL/MariaDB (mysql:// or mariadb://), and SQLite (sqlite:// or a file path).';
}

function hostDatabase(raw: string): {
  driver: 'sqlite' | 'postgres' | 'mysql';
  url: string;
  filename: string;
} {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) {
    return { driver: 'postgres', url: value, filename: '' };
  }
  if (lower.startsWith('mysql://') || lower.startsWith('mariadb://')) {
    return { driver: 'mysql', url: value, filename: '' };
  }
  if (lower.startsWith('sqlite://')) {
    return {
      driver: 'sqlite',
      url: value,
      filename: value.slice('sqlite://'.length),
    };
  }
  if (lower.startsWith('file:')) {
    const filename = value.replace(/^file:\/\//, '').replace(/^file:/, '');
    return { driver: 'sqlite', url: value, filename };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw fail('INVALID_CONFIG', {
      message: `Unsupported database URL. ${supportedDatabases()}`,
    });
  }
  return { driver: 'sqlite', url: value, filename: value };
}

export function resolveConfig(
  options: FilesOptions = {},
  env: NodeJS.ProcessEnv = {},
): ResolvedConfig {
  const merged = mergeDefined(optionsFromEnv(env), options);
  const parsed = filesOptionsSchema.safeParse(merged);
  if (!parsed.success) throw invalidConfig(parsed.error);
  const input = parsed.data;
  const runtime = input.runtime ?? detectRuntime(env);
  const nodeEnv =
    env.NODE_ENV === 'production'
      ? 'production'
      : env.NODE_ENV === 'test'
        ? 'test'
        : 'development';
  const sdkEnv = input.env ?? nodeEnv;

  if (
    input.provider === 'managed' ||
    input.provider === 'hybrid' ||
    input.storage?.driver === 'managed'
  ) {
    throw fail('FEATURE_NOT_AVAILABLE', {
      message:
        'The managed Filevora provider is not available. Use filesystem or your own S3 storage.',
      context: {
        provider: input.provider ?? input.storage?.driver,
        reserved: true,
      },
    });
  }
  if (input.processing?.mode === 'cloud') {
    throw fail('FEATURE_NOT_AVAILABLE', {
      message:
        'Cloud processing is reserved and not available in this package.',
      context: { mode: 'cloud' },
    });
  }
  if (input.processing?.mode === 'sync' && sdkEnv !== 'test') {
    throw fail('INVALID_CONFIG', {
      message:
        'processing.mode "sync" runs jobs in the caller and is only available when env is test. Use filevora/testing.',
    });
  }

  const provider = input.provider ?? 'embedded';
  const storageDriver = input.storage?.driver ?? 'filesystem';
  const hostFile = input.metadata?.filename;
  const hostUrl = input.metadata?.url;
  const database = hostUrl || hostFile;
  if (input.metadata?.mode === 'stored' && !database) {
    throw fail('INVALID_CONFIG', {
      message: `Stored mode needs FILEVORA_DATABASE_URL. ${supportedDatabases()} Omit the database URL to run in lite mode.`,
    });
  }
  const metadataMode = input.metadata?.mode ?? (database ? 'stored' : 'lite');
  const hostDb =
    metadataMode === 'stored' && database ? hostDatabase(database) : undefined;
  const metadataDriver = hostDb?.driver ?? 'sqlite';
  const mode =
    input.processing?.mode ??
    (provider === 'distributed' ? 'distributed' : 'worker');
  const spawn =
    input.processing?.spawn ?? (mode === 'worker' ? 'on-demand' : 'never');
  const singleHostAcknowledged = input.singleHostAcknowledged ?? false;
  const root = input.storage?.root ?? './.files/objects';
  const filename = hostDb?.filename ?? '';
  const allowPublic = input.defaults?.allowPublicFiles ?? false;
  const visibility = input.defaults?.visibility ?? 'private';

  if (visibility === 'public' && !allowPublic) {
    throw fail('INVALID_CONFIG', {
      message:
        'Public visibility requires defaults.allowPublicFiles or FILES_ALLOW_PUBLIC_FILES=true.',
    });
  }
  if (storageDriver === 's3' && !input.storage?.s3?.bucket) {
    throw fail('INVALID_CONFIG', {
      message: 'S3 storage requires storage.s3.bucket or FILES_S3_BUCKET.',
    });
  }
  if (
    input.retention?.enabled === true &&
    (input.retention.maxAgeDays === undefined ||
      input.retention.maxAgeDays === null) &&
    (input.retention.unusedAfterDays === undefined ||
      input.retention.unusedAfterDays === null)
  ) {
    throw fail('RETENTION_POLICY_UNSAFE', {
      message:
        'Retention is enabled but neither max age nor an inactivity TTL is set.',
    });
  }

  const needsSingleHostAck =
    storageDriver === 'filesystem' ||
    (metadataMode === 'stored' && metadataDriver === 'sqlite');
  if (
    sdkEnv === 'production' &&
    needsSingleHostAck &&
    !singleHostAcknowledged
  ) {
    throw fail('UNSAFE_PRODUCTION_CONFIG', {
      message:
        'Production filesystem or SQLite storage requires singleHostAcknowledged.',
      context: { storageDriver, metadataDriver },
    });
  }
  if (
    sdkEnv === 'production' &&
    storageDriver === 'filesystem' &&
    isEphemeralPath(root)
  ) {
    throw fail('UNSAFE_PRODUCTION_CONFIG', {
      message:
        'Production filesystem storage cannot use an ephemeral temp directory.',
      context: { root },
    });
  }
  if (
    (runtime === 'serverless' || runtime === 'edge') &&
    mode === 'worker' &&
    spawn === 'on-demand'
  ) {
    throw fail('WORKER_UNSUPPORTED_RUNTIME', {
      context: { runtime, mode, spawn },
    });
  }
  if (mode === 'distributed' && spawn === 'on-demand') {
    throw fail('INVALID_CONFIG', {
      message:
        'Distributed processing cannot auto-spawn a worker. Deploy `filevora worker` separately.',
    });
  }
  if (
    provider === 'distributed' &&
    (storageDriver !== 's3' || metadataDriver !== 'postgres')
  ) {
    throw fail('INVALID_CONFIG', {
      message:
        'Distributed mode requires S3-compatible storage and Postgres metadata.',
    });
  }

  const presets = customPresetMap(input.presets);
  const presetName = input.defaults?.preset ?? 'web-optimized';
  assertConfiguredPreset(presetName, presets);

  const chunkBytes =
    input.upload?.chunkBytes ??
    input.storage?.s3?.partSizeBytes ??
    8 * 1024 * 1024;
  if (
    chunkBytes < 5 * 1024 * 1024 &&
    storageDriver === 's3' &&
    sdkEnv === 'production'
  ) {
    throw fail('INVALID_CONFIG', {
      message:
        'S3 part size must be at least 5 MiB in production, except the final part.',
    });
  }

  const resolved: ResolvedConfig = {
    env: sdkEnv,
    provider,
    runtime,
    singleHostAcknowledged,
    strict: input.strict ?? true,
    ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
    ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
    storage: {
      driver: storageDriver,
      root,
      s3: {
        ...(input.storage?.s3?.endpoint
          ? { endpoint: input.storage.s3.endpoint }
          : {}),
        region: input.storage?.s3?.region ?? 'us-east-1',
        bucket: input.storage?.s3?.bucket ?? '',
        ...(input.storage?.s3?.accessKeyId
          ? { accessKeyId: input.storage.s3.accessKeyId }
          : {}),
        ...(input.storage?.s3?.secretAccessKey
          ? { secretAccessKey: input.storage.s3.secretAccessKey }
          : {}),
        ...(input.storage?.s3?.sessionToken
          ? { sessionToken: input.storage.s3.sessionToken }
          : {}),
        forcePathStyle:
          input.storage?.s3?.forcePathStyle ??
          Boolean(input.storage?.s3?.endpoint),
        multipartThresholdBytes:
          input.storage?.s3?.multipartThresholdBytes ?? 16 * 1024 * 1024,
        partSizeBytes: input.storage?.s3?.partSizeBytes ?? chunkBytes,
        signedUrlTtlSeconds: input.storage?.s3?.signedUrlTtlSeconds ?? 900,
        uploadGrantTtlSeconds: input.storage?.s3?.uploadGrantTtlSeconds ?? 900,
      },
    },
    metadata: {
      mode: metadataMode,
      driver: metadataDriver,
      filename,
      ...(hostDb?.url ? { url: hostDb.url } : {}),
      schema: input.metadata?.schema ?? 'filevora',
      autoMigrate: input.metadata?.autoMigrate !== false,
    },
    queue: {
      driver: 'bullmq',
      redisUrl:
        input.queue?.redisUrl || env.REDIS_URL || env.FILES_REDIS_URL || '',
      pollIntervalMs: input.queue?.pollIntervalMs ?? 1000,
      maxAttempts: input.queue?.maxAttempts ?? 5,
      leaseSeconds: input.queue?.leaseSeconds ?? 120,
      timeoutSeconds: input.queue?.timeoutSeconds ?? 3600,
      backoffBaseMs: input.queue?.backoffBaseMs ?? 1000,
    },
    processing: {
      mode,
      spawn,
      concurrency: input.processing?.concurrency ?? 2,
      tempDir: input.processing?.tempDir ?? os.tmpdir(),
      tempMaxBytes: input.processing?.tempMaxBytes ?? 2 * 1024 * 1024 * 1024,
      shutdownGraceMs: input.processing?.shutdownGraceMs ?? 15_000,
      ffmpegPath: input.processing?.ffmpegPath ?? 'ffmpeg',
      ffprobePath: input.processing?.ffprobePath ?? 'ffprobe',
      videoMaxDurationSeconds: input.processing?.videoMaxDurationSeconds ?? 600,
      videoMaxOutputHeight: input.processing?.videoMaxOutputHeight ?? 1080,
      imageMaxPixels: input.processing?.imageMaxPixels ?? 40_000_000,
    },
    defaults: {
      visibility,
      preserveOriginal: input.defaults?.preserveOriginal ?? true,
      preset: presetName,
      maxFileBytes: input.defaults?.maxFileBytes ?? 100 * 1024 * 1024,
      allowedMimeTypes: input.defaults?.allowedMimeTypes ?? [
        ...DEFAULT_MIME_TYPES,
      ],
      maxFilesPerBatch: input.defaults?.maxFilesPerBatch ?? 10,
      ...(input.defaults?.tenantQuotaBytes
        ? { tenantQuotaBytes: input.defaults.tenantQuotaBytes }
        : {}),
      allowPublicFiles: allowPublic,
    },
    presets,
    upload: {
      chunkBytes,
      partConcurrency: input.upload?.partConcurrency ?? 4,
      fileConcurrency: input.upload?.fileConcurrency ?? 3,
      retryMaxAttempts: input.upload?.retryMaxAttempts ?? 5,
      sessionTtlSeconds: input.upload?.sessionTtlSeconds ?? 86_400,
    },
    retention: {
      enabled: input.retention?.enabled ?? false,
      maxAgeDays: input.retention?.maxAgeDays ?? null,
      unusedAfterDays: input.retention?.unusedAfterDays ?? null,
      inactivityEvidence:
        input.retention?.inactivityEvidence ?? 'application-touch',
      gracePeriodDays: input.retention?.gracePeriodDays ?? 7,
      keepOriginal: input.retention?.keepOriginal ?? true,
      cleanupIntervalMinutes: input.retention?.cleanupIntervalMinutes ?? 60,
    },
    delivery: {
      urlTtlSeconds:
        input.delivery?.urlTtlSeconds ??
        input.storage?.s3?.signedUrlTtlSeconds ??
        900,
      accessLoggingEnabled: input.delivery?.accessLoggingEnabled ?? false,
    },
    diagnostics: {
      format: 'structured',
      aiEnabled: input.diagnostics?.aiEnabled ?? false,
      ...(input.diagnostics?.aiProvider
        ? { aiProvider: input.diagnostics.aiProvider }
        : {}),
      ...(input.diagnostics?.aiModel
        ? { aiModel: input.diagnostics.aiModel }
        : {}),
      aiMaxCostUsd: input.diagnostics?.aiMaxCostUsd ?? 0,
      aiRedact: input.diagnostics?.aiRedact ?? true,
    },
    cloud: {
      ...(input.cloud?.apiKey ? { apiKey: input.cloud.apiKey } : {}),
      ...(input.cloud?.endpoint ? { endpoint: input.cloud.endpoint } : {}),
      ...(input.cloud?.projectId ? { projectId: input.cloud.projectId } : {}),
    },
    webhooks: {
      allowLoopback: input.webhooks?.allowLoopback ?? sdkEnv !== 'production',
      ...(input.webhooks?.url ? { url: input.webhooks.url } : {}),
      ...(input.webhooks?.secret ? { secret: input.webhooks.secret } : {}),
    },
    safety: {
      exif: input.safety?.exif ?? 'gps',
      typeMaxBytes: input.safety?.typeMaxBytes ?? {},
      ...(input.safety?.scanner
        ? { scanner: input.safety.scanner }
        : env.FILEVORA_MALWARE_SCAN === 'clamav'
          ? {
              scanner: createClamAvScanner({
                host: env.FILEVORA_CLAMAV_HOST ?? '127.0.0.1',
                port: Number(env.FILEVORA_CLAMAV_PORT ?? 3310),
              }),
            }
          : {}),
    },
    remote: {
      maxBytes: Math.min(
        input.remote?.maxBytes ??
          input.defaults?.maxFileBytes ??
          100 * 1024 * 1024,
        input.defaults?.maxFileBytes ?? 100 * 1024 * 1024,
      ),
      connectTimeoutMs: input.remote?.connectTimeoutMs ?? 10_000,
      timeoutMs: input.remote?.timeoutMs ?? 120_000,
      maxRedirects: input.remote?.maxRedirects ?? 3,
      allowedPorts: input.remote?.allowedPorts ?? [80, 443],
      allowPrivate: input.remote?.allowPrivate ?? false,
      allowHosts: input.remote?.allowHosts ?? [],
      denyHosts: input.remote?.denyHosts ?? [],
    },
  };

  if (
    resolved.diagnostics.aiEnabled &&
    resolved.diagnostics.aiMaxCostUsd <= 0
  ) {
    throw fail('INVALID_CONFIG', {
      message:
        'AI diagnostics require diagnostics.aiMaxCostUsd above zero when enabled.',
    });
  }
  return resolved;
}

/** Config view safe to print. Secrets and connection passwords are removed. */
export function redactConfig(config: ResolvedConfig): unknown {
  return redactValue(config);
}

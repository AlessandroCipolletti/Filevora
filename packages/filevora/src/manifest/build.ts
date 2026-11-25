import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { CLI_COMMANDS } from '../cli/commands.js';
import { envSchema, filesOptionsSchema } from '../config/schema.js';
import { ERROR_CATALOG } from '../errors/catalog.js';
import { HTTP_ROUTES } from '../http/route-table.js';
import { PROGRESS_EVENT_FIELDS } from '../progress/event.js';
import { FILEVORA_VERSION } from '../version.js';

export interface ManifestHand {
  name: string;
  package: string;
  needsAccount: boolean;
  managedProvider: string;
  billing: string;
  accounts: string;
  hostedControlPlane: string;
  runtimes: Record<string, unknown>;
  features: Record<string, string>;
  notes: string[];
}

const STORED_ENV = new Set([
  'FILEVORA_DATABASE_URL',
  'FILEVORA_AUTO_MIGRATE',
  'FILES_METADATA_DRIVER',
  'FILES_SQLITE_PATH',
  'FILES_POSTGRES_URL',
  'FILES_POSTGRES_SCHEMA',
]);

const ENV_DEFAULTS: Record<string, string | number | boolean | null> = {
  FILES_ENV: 'development',
  FILES_PROVIDER: 'embedded',
  FILES_RUNTIME: 'long-running',
  FILES_SINGLE_HOST_ACK: false,
  FILES_CONFIG_STRICT: true,
  FILES_PUBLIC_BASE_URL: null,
  FILES_SIGNING_SECRET: null,
  FILEVORA_SIGNING_SECRET: null,
  FILEVORA_DEFAULT_VISIBILITY: 'private',
  FILES_STORAGE_DRIVER: 'filesystem',
  FILES_STORAGE_ROOT: './.files/objects',
  FILES_S3_ENDPOINT: null,
  FILES_S3_REGION: 'us-east-1',
  FILES_S3_BUCKET: null,
  FILES_S3_ACCESS_KEY_ID: null,
  FILES_S3_SECRET_ACCESS_KEY: null,
  FILES_S3_SESSION_TOKEN: null,
  FILES_S3_FORCE_PATH_STYLE: false,
  FILES_S3_MULTIPART_THRESHOLD_BYTES: 16_777_216,
  FILES_S3_PART_SIZE_BYTES: 8_388_608,
  FILES_S3_SIGNED_URL_TTL_SECONDS: 900,
  FILES_S3_UPLOAD_GRANT_TTL_SECONDS: 900,
  FILEVORA_METADATA_MODE: 'lite',
  FILEVORA_DATABASE_URL: null,
  FILEVORA_AUTO_MIGRATE: true,
  FILES_METADATA_DRIVER: 'sqlite',
  FILES_SQLITE_PATH: null,
  FILES_POSTGRES_URL: null,
  FILES_POSTGRES_SCHEMA: 'filevora',
  FILES_QUEUE_DRIVER: 'bullmq',
  FILES_QUEUE_POLL_INTERVAL_MS: 1000,
  FILES_JOB_MAX_ATTEMPTS: 5,
  FILES_JOB_LEASE_SECONDS: 120,
  FILES_JOB_TIMEOUT_SECONDS: 3600,
  FILES_JOB_BACKOFF_BASE_MS: 1000,
  FILES_PROCESSING_MODE: 'worker',
  FILES_WORKER_AUTOSPAWN: true,
  FILES_WORKER_CONCURRENCY: 2,
  FILES_WORKER_TEMP_DIR: null,
  FILES_WORKER_TEMP_MAX_BYTES: 2_147_483_648,
  FILES_WORKER_SHUTDOWN_GRACE_MS: 15_000,
  FILES_FFMPEG_PATH: 'ffmpeg',
  FILES_FFPROBE_PATH: 'ffprobe',
  FILES_VIDEO_MAX_DURATION_SECONDS: 600,
  FILES_VIDEO_MAX_OUTPUT_HEIGHT: 1080,
  FILES_IMAGE_MAX_PIXELS: 40_000_000,
  FILES_DEFAULT_VISIBILITY: 'private',
  FILES_KEEP_ORIGINAL: true,
  FILES_DEFAULT_PRESET: 'web-optimized',
  FILES_THUMBNAIL_WIDTH: 480,
  FILEVORA_PRESETS: null,
  FILES_MAX_FILE_BYTES: 104_857_600,
  FILES_ALLOWED_MIME_TYPES: null,
  FILES_MAX_FILES_PER_BATCH: 10,
  FILES_TENANT_QUOTA_BYTES: null,
  FILES_ALLOW_PUBLIC_FILES: false,
  FILES_RETENTION_ENABLED: false,
  FILES_RETENTION_MAX_AGE_DAYS: null,
  FILES_UNUSED_RETENTION_DAYS: null,
  FILES_INACTIVITY_EVIDENCE: 'application-touch',
  FILES_RETENTION_GRACE_DAYS: 7,
  FILES_CLEANUP_INTERVAL_MINUTES: 60,
  FILES_DELIVERY_URL_TTL_SECONDS: 900,
  FILES_ACCESS_LOGGING_ENABLED: false,
  FILES_DIAGNOSTICS_AI_ENABLED: false,
  FILES_DIAGNOSTICS_AI_PROVIDER: null,
  FILES_DIAGNOSTICS_AI_MODEL: null,
  FILES_DIAGNOSTICS_AI_MAX_COST_USD: 0,
  FILES_DIAGNOSTICS_AI_REDACT: true,
  FILES_CLOUD_API_KEY: null,
  FILES_CLOUD_ENDPOINT: null,
  FILES_CLOUD_PROJECT_ID: null,
  FILES_WEBHOOKS_ALLOW_LOOPBACK: true,
  FILEVORA_WEBHOOK_URL: null,
  FILEVORA_WEBHOOK_SECRET: null,
  FILEVORA_REMOTE_MAX_BYTES: 104_857_600,
  FILEVORA_REMOTE_CONNECT_TIMEOUT_MS: 10_000,
  FILEVORA_REMOTE_TIMEOUT_MS: 120_000,
  FILEVORA_REMOTE_MAX_REDIRECTS: 3,
  FILEVORA_REMOTE_ALLOWED_PORTS: '80,443',
  FILEVORA_REMOTE_ALLOW_PRIVATE: false,
  FILEVORA_REMOTE_HOST_ALLOW: null,
  FILEVORA_REMOTE_HOST_DENY: null,
  FILEVORA_MALWARE_SCAN: 'off',
  FILEVORA_CLAMAV_HOST: '127.0.0.1',
  FILEVORA_CLAMAV_PORT: 3310,
  FILEVORA_EXIF_STRIP: 'gps',
  FILEVORA_GEMINI_API_KEY: null,
  FILEVORA_DESCRIBE_ASSETS: false,
  FILEVORA_GEMINI_MODEL: 'gemini-3.5-flash-lite',
  FILEVORA_EMBEDDING_MODEL: 'gemini-embedding-001',
  FILEVORA_EMBEDDING_DIMENSIONS: 768,
  FILEVORA_SEARCH_MIN_SCORE: 0.55,
  FILEVORA_SEARCH_MAX_RESULTS: 100,
  FILEVORA_DESCRIBE_VIDEO_HEIGHT: 720,
  FILEVORA_TYPE_MAX_BYTES: null,
  REDIS_URL: null,
  FILES_REDIS_URL: null,
  FILES_UPLOAD_CHUNK_BYTES: 8_388_608,
  FILES_UPLOAD_SESSION_TTL_SECONDS: 86_400,
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function zodType(schema: ZodTypeAny): { type: string; enum?: string[] } {
  const typeName = schema._def.typeName as string;
  if (
    typeName === 'ZodOptional' ||
    typeName === 'ZodNullable' ||
    typeName === 'ZodDefault'
  ) {
    return zodType(schema._def.innerType as ZodTypeAny);
  }
  if (typeName === 'ZodEffects')
    return zodType(schema._def.schema as ZodTypeAny);
  if (typeName === 'ZodEnum') {
    return { type: 'string', enum: schema._def.values as string[] };
  }
  if (typeName === 'ZodString') return { type: 'string' };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodArray')
    return { type: `${zodType(schema._def.type as ZodTypeAny).type}[]` };
  if (typeName === 'ZodRecord') return { type: 'record' };
  if (typeName === 'ZodObject') return { type: 'object' };
  if (typeName === 'ZodLiteral') return { type: 'literal' };
  if (typeName === 'ZodUnion' || typeName === 'ZodDiscriminatedUnion')
    return { type: 'union' };
  if (typeName === 'ZodAny' || typeName === 'ZodUnknown')
    return { type: 'unknown' };
  return { type: 'custom' };
}

function flattenOptions(
  schema: ZodTypeAny,
  prefix: string,
): Array<{ key: string; type: string; enum?: string[] }> {
  const typeName = schema._def.typeName as string;
  const inner =
    typeName === 'ZodEffects'
      ? (schema._def.schema as ZodTypeAny)
      : typeName === 'ZodOptional'
        ? (schema._def.innerType as ZodTypeAny)
        : schema;
  if ((inner._def.typeName as string) !== 'ZodObject') {
    const info = zodType(schema);
    return [
      {
        key: prefix,
        type: info.type,
        ...(info.enum ? { enum: info.enum } : {}),
      },
    ];
  }
  const shape = inner._def.shape() as Record<string, ZodTypeAny>;
  const rows: Array<{ key: string; type: string; enum?: string[] }> = [];
  for (const [key, value] of Object.entries(shape)) {
    const next = prefix ? `${prefix}.${key}` : key;
    const childName = (
      value._def.typeName === 'ZodOptional'
        ? (value._def.innerType as ZodTypeAny)
        : value
    )._def.typeName as string;
    const unwrapped =
      value._def.typeName === 'ZodOptional'
        ? (value._def.innerType as ZodTypeAny)
        : value;
    if (childName === 'ZodObject' || unwrapped._def.typeName === 'ZodObject') {
      rows.push(...flattenOptions(unwrapped, next));
      continue;
    }
    const info = zodType(value);
    rows.push({
      key: next,
      type: info.type,
      ...(info.enum ? { enum: info.enum } : {}),
    });
  }
  return rows;
}

function exportedSymbols(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/g,
  )) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

function modeFor(key: string): 'lite' | 'stored' | 'both' {
  if (STORED_ENV.has(key)) return 'stored';
  return 'both';
}

export function buildManifest(hand: ManifestHand): Record<string, unknown> {
  const envShape = envSchema.shape as Record<string, ZodTypeAny>;
  const envKeys = Object.keys(envShape).sort();
  for (const key of envKeys) {
    if (!(key in ENV_DEFAULTS)) {
      throw new Error(`Manifest defaults are missing ${key}.`);
    }
  }
  const pkg = JSON.parse(
    readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'),
  ) as { exports: Record<string, unknown> };
  const imports = Object.keys(pkg.exports)
    .map((key) => (key === '.' ? 'filevora' : `filevora${key.slice(1)}`))
    .sort();
  const src = path.join(packageRoot(), 'src');
  const entryByExport: Record<string, string> = {
    'filevora/server': 'server/index.ts',
    'filevora/client': 'client/index.ts',
    'filevora/http': 'http/index.ts',
    'filevora/worker': 'worker/index.ts',
    'filevora/types': 'types/index.ts',
    'filevora/testing': 'testing/index.ts',
    'filevora/manifest': 'manifest/index.ts',
  };
  const exportsCatalog = imports
    .filter((name) => entryByExport[name])
    .map((name) => ({
      module: name,
      symbols: exportedSymbols(path.join(src, entryByExport[name] ?? '')),
    }));
  return {
    schemaVersion: 2,
    name: hand.name,
    package: hand.package,
    version: FILEVORA_VERSION,
    needsAccount: hand.needsAccount,
    managedProvider: hand.managedProvider,
    billing: hand.billing,
    accounts: hand.accounts,
    hostedControlPlane: hand.hostedControlPlane,
    imports,
    cli: [...CLI_COMMANDS],
    runtimes: hand.runtimes,
    features: hand.features,
    notes: hand.notes,
    catalog: {
      schema: 'filevora.manifest/2',
      exports: exportsCatalog,
      endpoints: HTTP_ROUTES.map((route) => ({
        method: route.method,
        path: route.path,
        operation: route.operation,
        auth: route.auth,
        modes: route.modes,
        request: route.request,
        response: route.response,
      })),
      config: flattenOptions(filesOptionsSchema, '').map((row) => ({
        ...row,
        appliesTo: 'both' as const,
      })),
      env: envKeys.map((key) => {
        const info = zodType(envShape[key] as ZodTypeAny);
        return {
          key,
          type: info.type,
          ...(info.enum ? { enum: info.enum } : {}),
          default: ENV_DEFAULTS[key] ?? null,
          appliesTo: modeFor(key),
        };
      }),
      errors: Object.entries(ERROR_CATALOG).map(([code, spec]) => ({
        code,
        httpStatus: spec.httpStatus,
        category: spec.category,
        retryable: spec.retryable,
        cause: spec.resolution.explanation,
        fix: spec.resolution.actions[0]?.description ?? spec.message,
      })),
      progress: PROGRESS_EVENT_FIELDS,
    },
  };
}

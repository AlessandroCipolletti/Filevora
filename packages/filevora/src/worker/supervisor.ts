import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { nowIso } from '../ids.js';

const LEASE_ID = 'embedded';

export function workerConfigOptions(config: ResolvedConfig): FilesOptions {
  return {
    env: config.env,
    provider: config.provider,
    runtime: 'long-running',
    singleHostAcknowledged: true,
    ...(config.publicBaseUrl ? { publicBaseUrl: config.publicBaseUrl } : {}),
    signingSecret: config.signingSecret,
    ...(config.signingSecrets.length > 0
      ? { signingSecrets: config.signingSecrets }
      : {}),
    webhooks: {
      allowLoopback: config.webhooks.allowLoopback,
      ...(config.webhooks.url ? { url: config.webhooks.url } : {}),
      ...(config.webhooks.secret ? { secret: config.webhooks.secret } : {}),
    },
    storage: {
      driver: config.storage.driver,
      root: path.resolve(config.storage.root),
      ...(config.storage.driver === 's3'
        ? {
            s3: {
              region: config.storage.s3.region,
              bucket: config.storage.s3.bucket,
              forcePathStyle: config.storage.s3.forcePathStyle,
              ...(config.storage.s3.endpoint
                ? { endpoint: config.storage.s3.endpoint }
                : {}),
              ...(config.storage.s3.accessKeyId
                ? { accessKeyId: config.storage.s3.accessKeyId }
                : {}),
              ...(config.storage.s3.secretAccessKey
                ? { secretAccessKey: config.storage.s3.secretAccessKey }
                : {}),
              ...(config.storage.s3.sessionToken
                ? { sessionToken: config.storage.s3.sessionToken }
                : {}),
            },
          }
        : {}),
    },
    metadata: {
      mode: config.metadata.mode,
      driver: config.metadata.driver,
      ...(config.metadata.filename
        ? { filename: path.resolve(config.metadata.filename) }
        : {}),
      ...(config.metadata.url ? { url: config.metadata.url } : {}),
      schema: config.metadata.schema,
    },
    queue: {
      driver: 'bullmq',
      ...(config.queue.redisUrl ? { redisUrl: config.queue.redisUrl } : {}),
      pollIntervalMs: config.queue.pollIntervalMs,
      maxAttempts: config.queue.maxAttempts,
      leaseSeconds: config.queue.leaseSeconds,
      timeoutSeconds: config.queue.timeoutSeconds,
      backoffBaseMs: config.queue.backoffBaseMs,
    },
    processing: {
      mode: 'inline',
      spawn: 'never',
      concurrency: config.processing.concurrency,
      imageMaxPixels: config.processing.imageMaxPixels,
      videoMaxDurationSeconds: config.processing.videoMaxDurationSeconds,
      videoMaxOutputHeight: config.processing.videoMaxOutputHeight,
      ffmpegPath: config.processing.ffmpegPath,
      ffprobePath: config.processing.ffprobePath,
    },
    defaults: {
      maxFileBytes: config.defaults.maxFileBytes,
      allowedMimeTypes: config.defaults.allowedMimeTypes,
      preset: config.defaults.preset,
      thumbnailWidth: config.defaults.thumbnailWidth,
    },
    ...(Object.keys(config.presets).length > 0
      ? { presets: config.presets }
      : {}),
  };
}

/** Options for doctor and health. Keeps storage, including S3, and the real processing mode. */
export function filesOptionsFromResolved(config: ResolvedConfig): FilesOptions {
  const embedded = workerConfigOptions(config);
  return {
    ...embedded,
    runtime: config.runtime,
    processing: {
      mode: config.processing.mode,
      spawn: config.processing.spawn,
      concurrency: config.processing.concurrency,
      imageMaxPixels: config.processing.imageMaxPixels,
      videoMaxDurationSeconds: config.processing.videoMaxDurationSeconds,
      videoMaxOutputHeight: config.processing.videoMaxOutputHeight,
      ffmpegPath: config.processing.ffmpegPath,
      ffprobePath: config.processing.ffprobePath,
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn at most one embedded worker for this database. A live pid keeps its lease,
 * including across a second call from a hot reload.
 */
function leasePath(config: ResolvedConfig): string {
  return path.join(
    path.resolve(config.storage.root),
    '.filevora',
    'worker-lease.json',
  );
}

export function ensureEmbeddedWorker(config: ResolvedConfig): {
  pid: number;
  child?: ChildProcess;
} {
  if (
    config.processing.mode !== 'worker' ||
    config.processing.spawn !== 'on-demand'
  ) {
    return { pid: 0 };
  }
  const configPath = path.join(
    path.dirname(leasePath(config)),
    'worker-config.json',
  );
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(workerConfigOptions(config)), {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  const existing = readLease(config);
  if (
    existing &&
    pidAlive(existing.pid) &&
    Date.parse(existing.expires_at) > Date.now()
  ) {
    return { pid: existing.pid };
  }
  const childPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'child.js',
  );
  const child = spawn(process.execPath, [childPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FILEVORA_CONFIG_PATH: configPath,
      FILEVORA_WORKER_CHILD: '1',
    },
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  const now = nowIso();
  const expires = new Date(
    Date.now() + config.queue.leaseSeconds * 1000,
  ).toISOString();
  writeLease(config, {
    id: LEASE_ID,
    pid: child.pid ?? 0,
    heartbeat_at: now,
    expires_at: expires,
  });
  return { pid: child.pid ?? 0, child };
}

export function heartbeatSupervisor(
  config: ResolvedConfig,
  pid: number,
  leaseSeconds: number,
): void {
  const existing = readLease(config);
  if (!existing || existing.pid !== pid) return;
  const now = nowIso();
  writeLease(config, {
    ...existing,
    heartbeat_at: now,
    expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
  });
}

function readLease(
  config: ResolvedConfig,
):
  | { id: string; pid: number; heartbeat_at: string; expires_at: string }
  | undefined {
  try {
    return JSON.parse(readFileSync(leasePath(config), 'utf8')) as {
      id: string;
      pid: number;
      heartbeat_at: string;
      expires_at: string;
    };
  } catch {
    return undefined;
  }
}

function writeLease(
  config: ResolvedConfig,
  lease: { id: string; pid: number; heartbeat_at: string; expires_at: string },
): void {
  mkdirSync(path.dirname(leasePath(config)), { recursive: true, mode: 0o700 });
  writeFileSync(leasePath(config), JSON.stringify(lease), { mode: 0o600 });
}

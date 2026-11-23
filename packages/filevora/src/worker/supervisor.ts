import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { nowIso } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';

const LEASE_ID = 'embedded';

export function workerConfigOptions(config: ResolvedConfig): FilesOptions {
  return {
    env: config.env,
    provider: config.provider,
    runtime: 'long-running',
    singleHostAcknowledged: true,
    signingSecret: config.signingSecret,
    storage: {
      driver: config.storage.driver,
      root: path.resolve(config.storage.root),
    },
    metadata: {
      driver: config.metadata.driver,
      filename: path.resolve(config.metadata.filename),
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
export function ensureEmbeddedWorker(
  sql: Sql,
  config: ResolvedConfig,
): { pid: number; child?: ChildProcess } {
  if (
    config.processing.mode !== 'worker' ||
    config.processing.spawn !== 'on-demand'
  ) {
    return { pid: 0 };
  }
  const configPath = path.join(
    path.dirname(path.resolve(config.metadata.filename)),
    'worker-config.json',
  );
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(workerConfigOptions(config)), {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  return sql.transaction(() => {
    const now = nowIso();
    const existing = sql.get<{ pid: number; expires_at: string }>(
      'SELECT pid, expires_at FROM supervisor_leases WHERE id = ?',
      [LEASE_ID],
    );
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
    const expires = new Date(
      Date.now() + config.queue.leaseSeconds * 1000,
    ).toISOString();
    sql.run(
      `INSERT INTO supervisor_leases (id, owner, pid, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`,
      [LEASE_ID, `parent:${process.pid}`, child.pid ?? 0, now, expires],
    );
    return { pid: child.pid ?? 0, child };
  });
}

export function heartbeatSupervisor(
  sql: Sql,
  pid: number,
  leaseSeconds: number,
): void {
  const now = nowIso();
  const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  sql.run(
    `UPDATE supervisor_leases SET heartbeat_at = ?, expires_at = ? WHERE pid = ?`,
    [now, expires, pid],
  );
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ResolvedConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { isFileSdkError } from '../errors/error.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite } from '../metadata/sqlite.js';
import { FILEVORA_VERSION, METADATA_EXPORT_VERSION } from '../version.js';

interface DoctorCheck {
  id: string;
  status: 'pass' | 'fail' | 'warn';
  required: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  metadataExportVersion: number;
  checks: DoctorCheck[];
}

/** Read-only-as-possible environment report. Migrations are applied because they are idempotent. */
export function runDoctor(
  options: FilesOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): DoctorReport {
  const checks: DoctorCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number(part));
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  checks.push({
    id: 'node',
    status: nodeOk ? 'pass' : 'fail',
    required: true,
    message: `Node ${process.version}`,
  });
  let config: ResolvedConfig | undefined;
  try {
    config = resolveConfig(options, env);
    checks.push({
      id: 'config',
      status: 'pass',
      required: true,
      message: 'Configuration is valid.',
    });
  } catch (error) {
    checks.push({
      id: 'config',
      status: 'fail',
      required: true,
      message: isFileSdkError(error)
        ? `${error.code}: ${error.message}`
        : 'Configuration is invalid.',
    });
  }
  if (config?.storage.driver === 'filesystem') {
    try {
      mkdirSync(config.storage.root, { recursive: true, mode: 0o700 });
      const probe = path.join(config.storage.root, `.doctor-${process.pid}`);
      writeFileSync(probe, 'ok', { mode: 0o600 });
      rmSync(probe);
      checks.push({
        id: 'storage',
        status: 'pass',
        required: true,
        message: 'Filesystem storage root is writable.',
      });
    } catch {
      checks.push({
        id: 'storage',
        status: 'fail',
        required: true,
        message: 'Filesystem storage root is not writable.',
      });
    }
  }
  if (config?.metadata.driver === 'sqlite') {
    try {
      const sql = openSqlite(config.metadata.filename);
      migrate(sql);
      sql.close();
      checks.push({
        id: 'metadata',
        status: 'pass',
        required: true,
        message: 'SQLite migrations are applied.',
      });
    } catch {
      checks.push({
        id: 'metadata',
        status: 'fail',
        required: true,
        message: 'SQLite metadata could not be opened.',
      });
    }
  }
  const ffmpeg = spawnSync(
    config?.processing.ffmpegPath ?? 'ffmpeg',
    ['-version'],
    { encoding: 'utf8' },
  );
  checks.push({
    id: 'ffmpeg',
    status: ffmpeg.status === 0 ? 'pass' : 'warn',
    required: false,
    message:
      ffmpeg.status === 0
        ? (ffmpeg.stdout.split('\n')[0] ?? 'FFmpeg found')
        : 'FFmpeg was not found. Video jobs cannot run.',
  });
  return {
    ok: checks.every((check) => !check.required || check.status === 'pass'),
    version: FILEVORA_VERSION,
    metadataExportVersion: METADATA_EXPORT_VERSION,
    checks,
  };
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ResolvedConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { isFileSdkError } from '../errors/error.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite } from '../metadata/sqlite.js';
import {
  probeFfmpegEncoders,
  selectPosterEncoder,
} from '../processors/ffmpeg.js';
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
export async function runDoctor(
  options: FilesOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
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
  if (!config || config.metadata.mode === 'lite') {
    checks.push({
      id: 'metadata',
      status: 'pass',
      required: true,
      message:
        'Lite mode uses object storage plus Redis. It does not open a database file.',
    });
  } else if (config.metadata.driver === 'sqlite' && config.metadata.filename) {
    try {
      const sql = openSqlite(config.metadata.filename);
      await migrate(sql, 'sqlite');
      await sql.close();
      checks.push({
        id: 'metadata',
        status: 'pass',
        required: true,
        message: 'Host SQLite database has the filevora_assets tables.',
      });
    } catch {
      checks.push({
        id: 'metadata',
        status: 'fail',
        required: true,
        message: 'The host SQLite database could not be opened.',
      });
    }
  } else if (
    config.metadata.driver === 'postgres' ||
    config.metadata.driver === 'mysql'
  ) {
    checks.push({
      id: 'metadata',
      status: config.metadata.url ? 'pass' : 'fail',
      required: true,
      message: config.metadata.url
        ? `${config.metadata.driver} stored mode uses the host database. Run npx filevora migrate if auto-migrate is off.`
        : 'Stored mode needs FILEVORA_DATABASE_URL.',
    });
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
  const posterEncoder = selectPosterEncoder(
    probeFfmpegEncoders(config?.processing.ffmpegPath ?? 'ffmpeg'),
  );
  checks.push({
    id: 'ffmpeg-webp',
    status: posterEncoder === 'libwebp' ? 'pass' : 'warn',
    required: false,
    message:
      posterEncoder === 'libwebp'
        ? 'FFmpeg can encode WebP posters with libwebp.'
        : 'FFmpeg has no libwebp encoder. Video posters are encoded by Sharp.',
  });
  const pdftoppm = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  const pdftoppmLine =
    `${pdftoppm.stderr ?? ''}\n${pdftoppm.stdout ?? ''}`
      .split('\n')
      .find((line) => line.trim().length > 0) ?? 'pdftoppm found';
  checks.push({
    id: 'pdftoppm',
    status: pdftoppm.status === 0 ? 'pass' : 'warn',
    required: false,
    message:
      pdftoppm.status === 0
        ? pdftoppmLine
        : 'pdftoppm was not found. PDF text extraction still runs. Page images are skipped.',
  });
  return {
    ok: checks.every((check) => !check.required || check.status === 'pass'),
    version: FILEVORA_VERSION,
    metadataExportVersion: METADATA_EXPORT_VERSION,
    checks,
  };
}

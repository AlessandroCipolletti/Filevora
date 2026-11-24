import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { type ResolvedConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { isFileSdkError } from '../errors/error.js';
import { openBackend } from '../metadata/backend.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite } from '../metadata/sqlite.js';
import { assertWebhookUrl } from '../webhooks/target.js';
import {
  probeFfmpegEncoders,
  selectPosterEncoder,
} from '../processors/ffmpeg.js';
import { FILEVORA_VERSION, METADATA_EXPORT_VERSION } from '../version.js';
import { listPresets } from '../presets/catalog.js';

interface DoctorCheck {
  id: string;
  status: 'pass' | 'fail' | 'warn';
  required: boolean;
  message: string;
  code: string;
  explanation: string;
  fix: string;
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
  checks.push(
    described({
      id: 'node',
      status: nodeOk ? 'pass' : 'fail',
      required: true,
      message: `Node ${process.version}`,
      code: nodeOk ? 'OK' : 'DOCTOR_NODE',
      explanation: nodeOk
        ? `Node ${process.version} meets the engine requirement.`
        : 'Filevora needs Node.js 22.13 or newer.',
      fix: 'Install Node.js 22.13 or newer and run the command again.',
    }),
  );
  let config: ResolvedConfig | undefined;
  try {
    config = resolveConfig(options, env);
    checks.push(
      described({
        id: 'config',
        status: 'pass',
        required: true,
        message: 'Configuration is valid.',
        code: 'OK',
        explanation: `Mode is ${config.metadata.mode}.`,
        fix: 'No change is required.',
      }),
    );
    checks.push(
      described({
        id: 'mode',
        status: 'pass',
        required: true,
        message: `${config.metadata.mode} (${config.metadata.driver})`,
        code: 'OK',
        explanation:
          config.metadata.mode === 'lite'
            ? 'No FILEVORA_DATABASE_URL is set, so metadata stays on the asset cards.'
            : `Stored mode uses ${config.metadata.driver}.`,
        fix: 'No change is required.',
      }),
    );
  } catch (error) {
    const message = isFileSdkError(error)
      ? `${error.code}: ${error.message}`
      : 'Configuration is invalid.';
    checks.push(
      described({
        id: 'config',
        status: 'fail',
        required: true,
        message,
        code: 'DOCTOR_CONFIG_INVALID',
        explanation: message,
        fix: 'Run npx filevora config validate --json and correct the reported field.',
      }),
    );
  }
  if (config?.storage.driver === 'filesystem') {
    try {
      mkdirSync(config.storage.root, { recursive: true, mode: 0o700 });
      const probe = path.join(config.storage.root, `.doctor-${process.pid}`);
      writeFileSync(probe, 'ok', { mode: 0o600 });
      const readBack = readFileSync(probe, 'utf8');
      rmSync(probe);
      if (readBack !== 'ok') throw new Error('read mismatch');
      checks.push(
        described({
          id: 'storage',
          status: 'pass',
          required: true,
          message: 'Filesystem storage round trip succeeded.',
          code: 'OK',
          explanation: 'A probe file was written, read, and deleted.',
          fix: 'No change is required.',
        }),
      );
    } catch {
      checks.push(
        described({
          id: 'storage',
          status: 'fail',
          required: true,
          message: 'Filesystem storage round trip failed.',
          code: 'DOCTOR_STORAGE_ROUNDTRIP',
          explanation:
            'The storage root could not complete a write, read, and delete.',
          fix: 'Create FILES_STORAGE_ROOT and grant the process write permission.',
        }),
      );
    }
  } else if (config?.storage.driver === 's3') {
    let storage: { close?: () => Promise<void> } | undefined;
    try {
      const { openStorage } = await import('../storage/stage.js');
      const driver = await openStorage(config.storage);
      storage = driver;
      const key = `.filevora/doctor-${process.pid}-${Date.now()}`;
      await driver.putObject({
        key,
        body: Buffer.from('ok'),
        contentType: 'text/plain',
      });
      const head = await driver.headObject(key);
      await driver.deleteObject(key);
      if (!head || head.bytes < 2) throw new Error('read mismatch');
      checks.push(
        described({
          id: 'storage',
          status: 'pass',
          required: true,
          message: 'S3 storage round trip succeeded.',
          code: 'OK',
          explanation: `Wrote, read, and deleted a probe in ${config.storage.s3.bucket}.`,
          fix: 'No change is required.',
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'request failed';
      checks.push(
        described({
          id: 'storage',
          status: 'fail',
          required: true,
          message: 'S3 storage round trip failed.',
          code: 'DOCTOR_STORAGE_ROUNDTRIP',
          explanation: `The bucket ${config.storage.s3.bucket} did not complete a write, read, and delete. ${detail}`,
          fix: 'Check FILES_S3_BUCKET, FILES_S3_ENDPOINT, FILES_S3_REGION, and the access key pair. Confirm the process can reach the endpoint.',
        }),
      );
    } finally {
      await storage?.close?.();
    }
  }
  if (!config || config.metadata.mode === 'lite') {
    checks.push(
      described({
        id: 'metadata',
        status: 'pass',
        required: true,
        message:
          'Lite mode uses object storage plus Redis. It does not open a database file.',
        code: 'OK',
        explanation: 'Lite mode has no migration.',
        fix: 'No change is required.',
      }),
    );
  } else if (config.metadata.driver === 'sqlite' && config.metadata.filename) {
    try {
      const sql = openSqlite(config.metadata.filename);
      await migrate(sql, 'sqlite');
      await sql.get('SELECT COUNT(*) AS n FROM filevora_assets');
      await sql.close();
      checks.push(
        described({
          id: 'metadata',
          status: 'pass',
          required: true,
          message: 'Host SQLite database has the filevora_assets tables.',
          code: 'OK',
          explanation: 'Migration has been applied.',
          fix: 'No change is required.',
        }),
      );
    } catch {
      checks.push(
        described({
          id: 'metadata',
          status: 'fail',
          required: true,
          message: 'The host SQLite database could not be opened.',
          code: 'DOCTOR_DATABASE_UNREACHABLE',
          explanation:
            'Stored SQLite did not accept a connection or migration.',
          fix: 'Check FILES_SQLITE_PATH and run npx filevora migrate.',
        }),
      );
    }
  } else if (
    config.metadata.driver === 'postgres' ||
    config.metadata.driver === 'mysql'
  ) {
    try {
      const sql = await openBackend(config);
      await sql.get('SELECT COUNT(*) AS n FROM filevora_assets');
      await sql.close();
      checks.push(
        described({
          id: 'metadata',
          status: 'pass',
          required: true,
          message: `${config.metadata.driver} is reachable and migrated.`,
          code: 'OK',
          explanation: 'The host database answered and filevora_assets exists.',
          fix: 'No change is required.',
        }),
      );
    } catch {
      checks.push(
        described({
          id: 'metadata',
          status: 'fail',
          required: true,
          message: `${config.metadata.driver} could not be queried.`,
          code: 'DOCTOR_DATABASE_UNREACHABLE',
          explanation:
            'Stored mode could not connect or the Filevora tables are missing.',
          fix: 'Check FILEVORA_DATABASE_URL and run npx filevora migrate.',
        }),
      );
    }
  }
  checks.push(await redisCheck(config, env));
  checks.push(
    binaryCheck(
      'ffmpeg',
      config?.processing.ffmpegPath ?? 'ffmpeg',
      ['-version'],
      'DOCTOR_FFMPEG_MISSING',
      'Install ffmpeg and ensure it is on PATH.',
    ),
  );
  checks.push(
    binaryCheck(
      'ffprobe',
      config?.processing.ffprobePath ?? 'ffprobe',
      ['-version'],
      'DOCTOR_FFPROBE_MISSING',
      'Install ffprobe, usually from the same package as ffmpeg.',
    ),
  );
  const posterEncoder = selectPosterEncoder(
    probeFfmpegEncoders(config?.processing.ffmpegPath ?? 'ffmpeg'),
  );
  checks.push(
    described({
      id: 'ffmpeg-webp',
      status: posterEncoder === 'libwebp' ? 'pass' : 'warn',
      required: false,
      message:
        posterEncoder === 'libwebp'
          ? 'FFmpeg can encode WebP posters with libwebp.'
          : 'FFmpeg has no libwebp encoder. Video posters are encoded by Sharp.',
      code: posterEncoder === 'libwebp' ? 'OK' : 'DOCTOR_FFMPEG_WEBP',
      explanation:
        'Video posters use libwebp when the binary lists that encoder. Otherwise Sharp writes them.',
      fix: 'No change is required. Install a ffmpeg build with libwebp only if you want ffmpeg to encode posters.',
    }),
  );
  const pdftoppm = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  const pdftoppmLine =
    `${pdftoppm.stderr ?? ''}\n${pdftoppm.stdout ?? ''}`
      .split('\n')
      .find((line) => line.trim().length > 0) ?? 'pdftoppm found';
  checks.push(
    described({
      id: 'pdftoppm',
      status: pdftoppm.status === 0 ? 'pass' : 'warn',
      required: false,
      message:
        pdftoppm.status === 0
          ? pdftoppmLine
          : 'pdftoppm was not found. PDF text extraction still runs. Page images are skipped.',
      code: pdftoppm.status === 0 ? 'OK' : 'DOCTOR_PDFTOPPM_MISSING',
      explanation:
        'pdftoppm renders the first PDF page. Text extraction does not need it.',
      fix: 'Install poppler so pdftoppm is on PATH.',
    }),
  );
  checks.push(await scannerCheck(env));
  if (config) checks.push(await webhookCheck(config));
  if (config) checks.push(signingSecretCheck(config));
  if (config) {
    const custom = listPresets(config.presets).filter(
      (preset) => preset.source === 'custom',
    );
    checks.push(
      described({
        id: 'presets',
        status: 'pass',
        required: false,
        message: `Default preset ${config.defaults.preset} is available.`,
        code: 'OK',
        explanation:
          custom.length === 0
            ? 'Built-in image and video presets are available. No custom presets are configured.'
            : `Custom presets: ${custom.map((preset) => preset.name).join(', ')}.`,
        fix: 'Set FILES_DEFAULT_PRESET or define presets in config. See docs/presets.md.',
      }),
    );
  }
  return {
    ok: checks.every((check) => !check.required || check.status === 'pass'),
    version: FILEVORA_VERSION,
    metadataExportVersion: METADATA_EXPORT_VERSION,
    checks,
  };
}

function described(check: DoctorCheck): DoctorCheck {
  return check;
}

function binaryCheck(
  id: string,
  command: string,
  args: string[],
  code: string,
  fix: string,
): DoctorCheck {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const found = result.status === 0;
  return described({
    id,
    status: found ? 'pass' : 'fail',
    required: false,
    message: found
      ? (result.stdout.split('\n')[0] ?? `${command} found`)
      : `${command} was not found.`,
    code: found ? 'OK' : code,
    explanation: found
      ? `${command} answered ${args.join(' ')}.`
      : `${command} is required for media jobs.`,
    fix: found ? 'No change is required.' : fix,
  });
}

async function redisCheck(
  config: ResolvedConfig | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const url =
    env.REDIS_URL || env.FILES_REDIS_URL || config?.queue.redisUrl || '';
  if (!url) {
    return described({
      id: 'redis',
      status: 'warn',
      required: false,
      message: 'REDIS_URL is not set.',
      code: 'DOCTOR_REDIS_UNSET',
      explanation:
        'Processing and webhook delivery use BullMQ. Without Redis those jobs cannot run.',
      fix: 'Set REDIS_URL to a Redis server, for example redis://127.0.0.1:6379.',
    });
  }
  const { Redis } = await import('ioredis');
  const client = new Redis(url, {
    connectTimeout: 800,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  client.on('error', () => undefined);
  try {
    await withTimeout(client.connect(), 1500);
    const pong = await withTimeout(client.ping(), 1500);
    if (pong !== 'PONG') throw new Error('no pong');
    const { Queue } = await import('bullmq');
    const { processingQueueName } =
      await import('../queue/processing-queue.js');
    const queue = new Queue(
      processingQueueName(config?.env ?? 'production', config?.storage.root),
      {
        connection: {
          url,
          connectTimeout: 800,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
          enableOfflineQueue: false,
        },
      },
    );
    try {
      await withTimeout(queue.getJobCounts('waiting'), 2000);
    } finally {
      await queue.close().catch(() => undefined);
    }
    return described({
      id: 'redis',
      status: 'pass',
      required: true,
      message: 'Redis answered and the BullMQ queue is readable.',
      code: 'OK',
      explanation:
        'PING succeeded and the processing queue accepted a status read.',
      fix: 'No change is required.',
    });
  } catch {
    return described({
      id: 'redis',
      status: 'fail',
      required: true,
      message: 'Redis or the BullMQ queue did not answer.',
      code: 'DOCTOR_REDIS_UNREACHABLE',
      explanation:
        'The configured Redis URL did not complete PING and a queue read.',
      fix: 'Start Redis at REDIS_URL and confirm the port is reachable.',
    });
  } finally {
    client.disconnect();
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('timeout'));
      },
    );
  });
}

async function scannerCheck(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  if (env.FILEVORA_MALWARE_SCAN !== 'clamav') {
    return described({
      id: 'scanner',
      status: 'pass',
      required: false,
      message: 'Malware scanning is not configured.',
      code: 'OK',
      explanation:
        'FILEVORA_MALWARE_SCAN is unset, so uploads are not scanned.',
      fix: 'Set FILEVORA_MALWARE_SCAN=clamav when a clamd INSTREAM listener is available.',
    });
  }
  const host = env.FILEVORA_CLAMAV_HOST || '127.0.0.1';
  const port = Number(env.FILEVORA_CLAMAV_PORT || 3310);
  const open = await tcpOpen(host, port);
  return described({
    id: 'scanner',
    status: open ? 'pass' : 'fail',
    required: false,
    message: open
      ? `ClamAV accepts connections at ${host}:${port}.`
      : `ClamAV did not accept a connection at ${host}:${port}.`,
    code: open ? 'OK' : 'DOCTOR_SCANNER_UNREACHABLE',
    explanation: 'The adapter speaks clamd INSTREAM on that host and port.',
    fix: open
      ? 'No change is required.'
      : 'Start clamd and set FILEVORA_CLAMAV_HOST and FILEVORA_CLAMAV_PORT.',
  });
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function signingSecretCheck(config: ResolvedConfig): DoctorCheck {
  const missing =
    config.defaults.visibility !== 'public' &&
    config.signingSecrets.length === 0;
  if (!missing) {
    return described({
      id: 'signing',
      status: 'pass',
      required: false,
      message: 'A signing secret is configured.',
      code: 'OK',
      explanation:
        'FILEVORA_SIGNING_SECRET signs private delivery URLs. The first key signs and every key verifies.',
      fix: 'No change is required.',
    });
  }
  return described({
    id: 'signing',
    status: 'warn',
    required: false,
    message: 'Private delivery has no FILEVORA_SIGNING_SECRET.',
    code: 'DOCTOR_SIGNING_SECRET',
    explanation:
      'The default visibility is private, so downloads need an HMAC secret. Without one, each process invents a key and other processes cannot verify the URLs.',
    fix: 'Set FILEVORA_SIGNING_SECRET to a long random string. During rotation, keep the previous key in the comma-separated list.',
  });
}

async function webhookCheck(config: ResolvedConfig): Promise<DoctorCheck> {
  if (!config.webhooks.url) {
    return described({
      id: 'webhook',
      status: 'pass',
      required: false,
      message: 'No completion webhook is configured.',
      code: 'OK',
      explanation: 'FILEVORA_WEBHOOK_URL is unset. Progress stays on SSE.',
      fix: 'Set FILEVORA_WEBHOOK_URL and FILEVORA_WEBHOOK_SECRET to enable webhooks.',
    });
  }
  if (!config.webhooks.secret) {
    return described({
      id: 'webhook',
      status: 'fail',
      required: false,
      message: 'The webhook URL has no secret.',
      code: 'DOCTOR_WEBHOOK_SECRET',
      explanation: 'Signed delivery needs a secret.',
      fix: 'Set FILEVORA_WEBHOOK_SECRET to a long random string.',
    });
  }
  try {
    await assertWebhookUrl(config.webhooks.url, config);
    return described({
      id: 'webhook',
      status: 'pass',
      required: false,
      message: 'The webhook URL passed the SSRF checks.',
      code: 'OK',
      explanation: 'The target uses the same address rules as URL import.',
      fix: 'No change is required.',
    });
  } catch (error) {
    const message = isFileSdkError(error)
      ? error.message
      : 'The webhook URL was rejected.';
    return described({
      id: 'webhook',
      status: 'fail',
      required: false,
      message,
      code: 'DOCTOR_WEBHOOK_INVALID',
      explanation: message,
      fix: 'Use an https URL. Localhost needs FILES_WEBHOOKS_ALLOW_LOOPBACK=true.',
    });
  }
}

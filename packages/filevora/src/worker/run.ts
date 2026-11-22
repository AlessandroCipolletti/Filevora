import { resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { fail, isFileSdkError } from '../errors/error.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite } from '../metadata/sqlite.js';
import {
  type MediaTransform,
  publishAudioPreset,
  publishRecipe,
  publishVideoPreset,
} from '../processors/ffmpeg.js';
import { publishImagePreset } from '../processors/image.js';
import {
  claimJob,
  failJob,
  finishJob,
  heartbeatJob,
  type JobRow,
} from '../queue/jobs.js';
import { JOB_SCHEMA_VERSION } from '../version.js';
import { heartbeatSupervisor } from './supervisor.js';

export interface WorkerRunOptions {
  /** Explicit options. When omitted, the worker reads `FILEVORA_CONFIG_PATH` or the process environment. */
  options?: FilesOptions;
  signal?: AbortSignal;
  /** Process at most one job, then return. Useful for a single recovery pass. */
  once?: boolean;
}

/**
 * Poll the durable queue until aborted. Importing this function does not start a loop;
 * the caller has to invoke it. The child must be configured with `spawn: "never"`.
 */
export async function runWorker(run: WorkerRunOptions = {}): Promise<void> {
  const options = run.options ?? (await readChildOptions());
  const config = resolveConfig(options, process.env);
  const sql = openSqlite(config.metadata.filename);
  migrate(sql);
  const owner = `worker:${process.pid}`;
  try {
    while (!run.signal?.aborted) {
      heartbeatSupervisor(sql, process.pid, config.queue.leaseSeconds);
      const job = claimJob(sql, owner, config.queue.leaseSeconds);
      if (!job) {
        if (run.once) return;
        await delay(config.queue.pollIntervalMs, run.signal);
        continue;
      }
      const timer = setInterval(
        () => heartbeatJob(sql, job.id, owner, config.queue.leaseSeconds),
        200,
      );
      const abort = new AbortController();
      const watch = setInterval(() => {
        const current = sql.get<{ state: string }>(
          'SELECT state FROM jobs WHERE id = ?',
          [job.id],
        );
        if (current?.state === 'cancelled') abort.abort();
      }, 100);
      try {
        const result = await executeJob(sql, job, config, abort.signal);
        finishJob(sql, job.id, result);
        if (job.type === 'test.hold') {
          sql.run(
            `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), job.file_id],
          );
        }
      } catch (error) {
        const sdk = isFileSdkError(error)
          ? error
          : fail('FFMPEG_FAILED', { message: 'The job failed.' });
        if (sdk.code === 'CANCELLED') {
          const now = new Date().toISOString();
          sql.run(
            `UPDATE jobs SET state = 'cancelled', error_code = 'CANCELLED', finished_at = ?, updated_at = ?, lease_until = NULL WHERE id = ?`,
            [now, now, job.id],
          );
          sql.run(
            `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
            [now, job.file_id],
          );
          if (run.once) return;
          continue;
        }
        const current =
          sql.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [job.id]) ?? job;
        failJob(
          sql,
          current,
          {
            code: String(sdk.code),
            message: sdk.message,
            retryable: sdk.retryable,
          },
          config.queue.backoffBaseMs,
        );
        sql.run(
          `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), job.file_id],
        );
      } finally {
        clearInterval(timer);
        clearInterval(watch);
      }
      if (run.once) return;
    }
  } finally {
    sql.close();
  }
}

async function executeJob(
  sql: ReturnType<typeof openSqlite>,
  job: JobRow,
  config: ReturnType<typeof resolveConfig>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (job.schema_version > JOB_SCHEMA_VERSION)
    throw fail('JOB_VERSION_UNSUPPORTED');
  const payload = JSON.parse(job.payload_json) as {
    delayMs?: number;
    transforms?: MediaTransform[];
  };
  if (job.type === 'test.hold') {
    if (config.env !== 'test') {
      throw fail('INVALID_RECIPE', {
        message: 'test.hold is only available when env is test.',
      });
    }
    await delay(Math.min(payload.delayMs ?? 0, 10_000), signal);
    return { held: true };
  }
  const file = sql.get<{
    id: string;
    tenant_id: string;
    detected_mime: string | null;
    original_object_key: string | null;
  }>(
    'SELECT id, tenant_id, detected_mime, original_object_key FROM files WHERE id = ?',
    [job.file_id],
  );
  if (!file) throw fail('NOT_FOUND');
  const paths = {
    ffmpeg: config.processing.ffmpegPath,
    ffprobe: config.processing.ffprobePath,
  };
  const limits = {
    timeoutMs: config.queue.timeoutSeconds * 1000,
    maxDurationSeconds: config.processing.videoMaxDurationSeconds,
    maxHeight: config.processing.videoMaxOutputHeight,
  };
  const hooks = { jobId: job.id, signal };
  if (job.type === 'recipe') {
    const names = await publishRecipe(
      sql,
      config.storage.root,
      file,
      payload.transforms ?? [],
      paths,
      limits,
      hooks,
    );
    return { variants: names, processingState: 'ready' };
  }
  if (job.type === 'preset') {
    if (file.detected_mime?.startsWith('image/')) {
      const names = await publishImagePreset(
        sql,
        config.storage.root,
        file,
        config.processing.imageMaxPixels,
      );
      return { variants: names, processingState: 'ready' };
    }
    if (file.detected_mime?.startsWith('video/')) {
      const names = await publishVideoPreset(
        sql,
        config.storage.root,
        file,
        paths,
        limits,
        hooks,
      );
      return { variants: names, processingState: 'ready' };
    }
    if (file.detected_mime?.startsWith('audio/')) {
      const names = await publishAudioPreset(
        sql,
        config.storage.root,
        file,
        paths,
        limits,
        hooks,
      );
      return { variants: names, processingState: 'ready' };
    }
    throw fail('PROCESSOR_UNAVAILABLE', {
      message: 'No processor is registered for this file type.',
    });
  }
  throw fail('INVALID_RECIPE', { message: `Unknown job type ${job.type}.` });
}

async function readChildOptions(): Promise<FilesOptions> {
  const configPath = process.env.FILEVORA_CONFIG_PATH;
  if (!configPath)
    throw fail('INVALID_CONFIG', {
      message: 'The worker requires FILEVORA_CONFIG_PATH or explicit options.',
    });
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(configPath, 'utf8')) as FilesOptions;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

import type { Job } from 'bullmq';
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
  type ProcessingJobData,
  processingQueue,
  processingQueueName,
  redisUrlFor,
  startProcessingWorker,
} from '../queue/processing-queue.js';
import { JOB_SCHEMA_VERSION } from '../version.js';
import { heartbeatSupervisor } from './supervisor.js';

export interface WorkerRunOptions {
  /** Explicit options. When omitted, the worker reads `FILEVORA_CONFIG_PATH` or the process environment. */
  options?: FilesOptions;
  signal?: AbortSignal;
  /** Process at most one job, then return. Useful for a single recovery pass. */
  once?: boolean;
  /** Stop after this many finished jobs. `once` means 1. */
  limit?: number;
}

/**
 * Consume the BullMQ processing queue. Importing this function does not start a worker.
 * Several machines can run `filevora worker` against the same REDIS_URL.
 * The child must be configured with `spawn: "never"`.
 */
export async function runWorker(run: WorkerRunOptions = {}): Promise<void> {
  const options = run.options ?? (await readChildOptions());
  const config = resolveConfig(options, process.env);
  const redisUrl = await redisUrlFor({
    env: config.env,
    redisUrl: config.queue.redisUrl,
  });
  const sql = openSqlite(config.metadata.filename);
  migrate(sql);
  const limit = run.once ? 1 : run.limit;
  const queueName = processingQueueName(config.env, config.metadata.filename);
  if (limit !== undefined) {
    const queue = await processingQueue(redisUrl, queueName);
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    const pending =
      (counts.waiting ?? 0) +
      (counts.active ?? 0) +
      (counts.delayed ?? 0) +
      (counts.prioritized ?? 0);
    if (pending === 0) {
      sql.close();
      return;
    }
  }
  let finished = 0;
  const worker = startProcessingWorker({
    redisUrl,
    queueName,
    concurrency: config.processing.concurrency,
    lockDurationMs: Math.max(1000, config.queue.leaseSeconds * 1000),
    processor: async (job) => executeJob(sql, job, config),
  });
  const beat = setInterval(
    () => heartbeatSupervisor(sql, process.pid, config.queue.leaseSeconds),
    500,
  );
  const stop = async () => {
    clearInterval(beat);
    await worker.close(true);
    sql.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const finishOne = () => {
        finished += 1;
        if (limit !== undefined && finished >= limit) resolve();
      };
      worker.on('completed', finishOne);
      worker.on('failed', finishOne);
      worker.on('error', (error) => reject(error));
      run.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    await stop();
  }
}

async function executeJob(
  sql: ReturnType<typeof openSqlite>,
  job: Job<ProcessingJobData>,
  config: ReturnType<typeof resolveConfig>,
): Promise<Record<string, unknown>> {
  const data = job.data;
  if (data.schemaVersion > JOB_SCHEMA_VERSION)
    throw fail('JOB_VERSION_UNSUPPORTED');
  const signal = new AbortController().signal;
  const payload = data.payload as {
    delayMs?: number;
    transforms?: MediaTransform[];
  };
  if (data.type === 'test.hold') {
    if (config.env !== 'test') {
      throw fail('INVALID_RECIPE', {
        message: 'test.hold is only available when env is test.',
      });
    }
    sql.run(
      `UPDATE files SET processing_state = 'processing', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), data.fileId],
    );
    await delay(Math.min(payload.delayMs ?? 0, 10_000), signal);
    sql.run(
      `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), data.fileId],
    );
    return { held: true };
  }
  const file = sql.get<{
    id: string;
    tenant_id: string;
    detected_mime: string | null;
    original_object_key: string | null;
  }>(
    'SELECT id, tenant_id, detected_mime, original_object_key FROM files WHERE id = ?',
    [data.fileId],
  );
  if (!file) throw fail('NOT_FOUND');
  sql.run(
    `UPDATE files SET processing_state = 'processing', updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), data.fileId],
  );
  const paths = {
    ffmpeg: config.processing.ffmpegPath,
    ffprobe: config.processing.ffprobePath,
  };
  const limits = {
    timeoutMs: config.queue.timeoutSeconds * 1000,
    maxDurationSeconds: config.processing.videoMaxDurationSeconds,
    maxHeight: config.processing.videoMaxOutputHeight,
  };
  const hooks = { jobId: job.id ?? data.fileId, signal };
  try {
    if (data.type === 'recipe') {
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
    if (data.type === 'preset') {
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
    throw fail('INVALID_RECIPE', { message: `Unknown job type ${data.type}.` });
  } catch (error) {
    const sdk = isFileSdkError(error)
      ? error
      : fail('FFMPEG_FAILED', { message: 'The job failed.' });
    const attempts = job.opts.attempts ?? 1;
    const terminal = !sdk.retryable || (job.attemptsMade ?? 0) + 1 >= attempts;
    if (terminal) {
      sql.run(
        `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), data.fileId],
      );
    }
    const wrapped = new Error(`${sdk.code}: ${sdk.message}`);
    if (!sdk.retryable) wrapped.name = 'UnrecoverableError';
    throw wrapped;
  }
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

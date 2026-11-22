import { resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { fail, isFileSdkError } from '../errors/error.js';
import { migrate } from '../metadata/migrate.js';
import { openSqlite } from '../metadata/sqlite.js';
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
      try {
        const result = await executeJob(sql, job, config);
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
): Promise<Record<string, unknown>> {
  if (job.schema_version > JOB_SCHEMA_VERSION)
    throw fail('JOB_VERSION_UNSUPPORTED');
  const payload = JSON.parse(job.payload_json) as { delayMs?: number };
  if (job.type === 'test.hold') {
    if (config.env !== 'test') {
      throw fail('INVALID_RECIPE', {
        message: 'test.hold is only available when env is test.',
      });
    }
    const delayMs = Math.min(payload.delayMs ?? 0, 10_000);
    await delay(delayMs);
    return { held: true };
  }
  if (job.type === 'preset') {
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
    if (file.detected_mime?.startsWith('image/')) {
      const names = await publishImagePreset(
        sql,
        config.storage.root,
        file,
        config.processing.imageMaxPixels,
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

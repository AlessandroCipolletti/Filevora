import type { Job } from 'bullmq';
import type { ResolvedConfig } from '../config/load.js';
import { resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { fail, isFileSdkError } from '../errors/error.js';
import { assetObjectKey, nowIso, sha256 } from '../ids.js';
import { openBackend } from '../metadata/backend.js';
import type { Sql } from '../metadata/sqlite.js';
import {
  type MediaTransform,
  publishAudioPreset,
  publishRecipe,
  publishVideoPreset,
} from '../processors/ffmpeg.js';
import { publishImagePreset } from '../processors/image.js';
import { publishNamedPreset } from '../presets/publish.js';
import { findPreset } from '../presets/catalog.js';
import {
  framePresetFromPayload,
  pdfStillPresetFromPayload,
} from '../presets/expand.js';
import { applyAssetTransform } from '../transform/apply.js';
import type { AssetTransformOperation } from '../transform/schema.js';
import {
  type ProcessingJobData,
  processingQueue,
  processingQueueName,
  redisUrlFor,
  startProcessingWorker,
} from '../queue/processing-queue.js';
import { JOB_SCHEMA_VERSION } from '../version.js';
import {
  enqueueWebhookJob,
  postWebhook,
  type WebhookEventName,
} from '../webhooks/deliver.js';
import { webhookProgress } from '../webhooks/payload.js';
import { runCleanup } from '../retention/cleanup.js';
import { mergePdfBuffers, splitPdfBuffer } from '../processors/pdf-tools.js';
import { openStorage, readAll } from '../storage/stage.js';
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
  if (config.retention.enabled) {
    const queue = await processingQueue(
      redisUrl,
      processingQueueName(config.env, config.storage.root),
    );
    await queue.upsertJobScheduler(
      'filevora-retention',
      {
        every: Math.max(1, config.retention.cleanupIntervalMinutes) * 60_000,
      },
      {
        name: 'retention',
        data: {
          fileId: 'retention',
          tenantId: 'system',
          type: 'retention',
          payload: { dryRun: false },
          schemaVersion: 1,
        },
      },
    );
  }
  const sql = await openBackend(config);
  const limit = run.once ? 1 : run.limit;
  const queueName = processingQueueName(config.env, config.storage.root);
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
      await sql.close();
      return;
    }
  }
  let finished = 0;
  const worker = startProcessingWorker({
    redisUrl,
    queueName,
    concurrency: config.processing.concurrency,
    lockDurationMs: Math.max(1000, config.queue.leaseSeconds * 1000),
    processor: async (job) => executeJob(sql, runnableFromBull(job), config),
  });
  const beat = setInterval(
    () => heartbeatSupervisor(config, process.pid, config.queue.leaseSeconds),
    500,
  );
  const stop = async () => {
    clearInterval(beat);
    await worker.close(true);
    await sql.close();
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

export interface RunnableJob {
  id?: string;
  data: ProcessingJobData;
  opts: { attempts?: number };
  attemptsMade?: number;
}

/** Run one processing job on an open metadata connection. Sync tests use this instead of BullMQ. */
export function executeProcessingJob(
  sql: Sql,
  job: RunnableJob,
  config: ResolvedConfig,
): Promise<Record<string, unknown>> {
  return executeJob(sql, job, config);
}

function runnableFromBull(job: Job<ProcessingJobData>): RunnableJob {
  return {
    ...(job.id ? { id: job.id } : {}),
    data: job.data,
    opts: { ...(job.opts.attempts ? { attempts: job.opts.attempts } : {}) },
    attemptsMade: job.attemptsMade,
  };
}

async function executeJob(
  sql: Sql,
  job: RunnableJob,
  config: ResolvedConfig,
): Promise<Record<string, unknown>> {
  const data = job.data;
  const storage = await openStorage(config.storage);
  try {
    if (data.type === 'retention') {
      const payload = data.payload as { dryRun?: boolean };
      const report = await runCleanup({
        sql,
        root: config.storage.root,
        storage,
        retention: config.retention,
        sessionTtlSeconds: config.upload.sessionTtlSeconds,
        dryRun: Boolean(payload.dryRun),
      });
      return { ...report };
    }
    if (data.type === 'webhook') {
      const payload = data.payload as {
        url?: string;
        secret?: string;
        event?: string;
        body?: string;
      };
      if (!payload.url || !payload.secret || !payload.body) {
        return { delivered: false };
      }
      await postWebhook({
        url: payload.url,
        secret: payload.secret,
        event: payload.event ?? 'processing.completed',
        body: payload.body,
        config,
      });
      return { delivered: true };
    }
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
      await sql.run(
        `UPDATE files SET processing_state = 'processing', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), data.fileId],
      );
      await delay(Math.min(payload.delayMs ?? 0, 10_000), signal);
      await sql.run(
        `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), data.fileId],
      );
      return { held: true };
    }
    const file = await sql.get<{
      id: string;
      tenant_id: string;
      detected_mime: string | null;
      original_object_key: string | null;
      preset: string | null;
    }>(
      'SELECT id, tenant_id, detected_mime, original_object_key, preset FROM files WHERE id = ?',
      [data.fileId],
    );
    if (!file) throw fail('NOT_FOUND');
    await sql.run(
      `UPDATE files SET processing_state = 'processing', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), data.fileId],
    );
    if (data.type === 'pdf.merge') {
      const sourceIds = Array.isArray(data.payload.sourceIds)
        ? data.payload.sourceIds.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
      const parts: Uint8Array[] = [];
      for (const sourceId of sourceIds) {
        const source = await sql.get<{
          tenant_id: string;
          original_object_key: string | null;
        }>('SELECT tenant_id, original_object_key FROM files WHERE id = ?', [
          sourceId,
        ]);
        if (
          !source?.original_object_key ||
          source.tenant_id !== data.tenantId
        ) {
          throw fail('NOT_FOUND');
        }
        parts.push(
          Buffer.from(
            await readAll(await storage.getObject(source.original_object_key)),
          ),
        );
      }
      const merged = await mergePdfBuffers(parts);
      const key = assetObjectKey(data.tenantId, data.fileId, 'original', 'pdf');
      await storage.putObject({
        key,
        body: merged,
        contentType: 'application/pdf',
      });
      await sql.run(
        `UPDATE files SET bytes = ?, checksum = ?, original_object_key = ?, upload_state = 'verified', processing_state = 'ready', updated_at = ? WHERE id = ?`,
        [merged.byteLength, sha256(merged), key, nowIso(), data.fileId],
      );
      await notifyTerminal(sql, config, data, 'processing.completed');
      return { assetId: data.fileId, processingState: 'ready' };
    }
    if (data.type === 'pdf.split') {
      const source = await sql.get<{
        tenant_id: string;
        original_object_key: string | null;
      }>('SELECT tenant_id, original_object_key FROM files WHERE id = ?', [
        data.fileId,
      ]);
      if (!source?.original_object_key || source.tenant_id !== data.tenantId) {
        throw fail('NOT_FOUND');
      }
      const outputs = Array.isArray(data.payload.outputs)
        ? data.payload.outputs
        : [];
      const ranges = outputs.map((item) => {
        const record = item as { pages?: unknown };
        return Array.isArray(record.pages)
          ? record.pages.filter(
              (page): page is number => typeof page === 'number',
            )
          : [];
      });
      const pieces = await splitPdfBuffer(
        Buffer.from(
          await readAll(await storage.getObject(source.original_object_key)),
        ),
        ranges,
      );
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = pieces[index];
        const target = outputs[index] as { assetId?: string } | undefined;
        if (!piece || !target?.assetId) continue;
        const key = assetObjectKey(
          data.tenantId,
          target.assetId,
          'original',
          'pdf',
        );
        await storage.putObject({
          key,
          body: piece,
          contentType: 'application/pdf',
        });
        await sql.run(
          `UPDATE files SET bytes = ?, checksum = ?, original_object_key = ?, upload_state = 'verified', processing_state = 'ready', updated_at = ? WHERE id = ? AND tenant_id = ?`,
          [
            piece.byteLength,
            sha256(piece),
            key,
            nowIso(),
            target.assetId,
            data.tenantId,
          ],
        );
      }
      await sql.run(
        `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
        [nowIso(), data.fileId],
      );
      await notifyTerminal(sql, config, data, 'processing.completed');
      return { assetIds: outputs, processingState: 'ready' };
    }
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
          storage,
          file,
          payload.transforms ?? [],
          paths,
          limits,
          hooks,
        );
        await notifyTerminal(sql, config, data, 'processing.completed');
        return { variants: names, processingState: 'ready' };
      }
      if (data.type === 'transform') {
        const jobPayload = data.payload as {
          sourceFileId?: string;
          sourceKey?: string;
          mime?: string;
          operations?: AssetTransformOperation[];
        };
        await applyAssetTransform({
          sql,
          storage,
          ffmpeg: config.processing.ffmpegPath,
          ffprobe: config.processing.ffprobePath,
          timeoutMs: config.queue.timeoutSeconds * 1000,
          jobId: job.id ?? data.fileId,
          sourceId: jobPayload.sourceFileId ?? data.fileId,
          targetId: data.fileId,
          tenantId: data.tenantId,
          mime: jobPayload.mime ?? file.detected_mime ?? '',
          sourceKey: jobPayload.sourceKey ?? file.original_object_key ?? '',
          operations: jobPayload.operations ?? [],
          exif: config.safety.exif,
          ...(config.safety.scanner ? { scanner: config.safety.scanner } : {}),
        });
        await notifyTerminal(sql, config, data, 'transform.completed');
        return { variants: ['_original'], processingState: 'ready' };
      }
      if (data.type === 'preset') {
        const requested =
          typeof data.payload.preset === 'string'
            ? data.payload.preset
            : file.preset || 'web-optimized';
        const named =
          framePresetFromPayload(requested, data.payload.outputs) ??
          pdfStillPresetFromPayload(requested, data.payload.outputs) ??
          findPreset(requested, config.presets);
        if (!named) {
          throw fail('TRANSFORM_REJECTED', {
            message: `Unknown preset "${requested}".`,
            context: {
              field: 'preset',
              reason: `Unknown preset "${requested}".`,
            },
          });
        }
        if (named.delivery !== 'legacy') {
          const names = await publishNamedPreset({
            sql,
            storage,
            file,
            preset: named,
            exif: config.safety.exif,
            ffmpeg: paths.ffmpeg,
            ffprobe: paths.ffprobe,
            timeoutMs: limits.timeoutMs,
            jobId: job.id ?? data.fileId,
            maxPixels: config.processing.imageMaxPixels,
            maxHeight: limits.maxHeight,
            ...(signal ? { signal } : {}),
          });
          await notifyTerminal(sql, config, data, 'processing.completed');
          return { variants: names, processingState: 'ready' };
        }
        if (file.detected_mime?.startsWith('image/')) {
          const names = await publishImagePreset(
            sql,
            storage,
            file,
            config.processing.imageMaxPixels,
            config.safety.exif,
          );
          await notifyTerminal(sql, config, data, 'processing.completed');
          return { variants: names, processingState: 'ready' };
        }
        if (file.detected_mime?.startsWith('video/')) {
          const names = await publishVideoPreset(
            sql,
            storage,
            file,
            paths,
            limits,
            hooks,
          );
          await notifyTerminal(sql, config, data, 'processing.completed');
          return { variants: names, processingState: 'ready' };
        }
        if (file.detected_mime?.startsWith('audio/')) {
          const names = await publishAudioPreset(
            sql,
            storage,
            file,
            paths,
            limits,
            hooks,
          );
          await notifyTerminal(sql, config, data, 'processing.completed');
          return { variants: names, processingState: 'ready' };
        }
        throw fail('PROCESSOR_UNAVAILABLE', {
          message: 'No processor is registered for this file type.',
        });
      }
      throw fail('INVALID_RECIPE', {
        message: `Unknown job type ${data.type}.`,
      });
    } catch (error) {
      if (data.type === 'webhook') throw error;
      const sdk = isFileSdkError(error)
        ? error
        : fail('FFMPEG_FAILED', { message: 'The job failed.' });
      const attempts = job.opts.attempts ?? 1;
      const terminal =
        !sdk.retryable || (job.attemptsMade ?? 0) + 1 >= attempts;
      if (terminal) {
        const malware =
          sdk.code === 'MALWARE_DETECTED' || sdk.code === 'MALWARE_SCAN_FAILED';
        await sql.run(
          malware
            ? `UPDATE files SET processing_state = ?, metadata_json = ?, updated_at = ? WHERE id = ?`
            : `UPDATE files SET processing_state = 'failed', updated_at = ? WHERE id = ?`,
          malware
            ? [
                sdk.code === 'MALWARE_DETECTED' ? 'quarantined' : 'failed',
                JSON.stringify({ filevoraSafetyError: sdk.code }),
                new Date().toISOString(),
                data.fileId,
              ]
            : [new Date().toISOString(), data.fileId],
        );
        await notifyTerminal(sql, config, data, 'processing.failed');
      }
      const wrapped = new Error(`${sdk.code}: ${sdk.message}`);
      if (!sdk.retryable) wrapped.name = 'UnrecoverableError';
      throw wrapped;
    }
  } finally {
    await storage.close?.();
  }
}

async function notifyTerminal(
  sql: Sql,
  config: ResolvedConfig,
  data: ProcessingJobData,
  event: WebhookEventName,
): Promise<void> {
  try {
    const row = await sql.get<{ metadata_json: string }>(
      'SELECT metadata_json FROM files WHERE id = ?',
      [data.fileId],
    );
    const meta = parseMeta(row?.metadata_json);
    const url = meta.filevoraWebhookUrl || config.webhooks.url;
    const secret = meta.filevoraWebhookSecret || config.webhooks.secret;
    if (!url || !secret) return;
    const progress = await webhookProgress(sql, config, data.fileId);
    await enqueueWebhookJob({
      config,
      fileId: data.fileId,
      tenantId: data.tenantId,
      event,
      url,
      secret,
      body: JSON.stringify(progress),
    });
  } catch {
    // Delivery is queued separately. A snapshot problem must not fail the encode.
  }
}

function parseMeta(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

async function readChildOptions(): Promise<FilesOptions> {
  const configPath = process.env.FILEVORA_CONFIG_PATH;
  if (!configPath) return {};
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

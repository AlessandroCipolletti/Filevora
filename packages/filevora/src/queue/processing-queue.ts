import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { fail } from '../errors/error.js';
import { estimateRemainingMs } from '../progress/estimate.js';

export const PROCESSING_QUEUE = 'filevora-processing';

export interface ProcessingJobData {
  fileId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
}

const queues = new Map<string, Queue<ProcessingJobData>>();

/** Test processes share one Redis. Isolate their queues by metadata file. */
export function processingQueueName(env: string, scope?: string): string {
  if (env !== 'test' || !scope) return PROCESSING_QUEUE;
  const key = createHash('sha256')
    .update(path.resolve(scope))
    .digest('hex')
    .slice(0, 20);
  return `fv-${key}`;
}

function unrefStream(stream: { unref?: () => void } | null | undefined): void {
  stream?.unref?.();
}

function unrefProcess(child: ChildProcess | null | undefined): void {
  child?.unref();
  unrefStream(child?.stdout as { unref?: () => void } | null);
  unrefStream(child?.stderr as { unref?: () => void } | null);
  unrefStream(child?.stdin as { unref?: () => void } | null);
}

let memoryRedis: Promise<string> | undefined;

/** Redis is the processing queue. Asset ids are not stored here as a registry. */
export async function redisUrlFor(input: {
  env: string;
  redisUrl?: string;
}): Promise<string> {
  const configured =
    input.redisUrl ||
    process.env.REDIS_URL ||
    process.env.FILES_REDIS_URL ||
    '';
  if (configured) {
    process.env.REDIS_URL = configured;
    return configured;
  }
  if (input.env !== 'test') {
    throw fail('INVALID_CONFIG', {
      message:
        'Processing jobs use BullMQ. Set REDIS_URL to a Redis server. Asset ids stay in the metadata database, not in Redis.',
    });
  }
  if (!memoryRedis) {
    memoryRedis = (async () => {
      const { RedisMemoryServer } = await import('redis-memory-server');
      const server = new RedisMemoryServer();
      const host = await server.getHost();
      const port = await server.getPort();
      const info = server.getInstanceInfo();
      if (info) {
        unrefProcess(info.childProcess);
        unrefProcess(info.instance.killerProcess);
      }
      const url = `redis://${host}:${port}`;
      process.env.REDIS_URL = url;
      return url;
    })();
  }
  return memoryRedis;
}

function connection(url: string) {
  return { url, maxRetriesPerRequest: null as null };
}

export async function processingQueue(
  redisUrl: string,
  name = PROCESSING_QUEUE,
): Promise<Queue<ProcessingJobData>> {
  const cacheKey = `${name}|${redisUrl}`;
  const existing = queues.get(cacheKey);
  if (existing) return existing;
  const queue = new Queue<ProcessingJobData>(name, {
    connection: connection(redisUrl),
  });
  queues.set(cacheKey, queue);
  return queue;
}

export async function enqueueProcessingJob(input: {
  env: string;
  redisUrl?: string;
  id: string;
  fileId: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  backoffMs: number;
  scope?: string;
}): Promise<string> {
  const url = await redisUrlFor({ env: input.env, redisUrl: input.redisUrl });
  const queue = await processingQueue(
    url,
    processingQueueName(input.env, input.scope),
  );
  const current = await queue.getJob(input.id);
  if (current) return input.id;
  try {
    await queue.add(
      input.type,
      {
        fileId: input.fileId,
        tenantId: input.tenantId,
        type: input.type,
        payload: input.payload,
        schemaVersion: 1,
      },
      {
        jobId: input.id,
        attempts: input.maxAttempts,
        backoff: { type: 'exponential', delay: input.backoffMs },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: false,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('Job') && !message.includes('exists')) throw error;
  }
  return input.id;
}

export async function readProcessingJob(input: {
  env: string;
  redisUrl?: string;
  id: string;
  scope?: string;
}): Promise<Job<ProcessingJobData> | undefined> {
  const url = await redisUrlFor(input);
  const queue = await processingQueue(
    url,
    processingQueueName(input.env, input.scope),
  );
  return (await queue.getJob(input.id)) ?? undefined;
}

export async function closeProcessingQueue(input: {
  env: string;
  scope?: string;
}): Promise<void> {
  const url = process.env.REDIS_URL || process.env.FILES_REDIS_URL;
  if (!url) return;
  const cacheKey = `${processingQueueName(input.env, input.scope)}|${url}`;
  const queue = queues.get(cacheKey);
  if (!queue) return;
  queues.delete(cacheKey);
  await queue.close();
}

export async function removeProcessingJob(input: {
  env: string;
  redisUrl?: string;
  id: string;
  scope?: string;
}): Promise<void> {
  const job = await readProcessingJob(input);
  if (!job) return;
  await job.remove().catch(() => undefined);
}

const progressKey = (fileId: string) => `filevora:progress:${fileId}`;
const runnerKey = (jobId: string) => `filevora:runner:${jobId}`;

/** FFmpeg pid for a queue job. This is worker telemetry, not asset metadata. */
export async function recordRunnerPid(
  jobId: string,
  pid: number | null,
): Promise<void> {
  const url = process.env.REDIS_URL || process.env.FILES_REDIS_URL;
  if (!url) return;
  const client = new Redis(url, { maxRetriesPerRequest: null });
  if (pid === null) await client.del(runnerKey(jobId));
  else await client.set(runnerKey(jobId), String(pid), 'EX', 3600);
  await client.quit();
}

export async function readRunnerPid(jobId: string): Promise<number | null> {
  const url = process.env.REDIS_URL || process.env.FILES_REDIS_URL;
  if (!url) return null;
  const client = new Redis(url, { maxRetriesPerRequest: null });
  const value = await client.get(runnerKey(jobId));
  await client.quit();
  const pid = value ? Number(value) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function recordProcessingProgress(
  fileId: string,
  ratio: number,
  startedAtMs: number,
): Promise<void> {
  const url = process.env.REDIS_URL || process.env.FILES_REDIS_URL;
  if (!url) return;
  const client = new Redis(url, { maxRetriesPerRequest: null });
  const bounded = Math.min(1, Math.max(0, ratio));
  const eta = estimateRemainingMs(startedAtMs, bounded, Date.now());
  await client.hset(progressKey(fileId), {
    ratio: String(bounded),
    etaMs: eta === null ? '' : String(eta),
  });
  await client.quit();
}

export async function readProcessingProgress(fileId: string): Promise<{
  ratio: number | null;
  etaMs: number | null;
}> {
  const url = process.env.REDIS_URL || process.env.FILES_REDIS_URL;
  if (!url) return { ratio: null, etaMs: null };
  const client = new Redis(url, { maxRetriesPerRequest: null });
  const value = await client.hgetall(progressKey(fileId));
  await client.quit();
  if (!value.ratio) return { ratio: null, etaMs: null };
  const ratio = Number(value.ratio);
  const eta = value.etaMs ? Number(value.etaMs) : null;
  return {
    ratio: Number.isFinite(ratio) ? ratio : null,
    etaMs: eta !== null && Number.isFinite(eta) ? eta : null,
  };
}

export function startProcessingWorker(input: {
  redisUrl: string;
  queueName?: string;
  concurrency: number;
  lockDurationMs: number;
  processor: (job: Job<ProcessingJobData>) => Promise<Record<string, unknown>>;
}): Worker<ProcessingJobData> {
  return new Worker<ProcessingJobData>(
    input.queueName ?? PROCESSING_QUEUE,
    input.processor,
    {
      connection: connection(input.redisUrl),
      concurrency: input.concurrency,
      lockDuration: input.lockDurationMs,
      stalledInterval: 1000,
      maxStalledCount: 5,
    },
  );
}

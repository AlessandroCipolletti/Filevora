import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadClient } from '../dist/client/index.js';
import {
  closeProcessingQueue,
  enqueueProcessingJob,
} from '../dist/queue/processing-queue.js';

test('waitForProcessing keeps polling a URL import that is still downloading', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const body =
      calls < 3
        ? { id: 'file_1', processingState: 'none', uploadState: 'uploading' }
        : { id: 'file_1', processingState: 'ready', uploadState: 'verified' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createUploadClient({
    endpoint: 'http://app.local',
    fetch: fetchImpl,
  });
  const ready = await client.waitForProcessing('file_1', {
    intervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(ready.processingState, 'ready');
  assert.ok(calls >= 3);
});

test('an unreachable Redis URL fails instead of retrying forever', async () => {
  const previous = process.env.REDIS_URL;
  const started = Date.now();
  try {
    await assert.rejects(
      () =>
        enqueueProcessingJob({
          env: 'production',
          redisUrl: 'redis://127.0.0.1:1',
          id: 'job_unreachable',
          fileId: 'file_unreachable',
          tenantId: 'tenant-a',
          type: 'preset',
          payload: {},
          maxAttempts: 1,
          backoffMs: 100,
        }),
      (error: { code?: string; message?: string }) =>
        error.code === 'INVALID_CONFIG' &&
        (error.message ?? '').includes('Redis'),
    );
    assert.ok(Date.now() - started < 8_000);
  } finally {
    await Promise.race([
      closeProcessingQueue({ env: 'production' }),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});

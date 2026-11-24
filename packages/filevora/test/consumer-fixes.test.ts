import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createUploadClient } from '../dist/client/index.js';

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

test('an unreachable Redis URL fails instead of retrying forever', () => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { enqueueProcessingJob } from './dist/queue/processing-queue.js';
       const started = Date.now();
       try {
         await enqueueProcessingJob({
           env: 'production',
           redisUrl: 'redis://127.0.0.1:1',
           id: 'job_unreachable',
           fileId: 'file_unreachable',
           tenantId: 'tenant-a',
           type: 'preset',
           payload: {},
           maxAttempts: 1,
           backoffMs: 100,
         });
         process.exit(2);
       } catch (error) {
         if (error?.code !== 'INVALID_CONFIG' || !String(error.message).includes('Redis')) process.exit(3);
         if (Date.now() - started > 8000) process.exit(4);
         process.exit(0);
       }`,
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 12_000,
      env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' },
    },
  );
  assert.equal(
    child.status,
    0,
    child.stderr || child.stdout || child.error?.message,
  );
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createUploadClient } from '../dist/client/index.js';
import { resolveConfig } from '../dist/config/load.js';
import { createFilesHandler } from '../dist/http/index.js';
import { openBackend } from '../dist/metadata/backend.js';
import { runCleanup } from '../dist/retention/cleanup.js';
import { createFiles } from '../dist/server/index.js';
import { openStorage } from '../dist/storage/stage.js';
import { samplePng } from '../dist/testing/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

const SECRET = 'signing-key-current-a';

test('embedded worker options keep S3 settings', () => {
  const resolved = resolveConfig(
    {
      env: 'test',
      storage: {
        driver: 's3',
        root: path.join(tmpdir(), 'filevora-worker-options'),
        s3: {
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          bucket: 'uploads',
          accessKeyId: 'local',
          secretAccessKey: 'localpassword',
          forcePathStyle: true,
        },
      },
      signingSecrets: [SECRET],
    },
    {},
  );
  const options = workerConfigOptions(resolved);
  assert.equal(options.storage?.driver, 's3');
  assert.equal(options.storage?.s3?.bucket, 'uploads');
  assert.equal(options.storage?.s3?.endpoint, 'http://127.0.0.1:9000');
  assert.equal(options.storage?.s3?.accessKeyId, 'local');
  assert.equal(options.processing?.mode, 'inline');
});

test('MinIO lite and stored flows', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
    return;
  }
  const region = process.env.FILEVORA_S3_REGION ?? 'us-east-1';
  const accessKeyId = process.env.FILEVORA_S3_ACCESS_KEY_ID ?? 'local';
  const secretAccessKey =
    process.env.FILEVORA_S3_SECRET_ACCESS_KEY ?? 'localpassword';
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await runMode(client, {
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      bucket: 'filevora-matrix-lite',
      mode: 'lite',
    });
    await runMode(client, {
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      bucket: 'filevora-matrix-stored',
      mode: 'stored',
    });
  } finally {
    client.destroy();
  }
});

async function runMode(
  client: S3Client,
  target: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    mode: 'lite' | 'stored';
  },
): Promise<void> {
  await client
    .send(new CreateBucketCommand({ Bucket: target.bucket }))
    .catch(() => undefined);
  const dir = mkdtempSync(path.join(tmpdir(), `filevora-s3-${target.mode}-`));
  const principal = { id: 'user-a', tenantId: `tenant-${target.mode}` };
  const options = {
    env: 'test' as const,
    storage: {
      driver: 's3' as const,
      root: dir,
      s3: {
        endpoint: target.endpoint,
        region: target.region,
        bucket: target.bucket,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        forcePathStyle: true,
      },
    },
    ...(target.mode === 'stored'
      ? { metadata: { filename: path.join(dir, 'meta.sqlite') } }
      : {}),
    processing: { mode: 'sync' as const, spawn: 'never' as const },
    upload: { chunkBytes: 64 * 1024 },
    defaults: { allowPublicFiles: true },
    signingSecrets: [SECRET],
    retention: {
      enabled: true,
      maxAgeDays: 1,
      gracePeriodDays: 0,
    },
    remote: { allowPrivate: true, allowedPorts: [80, 443] },
  };
  const files = createFiles(options);
  const handler = createFilesHandler({
    files,
    async authenticate() {
      return principal;
    },
    async authorize() {
      return true;
    },
    async policy() {
      return {};
    },
  });
  const png = samplePng();
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(png);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const remoteFiles = createFiles({
    ...options,
    remote: { allowPrivate: true, allowedPorts: [port, 80, 443] },
  });
  try {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(target.endpoint)) return fetch(input, init);
      return handler(new Request(input, init));
    };
    const uploader = createUploadClient({
      endpoint: 'http://app.local',
      fetch: fetchImpl,
      headers: { 'x-user': principal.id, 'x-tenant': principal.tenantId },
      resumeStore: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
      },
    });
    const uploaded = await uploader
      .upload(new File([png], 'dot.png', { type: 'image/png' }), {
        resume: { enabled: false },
        preset: 'thumbnail',
      })
      .complete();
    assert.equal(uploaded.processingState, 'ready');
    const delivery = await files.getDeliveryUrls(
      uploaded.id,
      { baseUrl: 'http://app.local', expiresInSeconds: 900 },
      { principal },
    );
    assert.equal(delivery.variants.thumbnail !== undefined, true);
    const originalUrl = delivery.original?.url ?? '';
    assert.equal(originalUrl.toLowerCase().includes('x-amz-signature'), true);
    const cold = createFiles(options);
    try {
      const coldHandler = createFilesHandler({
        files: cold,
        async authenticate() {
          return principal;
        },
        async authorize() {
          return true;
        },
        async policy() {
          return {};
        },
      });
      const signed = await files.signUrl(
        uploaded.id,
        { version: 'thumbnail', baseUrl: 'http://app.local' },
        { principal },
      );
      const ranged = await coldHandler(
        new Request(signed.url, { headers: { range: 'bytes=0-3' } }),
      );
      assert.equal(ranged.status, 206);
      assert.match(ranged.headers.get('content-range') ?? '', /^bytes 0-3\//);
      await files.setVisibility(uploaded.id, 'public', { principal });
      const published = await coldHandler(
        new Request(`http://app.local/public/${uploaded.id}/_original`, {
          headers: { range: 'bytes=0-3' },
        }),
      );
      assert.equal(published.status, 206);
    } finally {
      await cold.close();
    }
    const transformed = await files.transform(
      uploaded.id,
      { operations: [{ op: 'image.resize', width: 8, height: 8 }] },
      { principal },
    );
    assert.equal(transformed.launched, true);
    assert.equal(
      (await files.get(uploaded.id, { principal })).processingState,
      'ready',
    );
    const imported = await remoteFiles.createFromUrl(
      { url: `http://127.0.0.1:${port}/dot.png`, preset: 'thumbnail' },
      { principal },
    );
    const ready = await waitReady(remoteFiles, imported.id, principal);
    assert.equal(ready.processingState, 'ready');
    if (target.mode === 'lite') {
      const cards = path.join(dir, '.filevora', 'files');
      let localCards: string[] = [];
      try {
        localCards = readdirSync(cards);
      } catch {
        localCards = [];
      }
      assert.deepEqual(localCards, []);
      const storage = await openStorage(resolveConfig(options, {}).storage);
      try {
        const listed = await storage.list('.filevora/files/');
        assert.equal(
          listed.some((item) => item.key.endsWith('.json')),
          true,
        );
      } finally {
        await storage.close?.();
      }
    }
    const signed = await files.signUrl(
      uploaded.id,
      { baseUrl: 'http://app.local' },
      { principal },
    );
    await files.delete(uploaded.id, { principal });
    const gone = await handler(new Request(signed.url));
    assert.equal(gone.status, 403);
    const config = resolveConfig(
      {
        ...options,
        remote: { allowPrivate: true, allowedPorts: [port, 80, 443] },
      },
      {},
    );
    const sql = await openBackend(config);
    const storage = await openStorage(config.storage);
    try {
      const report = await runCleanup({
        sql,
        root: dir,
        storage,
        retention: config.retention,
        sessionTtlSeconds: config.upload.sessionTtlSeconds,
        nowMs: Date.now() + 3 * 86_400_000,
      });
      assert.equal(report.filesDeleted >= 1, true);
      const left = await storage.list('');
      assert.equal(
        left.some((item) => item.key.includes(`${imported.id}_`)),
        false,
      );
    } finally {
      await storage.close?.();
      await sql.close();
    }
  } finally {
    server.close();
    await files.close();
    await remoteFiles.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitReady(
  files: ReturnType<typeof createFiles>,
  id: string,
  principal: { id: string; tenantId: string },
): Promise<{ processingState: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = await files.get(id, { principal });
    if (row.processingState === 'ready' || row.processingState === 'failed') {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`asset ${id} did not finish`);
}

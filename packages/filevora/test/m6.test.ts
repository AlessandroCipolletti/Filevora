import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/cli/main.js';
import { createUploadClient } from '../dist/client/index.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';
import { startS3Emulator } from '../dist/storage/s3-emulator.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const secret = 'localpassword';

test('browser upload goes to the S3 emulator and filesystem mode still works', async () => {
  const emulator = await startS3Emulator({ bucket: 'uploads', secret });
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m6-'));
  const files = createFiles({
    env: 'test',
    storage: {
      driver: 's3',
      s3: {
        endpoint: emulator.url,
        region: 'us-east-1',
        bucket: 'uploads',
        accessKeyId: 'local',
        secretAccessKey: secret,
        forcePathStyle: true,
      },
    },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
  });
  const handler = createFilesHandler({
    files,
    async authenticate() {
      return { id: 'user-a', tenantId: 'tenant-a' };
    },
    async authorize() {
      return true;
    },
    async policy() {
      return {};
    },
  });
  let sessionJson = '';
  let directPut = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(emulator.url)) {
      if ((init?.method ?? 'GET') === 'PUT') directPut = url;
      return fetch(input, init);
    }
    const response = await handler(new Request(input, init));
    if (url.endsWith('/sessions') && init?.method === 'POST')
      sessionJson = await response.clone().text();
    return response;
  };
  try {
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: fetchImpl,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      resumeStore: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
      },
    });
    const uploaded = await client
      .upload(new File([PNG], 'dot.png', { type: 'image/png' }), {
        resume: { enabled: false },
      })
      .complete();
    assert.equal(
      uploaded.checksum,
      createHash('sha256').update(PNG).digest('hex'),
    );
    assert.equal(sessionJson.includes(secret), false);
    assert.equal(directPut.startsWith(emulator.url), true);
    assert.equal(directPut.includes(secret), false);
    const delivery = await files.getDeliveryUrls(
      uploaded.id,
      { baseUrl: 'http://app.local', expiresInSeconds: 900 },
      { principal: { id: 'user-a', tenantId: 'tenant-a' } },
    );
    assert.equal(delivery.original?.url.startsWith(emulator.url), true);
    assert.equal(delivery.original?.url.includes(secret), false);
    const downloaded = await fetch(delivery.original?.url ?? '');
    assert.equal(downloaded.status, 200);
    assert.equal(
      Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), PNG),
      0,
    );

    const local = createFiles({
      env: 'test',
      storage: { root: path.join(dir, 'objects') },
      metadata: { filename: path.join(dir, 'local.sqlite') },
      upload: { chunkBytes: 64 * 1024 },
      processing: { mode: 'inline', spawn: 'never' },
    });
    const session = await local.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: PNG.byteLength },
      { principal: { id: 'user-a', tenantId: 'tenant-a' } },
    );
    assert.equal(session.transport, 'chunked-http');
    await local.writePart(session.id, 1, PNG, {
      principal: { id: 'user-a', tenantId: 'tenant-a' },
    });
    const record = await local.completeUpload(
      session.id,
      {},
      { principal: { id: 'user-a', tenantId: 'tenant-a' } },
    );
    assert.equal(
      record.checksum,
      createHash('sha256').update(PNG).digest('hex'),
    );
    await local.close();
  } finally {
    await files.close();
    await emulator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init writes a MinIO compose file and does not start Docker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m6-init-'));
  try {
    const lines: string[] = [];
    const code = await runCli(
      ['init', '--profile', 'local-s3', '--dir', dir],
      {},
      {
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
      },
    );
    assert.equal(code, 0);
    const compose = readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.equal(compose.includes('minio/minio'), true);
    assert.equal(JSON.parse(lines.join('')).started, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

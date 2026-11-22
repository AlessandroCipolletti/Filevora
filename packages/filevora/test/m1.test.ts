import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';
import { assertSafeKey } from '../dist/storage/filesystem.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

function principal(id = 'user-a', tenantId = 'tenant-a') {
  return { id, tenantId };
}

async function app(dir: string, extra: Record<string, unknown> = {}) {
  const files = createFiles({
    env: 'test',
    storage: { driver: 'filesystem', root: path.join(dir, 'objects') },
    metadata: { driver: 'sqlite', filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    signingSecret: 'test-signing-secret-value',
    ...extra,
  });
  const handler = createFilesHandler({
    files,
    async authenticate(request) {
      const id = request.headers.get('x-user');
      const tenantId = request.headers.get('x-tenant');
      if (!id || !tenantId) return null;
      return { id, tenantId };
    },
    async authorize() {
      return true;
    },
    async policy({ principal: who }) {
      return { ownerId: who.id };
    },
  });
  return { files, handler };
}

async function uploadPng(
  handler: (request: Request) => Promise<Response>,
  user = 'user-a',
  tenant = 'tenant-a',
) {
  const created = await handler(
    new Request('http://app.local/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user': user,
        'x-tenant': tenant,
      },
      body: JSON.stringify({
        filename: '../../etc/passwd.png',
        mimeType: 'image/png',
        bytes: PNG.byteLength,
        ownerId: 'attacker',
        tenantId: 'other-tenant',
      }),
    }),
  );
  const session = (await created.json()) as {
    id: string;
    fileId: string;
    partCount: number;
    ownerId: string;
    error?: { code: string };
  };
  assert.equal(created.status, 201, JSON.stringify(session));
  const part = await handler(
    new Request(`http://app.local/sessions/${session.id}/parts/1`, {
      method: 'PUT',
      headers: { 'x-user': user, 'x-tenant': tenant },
      body: PNG,
    }),
  );
  assert.equal(part.status, 200, await part.clone().text());
  const completed = await handler(
    new Request(`http://app.local/sessions/${session.id}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user': user,
        'x-tenant': tenant,
      },
      body: '{}',
    }),
  );
  const done = (await completed.json()) as {
    file: {
      id: string;
      originalName: string;
      ownerId: string;
      tenantId: string;
      checksum: string;
      uploadState: string;
    };
  };
  assert.equal(completed.status, 200, JSON.stringify(done));
  return { session, file: done.file };
}

test('filesystem upload survives restart and stays inside the tenant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m1-'));
  try {
    const first = await app(dir);
    const { file } = await uploadPng(first.handler);
    assert.equal(file.originalName, 'passwd.png');
    assert.equal(file.ownerId, 'user-a');
    assert.equal(file.tenantId, 'tenant-a');
    assert.equal(file.uploadState, 'verified');
    const delivery = await first.handler(
      new Request(`http://app.local/files/${file.id}/delivery`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user': 'user-a',
          'x-tenant': 'tenant-a',
        },
        body: '{}',
      }),
    );
    const urls = (await delivery.json()) as { original: { url: string } };
    assert.equal(delivery.status, 200);
    const contentUrl = new URL(urls.original.url);
    const downloaded = await first.handler(new Request(contentUrl));
    assert.equal(downloaded.status, 200);
    assert.equal(
      Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), PNG),
      0,
    );
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    const ranged = await first.handler(
      new Request(contentUrl, { headers: { range: 'bytes=0-2' } }),
    );
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 3);
    await first.files.close();

    const second = await app(dir);
    const again = await second.files.get(file.id, { principal: principal() });
    assert.equal(again.checksum, file.checksum);
    const otherTenant = await second.handler(
      new Request(`http://app.local/files/${file.id}`, {
        headers: { 'x-user': 'user-b', 'x-tenant': 'tenant-b' },
      }),
    );
    assert.equal(otherTenant.status, 404);
    const forbiddenHandler = createFilesHandler({
      files: second.files,
      authenticate: async () => ({ id: 'user-b', tenantId: 'tenant-b' }),
      authorize: async () => false,
      policy: async () => ({}),
    });
    const forbidden = await forbiddenHandler(
      new Request(`http://app.local/files/${file.id}`),
    );
    assert.equal(forbidden.status, 403);
    await second.files.delete(file.id, { principal: principal() });
    await assert.rejects(
      second.files.get(file.id, { principal: principal() }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'NOT_FOUND');
        return true;
      },
    );
    const afterDelete = await second.handler(new Request(contentUrl));
    assert.equal(afterDelete.status, 404);
    await second.files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mime, quota, idempotency, and anonymous requests fail closed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m1-'));
  try {
    const { files, handler } = await app(dir, {
      defaults: {
        tenantQuotaBytes: PNG.byteLength,
        allowedMimeTypes: ['image/png'],
      },
    });
    const anon = await handler(
      new Request('http://app.local/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'a.png',
          mimeType: 'image/png',
          bytes: 1,
        }),
      }),
    );
    assert.equal(anon.status, 401);
    await uploadPng(handler);
    const quota = await handler(
      new Request('http://app.local/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user': 'user-a',
          'x-tenant': 'tenant-a',
        },
        body: JSON.stringify({
          filename: 'b.png',
          mimeType: 'image/png',
          bytes: PNG.byteLength,
        }),
      }),
    );
    assert.equal(quota.status, 429);
    const jpeg = await handler(
      new Request('http://app.local/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user': 'user-d',
          'x-tenant': 'tenant-d',
        },
        body: JSON.stringify({
          filename: 'a.png',
          mimeType: 'image/jpeg',
          bytes: 3,
        }),
      }),
    );
    const jpegBody = (await jpeg.json()) as { code?: string };
    assert.equal(jpeg.status, 415, JSON.stringify(jpegBody));
    const bad = await files.createUploadSession(
      { filename: 'bad.png', mimeType: 'image/png', bytes: 3 },
      { principal: principal('user-f', 'tenant-f') },
    );
    await files.writePart(bad.id, 1, new Uint8Array([0xff, 0xd8, 0xff]), {
      principal: principal('user-f', 'tenant-f'),
    });
    await assert.rejects(
      files.completeUpload(
        bad.id,
        {},
        { principal: principal('user-f', 'tenant-f') },
      ),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'MIME_MISMATCH',
    );
    const session = await files.createUploadSession(
      {
        filename: 'same.png',
        mimeType: 'image/png',
        bytes: 4,
        idempotencyKey: 'same-key',
      },
      { principal: principal('user-e', 'tenant-e') },
    );
    const replay = await files.createUploadSession(
      {
        filename: 'same.png',
        mimeType: 'image/png',
        bytes: 4,
        idempotencyKey: 'same-key',
      },
      { principal: principal('user-e', 'tenant-e') },
    );
    assert.equal(replay.id, session.id);
    await assert.rejects(
      files.createUploadSession(
        {
          filename: 'same.png',
          mimeType: 'image/png',
          bytes: 5,
          idempotencyKey: 'same-key',
        },
        { principal: principal('user-e', 'tenant-e') },
      ),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(() => assertSafeKey('../etc/passwd'));
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node example uploads an image and reloads the same database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m1-example-'));
  const start = (extraEnv: Record<string, string> = {}) =>
    new Promise<{ proc: ReturnType<typeof spawn>; port: number }>(
      (resolve, reject) => {
        const proc = spawn(
          process.execPath,
          ['--experimental-strip-types', 'examples/node-minimal/server.ts'],
          {
            cwd: repoRoot,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: process.env.HOME ?? '',
              FILES_STORAGE_ROOT: path.join(dir, 'objects'),
              FILES_SQLITE_PATH: path.join(dir, 'meta.sqlite'),
              ...extraEnv,
            },
          },
        );
        let buffer = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const match = /listening (\d+)/.exec(buffer);
          if (match?.[1]) resolve({ proc, port: Number(match[1]) });
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
        });
        proc.on('exit', (code) =>
          reject(new Error(`server exited ${code}: ${buffer}`)),
        );
      },
    );
  try {
    const first = await start();
    const base = `http://127.0.0.1:${first.port}/api/files`;
    const headers = {
      'content-type': 'application/json',
      'x-user': 'user-a',
      'x-tenant': 'tenant-a',
    };
    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filename: 'dot.png',
        mimeType: 'image/png',
        bytes: PNG.byteLength,
      }),
    });
    const session = (await created.json()) as { id: string; fileId: string };
    assert.equal(created.status, 201, JSON.stringify(session));
    const part = await fetch(`${base}/sessions/${session.id}/parts/1`, {
      method: 'PUT',
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      body: PNG,
    });
    assert.equal(part.status, 200, await part.text());
    const completed = await fetch(`${base}/sessions/${session.id}/complete`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(completed.status, 200, await completed.text());
    first.proc.kill('SIGTERM');
    await new Promise((resolve) => first.proc.once('exit', resolve));
    const second = await start();
    const loaded = await fetch(
      `${base.replace(String(first.port), String(second.port))}/files/${session.fileId}`,
      {
        headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      },
    );
    const record = (await loaded.json()) as {
      uploadState: string;
      detectedMime: string;
    };
    assert.equal(loaded.status, 200, JSON.stringify(record));
    assert.equal(record.uploadState, 'verified');
    assert.equal(record.detectedMime, 'image/png');
    second.proc.kill('SIGTERM');
    await new Promise((resolve) => second.proc.once('exit', resolve));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

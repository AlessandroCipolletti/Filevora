import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createIndexedDbResumeStore,
  createMemoryResumeStore,
  createUploadClient,
} from '../dist/client/index.js';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function image(bytes: number, name: string): File {
  const body = Buffer.alloc(bytes);
  PNG.copy(body);
  return new File([body], name, {
    type: 'image/png',
    lastModified: 1_700_000_000_000,
  });
}

async function harness(dir: string, sessionTtlSeconds = 86_400) {
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024, sessionTtlSeconds },
    defaults: {
      allowedMimeTypes: ['image/png'],
      maxFileBytes: 10 * 1024 * 1024,
    },
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
    async policy() {
      return {};
    },
  });
  const fetchImpl: typeof fetch = async (input, init) =>
    handler(new Request(input, init));
  return { files, handler, fetchImpl, sqlite: path.join(dir, 'meta.sqlite') };
}

test('an interrupted upload resumes and keeps a single checksum', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m2-'));
  try {
    const { files, fetchImpl } = await harness(dir);
    const store = createMemoryResumeStore();
    const file = image(64 * 1024 * 5, 'clip.png');
    let puts = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('/parts/')) puts += 1;
      return fetchImpl(input, init);
    };
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: countingFetch,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      partConcurrency: 1,
      resumeStore: store,
    });
    const task = client.upload(file, {
      resume: { strategy: 'memory', persistBlob: 'never' },
    });
    const paused = new Promise<void>((resolve) => {
      task.on('progress', (event) => {
        if (event.bytesUploaded >= 64 * 1024 * 2) task.pause();
      });
      task.on('state', (state) => {
        if (state === 'paused') resolve();
      });
    });
    await paused;
    assert.equal(puts, 2);
    const abandoned = task.complete();
    abandoned.catch(() => undefined);
    const resumed = createUploadClient({
      endpoint: 'http://app.local',
      fetch: countingFetch,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      partConcurrency: 1,
      resumeStore: store,
    });
    const uploaded = await resumed
      .upload(file, { resume: { persistBlob: 'never' } })
      .complete();
    assert.equal(puts, 5);
    const expected = createHash('sha256')
      .update(Buffer.alloc(64 * 1024 * 5))
      .digest('hex');
    const check = Buffer.alloc(64 * 1024 * 5);
    PNG.copy(check);
    assert.equal(
      uploaded.checksum,
      createHash('sha256').update(check).digest('hex'),
    );
    assert.notEqual(uploaded.checksum, expected);
    const again = await resumed.upload(file).complete();
    assert.equal(again.id, uploaded.id);
    assert.equal(puts, 5);
    const page = await files.list(
      {},
      { principal: { id: 'user-a', tenantId: 'tenant-a' } },
    );
    assert.equal(page.items.length, 1);
    await task.cancel();
    await abandoned.catch(() => undefined);
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expired and unknown sessions fail without storing the bytes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m2-'));
  try {
    const { fetchImpl, sqlite, files } = await harness(dir);
    const store = createMemoryResumeStore();
    const fetchWithExpiry: typeof fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (
        String(input).endsWith('/sessions') &&
        (init?.method ?? 'GET') === 'POST'
      ) {
        const db = new DatabaseSync(sqlite);
        db.prepare('UPDATE filevora_assets SET expires_at = ?').run(
          new Date(Date.now() - 1000).toISOString(),
        );
        db.close();
      }
      return response;
    };
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: fetchWithExpiry,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      resumeStore: store,
      retry: { maxAttempts: 1 },
    });
    await assert.rejects(
      client.upload(image(64 * 1024, 'late.png')).complete(),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'UPLOAD_SESSION_EXPIRED');
        return true;
      },
    );
    const orphan = createMemoryResumeStore();
    await orphan.set('http://app.local\nmissing.png:4:1', {
      fingerprint: 'missing.png:4:1',
      endpoint: 'http://app.local',
      sessionId: 'upl_missing',
      fileId: 'file_missing',
      idempotencyKey: 'idem_missing',
      partSize: 64 * 1024,
      partCount: 1,
      uploadedParts: [],
      partUrlTemplate:
        'http://app.local/sessions/upl_missing/parts/{partNumber}',
      completeUrl: 'http://app.local/sessions/upl_missing/complete',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const missing = new File([PNG.subarray(0, 4)], 'missing.png', {
      type: 'image/png',
      lastModified: 1,
    });
    await assert.rejects(
      createUploadClient({
        endpoint: 'http://app.local',
        fetch: fetchImpl,
        headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
        resumeStore: orphan,
        retry: { maxAttempts: 1 },
      })
        .upload(missing)
        .complete(),
      (error: unknown) =>
        error instanceof FileSdkError &&
        (error.code === 'NOT_FOUND' || error.code === 'UPLOAD_SESSION_EXPIRED'),
    );
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two files can upload at once and IndexedDB keeps the resume record', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m2-'));
  try {
    const { fetchImpl, files } = await harness(dir);
    let puts = 0;
    let releaseSecond: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const gated: typeof fetch = async (input, init) => {
      if (String(input).includes('/parts/')) {
        puts += 1;
        if (puts === 2) releaseSecond?.();
        if (puts === 1) await bothStarted;
      }
      return fetchImpl(input, init);
    };
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: gated,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      fileConcurrency: 2,
      partConcurrency: 1,
    });
    const first = client.upload(image(64 * 1024, 'one.png'));
    const second = client.upload(image(64 * 1024, 'two.png'));
    await bothStarted;
    assert.equal(puts, 2);
    const done = await Promise.all([first.complete(), second.complete()]);
    assert.equal(new Set(done.map((file) => file.id)).size, 2);
    const database = createIndexedDbResumeStore('filevora-test');
    await database.set('sample', {
      fingerprint: 'sample',
      endpoint: 'http://app.local',
      sessionId: 'upl_sample',
      fileId: 'file_sample',
      idempotencyKey: 'idem_sample',
      partSize: 1024,
      partCount: 1,
      uploadedParts: [1],
      partUrlTemplate: 'http://app.local/parts/{partNumber}',
      completeUrl: 'http://app.local/complete',
      expiresAt: new Date().toISOString(),
      blob: new Blob(['hi']),
    });
    const loaded = await database.get('sample');
    assert.equal(loaded?.sessionId, 'upl_sample');
    assert.equal(loaded?.uploadedParts[0], 1);
    await database.delete('sample');
    assert.equal(await database.get('sample'), undefined);
    const processing = await files.get(done[0]?.id ?? '', {
      principal: { id: 'user-a', tenantId: 'tenant-a' },
    });
    assert.ok(
      processing.processingState === 'queued' ||
        processing.processingState === 'processing' ||
        processing.processingState === 'ready',
    );
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMemoryResumeStore,
  createUploadClient,
  uploadClientOptionsFromEnv,
} from '../dist/client/index.js';
import type { ProcessingUpdate } from '../dist/client/progress-stream.js';
import { openSqlite } from '../dist/metadata/sqlite.js';
import { reportProcessingRatio } from '../dist/queue/jobs.js';
import { estimateRemainingMs } from '../dist/progress/estimate.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const principal = { id: 'user-a', tenantId: 'tenant-a' };

function image(bytes: number, name: string): File {
  const body = Buffer.alloc(bytes);
  PNG.copy(body);
  return new File([body], name, {
    type: 'image/png',
    lastModified: 1_700_000_000_000,
  });
}

async function harness(dir: string) {
  const options = {
    env: 'test' as const,
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline' as const, spawn: 'never' as const },
    defaults: {
      allowedMimeTypes: ['image/png', 'video/mp4'],
      maxFileBytes: 10 * 1024 * 1024,
    },
  };
  const files = createFiles(options);
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
  return { files, fetchImpl, options };
}

function client(fetchImpl: typeof fetch, store = createMemoryResumeStore()) {
  return createUploadClient({
    endpoint: 'http://app.local',
    fetch: fetchImpl,
    headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
    partConcurrency: 1,
    resumeStore: store,
  });
}

test('upload progress reports percent and bytes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-rt-'));
  const { files, fetchImpl } = await harness(dir);
  try {
    const callbacks: Array<{ percentage: number; bytesUploaded: number }> = [];
    const events: Array<{ percentage: number; bytesUploaded: number }> = [];
    const file = image(64 * 1024 * 3, 'clip.png');
    const task = client(fetchImpl).upload(file, {
      onProgress: (progress) => callbacks.push(progress),
    });
    task.on('progress', (progress) => events.push(progress));
    await task.complete();
    assert.ok(callbacks.length > 1);
    assert.ok(
      callbacks.some((item) => item.percentage > 0 && item.percentage < 100),
    );
    assert.equal(callbacks.at(-1)?.percentage, 100);
    assert.equal(callbacks.at(-1)?.bytesUploaded, file.size);
    assert.equal(events.at(-1)?.bytesUploaded, file.size);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refreshed client resumes from the stored session', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-rt-'));
  const { files, fetchImpl } = await harness(dir);
  try {
    const store = createMemoryResumeStore();
    const file = image(64 * 1024 * 4, 'resume.png');
    let puts = 0;
    const counting: typeof fetch = async (input, init) => {
      if (String(input).includes('/parts/')) puts += 1;
      return fetchImpl(input, init);
    };
    const first = client(counting, store);
    const task = first.upload(file, { resume: { persistBlob: 'never' } });
    const abandoned = task.complete();
    abandoned.catch(() => undefined);
    const paused = new Promise<void>((resolve) => {
      task.on('progress', (event) => {
        if (event.bytesUploaded >= 64 * 1024) task.pause();
      });
      task.on('state', (state) => {
        if (state === 'paused') resolve();
      });
    });
    await paused;
    const pausedPuts = puts;
    assert.ok(pausedPuts >= 1 && pausedPuts < 4);
    const waiting = await first.pending();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.filename, 'resume.png');
    const during = await first.history();
    assert.equal(during.inFlight.length, 1);
    assert.equal(during.inFlight[0]?.status, 'paused');
    const second = client(counting, store);
    const uploaded = await second
      .upload(file, { resume: { persistBlob: 'never' } })
      .complete();
    assert.ok(puts > pausedPuts && puts <= 4);
    assert.equal(uploaded.bytes, file.size);
    const listed = await second.history();
    assert.equal(listed.sinceLoad.length, 1);
    assert.equal(listed.completed.length, 1);
    assert.match(listed.completed[0]?.originalUrl ?? '', /\/content\//);
    assert.equal(listed.inFlight.length, 0);
    await task.cancel();
    await abandoned.catch(() => undefined);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host env vars select resume storage and the progress channel', () => {
  const parsed = uploadClientOptionsFromEnv({
    FILEVORA_RESUME_STRATEGY: 'memory',
    FILEVORA_RESUME_PERSIST_BLOB: 'never',
    FILEVORA_RESUME_MAX_PERSISTED_BYTES: '2048',
    FILEVORA_PROGRESS_CHANNEL: 'poll',
    FILEVORA_PROGRESS_POLL_MS: '250',
  });
  assert.equal(parsed.resume.strategy, 'memory');
  assert.equal(parsed.resume.persistBlob, 'never');
  assert.equal(parsed.resume.maxPersistedBytes, 2048);
  assert.equal(parsed.progress.channel, 'poll');
  assert.equal(parsed.progress.pollMs, 250);
  const defaults = uploadClientOptionsFromEnv({});
  assert.equal(defaults.resume.strategy, 'indexeddb');
  assert.equal(defaults.resume.maxPersistedBytes, 33_554_432);
  assert.equal(defaults.progress.channel, 'sse');
  assert.equal(estimateRemainingMs(1_000, 0.25, 5_000), 12_000);
});

test('image progress is one quiet event and video progress includes eta', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-rt-'));
  const { files, fetchImpl, options } = await harness(dir);
  try {
    const quietClient = client(fetchImpl);
    const imageFile = await quietClient
      .upload(image(64 * 1024, 'still.png'))
      .complete();
    const quiet: ProcessingUpdate[] = [];
    await quietClient.watchProcessing(imageFile.id, (update) =>
      quiet.push(update),
    );
    assert.equal(quiet.length, 1);
    assert.equal(quiet[0]?.quiet, true);
    assert.equal(quiet[0]?.terminal, true);

    const videoFile = await client(fetchImpl)
      .upload(image(64 * 1024, 'motion.png'))
      .complete();
    const job = await files.process(videoFile.id, {}, { principal });
    const sql = openSqlite(options.metadata.filename);
    sql.run(
      `UPDATE files SET detected_mime = 'video/mp4', processing_state = 'processing' WHERE id = ?`,
      [videoFile.id],
    );
    reportProcessingRatio(sql, job.id, 0.4, Date.now() - 10_000);
    sql.close();
    const live: ProcessingUpdate[] = [];
    const done = client(fetchImpl).watchProcessing(videoFile.id, (update) => {
      live.push(update);
      if (update.percentage === 40) {
        const next = openSqlite(options.metadata.filename);
        next.run(`UPDATE files SET processing_state = 'ready' WHERE id = ?`, [
          videoFile.id,
        ]);
        next.run(`UPDATE jobs SET state = 'succeeded' WHERE id = ?`, [job.id]);
        next.close();
      }
    });
    await done;
    const tick = live.find((update) => update.percentage === 40);
    assert.ok(tick);
    assert.equal(tick?.quiet, false);
    assert.ok((tick?.etaMs ?? 0) > 10_000);
    assert.equal(live.at(-1)?.terminal, true);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { FileSdkError } from '../dist/errors/error.js';
import {
  assertRecipe,
  probeMedia,
  progressRatio,
  runFfmpeg,
} from '../dist/processors/ffmpeg.js';
import { readRunnerPid } from '../dist/queue/processing-queue.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

function generate(args: string[], output: string): Buffer {
  const result = spawnSync('ffmpeg', ['-y', ...args, output], {
    shell: false,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output);
}

async function upload(
  files: ReturnType<typeof createFiles>,
  name: string,
  mime: string,
  body: Buffer,
) {
  const session = await files.createUploadSession(
    { filename: name, mimeType: mime, bytes: body.byteLength },
    { principal },
  );
  for (let index = 0; index < session.partCount; index += 1) {
    const start = index * session.partSize;
    await files.writePart(
      session.id,
      index + 1,
      body.subarray(start, start + session.partSize),
      { principal },
    );
  }
  return files.completeUpload(session.id, {}, { principal });
}

test('ffmpeg progress parsing, timeouts, and abort do not use a shell', async () => {
  assert.equal(progressRatio('out_time_ms=500000', 1000), 0.5);
  assert.throws(
    () =>
      assertRecipe([{ kind: 'video.trim', startSeconds: 2, endSeconds: 1 }]),
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'INVALID_RECIPE',
  );
  const started = Date.now();
  await assert.rejects(
    runFfmpeg(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1280x720:rate=30:duration=30',
        '-c:v',
        'libx264',
        '-preset',
        'placebo',
        '-f',
        'null',
        '-',
      ],
      {
        timeoutMs: 700,
      },
    ),
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'PROCESSING_TIMEOUT',
  );
  assert.ok(Date.now() - started < 5_000);
  const controller = new AbortController();
  const pending = runFfmpeg(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=30:duration=30',
      '-c:v',
      'libx264',
      '-preset',
      'placebo',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 20_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof FileSdkError && error.code === 'CANCELLED',
  );
});

test(
  'a child worker transcodes video and audio while the caller stays responsive',
  {
    timeout: 60_000,
  },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m5-'));
    const files = createFiles({
      env: 'test',
      storage: { root: path.join(dir, 'objects') },
      metadata: { filename: path.join(dir, 'meta.sqlite') },
      upload: { chunkBytes: 64 * 1024 },
      queue: { leaseSeconds: 30, pollIntervalMs: 50, timeoutSeconds: 60 },
      processing: {
        mode: 'worker',
        spawn: 'on-demand',
        videoMaxDurationSeconds: 30,
        videoMaxOutputHeight: 1080,
      },
      defaults: { maxFileBytes: 30 * 1024 * 1024 },
    });
    try {
      const video = generate(
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x240:rate=10:duration=1',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-shortest',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
        ],
        path.join(dir, 'source.mp4'),
      );
      const audio = generate(
        ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
        path.join(dir, 'source.wav'),
      );
      const videoHash = createHash('sha256').update(video).digest('hex');
      const record = await upload(files, 'clip.mp4', 'video/mp4', video);
      assert.equal(record.detectedMime, 'video/mp4');
      const job = await files.process(record.id, {}, { principal });
      const workerPid = files.ensureWorker();
      assert.notEqual(workerPid, process.pid);
      const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
      let runnerPid = 0;
      const started = Date.now();
      while (Date.now() - started < 20_000 && runnerPid === 0) {
        const recorded = await readRunnerPid(job.id);
        if (recorded) runnerPid = recorded;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(runnerPid > 0);
      const ppid = Number(
        spawnSync('ps', ['-o', 'ppid=', '-p', String(runnerPid)], {
          encoding: 'utf8',
        }).stdout.trim(),
      );
      assert.equal(ppid, workerPid);
      const responsive = Date.now();
      const during = await files.get(record.id, { principal });
      assert.ok(Date.now() - responsive < 1_000);
      assert.equal(during.checksum, videoHash);
      const waitStart = Date.now();
      let finished = await files.getJob(job.id, { principal });
      while (
        finished.state !== 'succeeded' &&
        finished.state !== 'failed' &&
        Date.now() - waitStart < 40_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        finished = await files.getJob(job.id, { principal });
      }
      assert.equal(finished.state, 'succeeded', JSON.stringify(finished));
      const ready = await files.get(record.id, { principal });
      assert.equal(ready.checksum, videoHash);
      const optimized = ready.variants.find(
        (variant) => variant.name === 'optimized',
      );
      const poster = ready.variants.find(
        (variant) => variant.name === 'thumbnail',
      );
      assert.equal(optimized?.mimeType, 'video/mp4');
      assert.equal(poster?.mimeType, 'image/webp');
      assert.ok((optimized?.height ?? 999) <= 240);
      assert.equal(
        ready.variants.some((variant) => variant.name === 'hd'),
        false,
      );
      const stored = ready.variants.find(
        (variant) => variant.name === 'optimized',
      );
      if (!stored) throw new Error('missing optimized variant');
      const variantRow = db
        .prepare('SELECT storage_key FROM filevora_asset_versions WHERE id = ?')
        .get(stored.id) as {
        storage_key: string;
      };
      const output = await probeMedia(
        'ffprobe',
        path.join(
          path.resolve(files.config.storage.root),
          variantRow.storage_key,
        ),
        10_000,
      );
      assert.equal(output.videoCodec, 'h264');
      assert.ok((output.height ?? 999) <= 240);

      const sound = await upload(files, 'tone.wav', 'audio/wav', audio);
      await files.process(sound.id, {}, { principal });
      const audioWait = Date.now();
      const audioJob = await files
        .getJob(
          (await files.list({ limit: 1 }, { principal })).items[0]?.id ??
            sound.id,
          { principal },
        )
        .catch(() => undefined);
      void audioJob;
      let audioReady = await files.get(sound.id, { principal });
      while (
        audioReady.processingState !== 'ready' &&
        audioReady.processingState !== 'failed' &&
        Date.now() - audioWait < 30_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        audioReady = await files.get(sound.id, { principal });
      }
      assert.equal(audioReady.processingState, 'ready');
      assert.equal(audioReady.variants[0]?.mimeType, 'audio/mp4');

      const trimmed = await files.process(
        record.id,
        {
          transforms: [
            { kind: 'video.trim', startSeconds: 0, endSeconds: 0.4 },
          ],
        },
        { principal },
      );
      const trimWait = Date.now();
      let trimJob = await files.getJob(trimmed.id, { principal });
      while (
        trimJob.state !== 'succeeded' &&
        trimJob.state !== 'failed' &&
        Date.now() - trimWait < 30_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        trimJob = await files.getJob(trimmed.id, { principal });
      }
      assert.equal(trimJob.state, 'succeeded', JSON.stringify(trimJob));
      db.close();
    } finally {
      await files.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

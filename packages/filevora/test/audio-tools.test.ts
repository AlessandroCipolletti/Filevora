import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveConfig } from '../dist/config/load.js';
import { peaksFromPcm } from '../dist/processors/audio-tools.js';
import { createFiles } from '../dist/server/index.js';
import { openStorage, readAll } from '../dist/storage/stage.js';
import { createTestFiles, type TestFiles } from '../dist/testing/index.js';

test('pcm peaks keep the loudest sample in each bucket', () => {
  const samples = new Float32Array([0, 0.5, -0.25, 1, -1, 0]);
  const peaks = peaksFromPcm(samples, 2);
  assert.equal(peaks.length, 2);
  assert.equal(peaks[0]?.max, 0.5);
  assert.equal(peaks[1]?.min, -1);
});

test('audio presets transcode, normalize, describe, and draw a waveform', async (t) => {
  const wav = sampleWav();
  if (!wav) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const files = createTestFiles();
  try {
    const mp3 = await upload(files, wav, 'audio-mp3');
    assert.equal(mp3.processingState, 'ready');
    assert.equal(
      mp3.variants.find((variant) => variant.name === 'mp3')?.mimeType,
      'audio/mpeg',
    );
    const described = await upload(files, wav, 'audio-describe');
    assert.equal(
      described.variants.find((variant) => variant.name === 'describe')
        ?.mimeType,
      'application/json',
    );
    const wave = await upload(files, wav, 'audio-waveform');
    assert.equal(
      wave.variants.find((variant) => variant.name === 'waveform')?.mimeType,
      'image/png',
    );
    assert.equal(
      wave.variants.find((variant) => variant.name === 'waveform-json')
        ?.mimeType,
      'application/json',
    );
    const loud = await upload(files, wav, 'audio-loudnorm');
    assert.equal(
      loud.variants.find((variant) => variant.name === 'normalized')?.mimeType,
      'audio/mp4',
    );
    const storage = await openStorage(
      resolveConfig(
        { env: 'test', storage: { driver: 'filesystem', root: files.root } },
        {},
      ).storage,
    );
    try {
      const listed = await storage.list('');
      const meta = listed.find((item) => item.key.endsWith('_describe.json'));
      assert.ok(meta);
      const body = JSON.parse(
        Buffer.from(await readAll(await storage.getObject(meta.key))).toString(
          'utf8',
        ),
      ) as { durationMs: number; audioCodec: string | null };
      assert.ok(body.durationMs > 0);
      assert.equal(typeof body.audioCodec, 'string');
    } finally {
      await storage.close?.();
    }
    const source = await upload(files, wav, 'audio-aac');
    await files.files.transform(
      source.id,
      { operations: [{ op: 'audio.transcode', format: 'wav' }] },
      { principal: files.principal },
    );
    const loaded = await files.files.get(source.id, {
      principal: files.principal,
    });
    assert.equal(
      loaded.variants.find(
        (variant) =>
          variant.recipeId === 'audio-tools' && variant.name === 'wav',
      )?.mimeType,
      'audio/wav',
    );
  } finally {
    await files.close();
  }
});

test('an audio description is stored in the bucket', async (t) => {
  const endpoint = process.env.FILEVORA_S3_ENDPOINT;
  if (!endpoint) {
    t.skip('FILEVORA_S3_ENDPOINT is not set');
    return;
  }
  const wav = sampleWav();
  if (!wav) {
    t.skip('ffmpeg is not installed');
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
  const bucket = 'filevora-audio-describe';
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-audio-s3-'));
  try {
    await client
      .send(new CreateBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
    const files = createFiles({
      env: 'test',
      storage: {
        driver: 's3',
        root: dir,
        s3: {
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey,
          forcePathStyle: true,
        },
      },
      processing: { mode: 'sync', spawn: 'never' },
      upload: { chunkBytes: 64 * 1024 },
    });
    const storage = await openStorage(
      resolveConfig(
        {
          env: 'test',
          storage: {
            driver: 's3',
            root: dir,
            s3: {
              endpoint,
              region,
              bucket,
              accessKeyId,
              secretAccessKey,
              forcePathStyle: true,
            },
          },
        },
        {},
      ).storage,
    );
    try {
      const principal = { id: 'user-a', tenantId: 'tenant-audio' };
      const session = await files.createUploadSession(
        {
          filename: 'tone.wav',
          mimeType: 'audio/wav',
          bytes: wav.byteLength,
          preset: 'audio-describe',
        },
        { principal },
      );
      const urls = await files.partUploadUrls(session.id, { principal });
      const uploaded = await fetch(urls['1'] ?? '', {
        method: 'PUT',
        body: wav,
      });
      assert.equal(uploaded.status, 200);
      const etag = uploaded.headers.get('etag');
      assert.ok(etag);
      const done = await files.completeUpload(
        session.id,
        { parts: [{ partNumber: 1, etag }] },
        { principal },
      );
      assert.equal(done.processingState, 'ready');
      const listed = await storage.list('');
      const meta = listed.find((item) => item.key.endsWith('_describe.json'));
      assert.ok(meta);
      const body = JSON.parse(
        Buffer.from(await readAll(await storage.getObject(meta.key))).toString(
          'utf8',
        ),
      ) as { durationMs: number };
      assert.ok(body.durationMs > 0);
    } finally {
      await files.close();
      await storage.close?.();
    }
  } finally {
    client.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleWav(): Buffer | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-tone-'));
  const file = path.join(dir, 'tone.wav');
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=8000:duration=0.4',
        '-ar',
        '8000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        file,
      ],
      { stdio: 'ignore' },
    );
    if (result.status !== 0) return undefined;
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function upload(files: TestFiles, body: Buffer, preset: string) {
  const session = await files.files.createUploadSession(
    {
      filename: 'tone.wav',
      mimeType: 'audio/wav',
      bytes: body.byteLength,
      preset,
    },
    { principal: files.principal },
  );
  await files.files.writePart(session.id, 1, body, {
    principal: files.principal,
  });
  return files.files.completeUpload(
    session.id,
    {},
    { principal: files.principal },
  );
}

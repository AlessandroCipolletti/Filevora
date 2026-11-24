import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProgress,
  createTestFiles,
  sampleMp4,
  samplePdf,
  samplePng,
  uploadBytes,
} from '../dist/testing/index.js';

test('testing helpers encode an image and keep PDF and video fixtures local', async () => {
  const harness = createTestFiles();
  const redisBefore = process.env.REDIS_URL;
  try {
    const image = await uploadBytes(
      harness,
      samplePng(),
      'dot.png',
      'image/png',
    );
    assert.equal(image.processingState, 'ready');
    await assertProgress(harness, image.id, {
      state: 'ready',
      terminal: true,
      phase: 'processing',
      versions: ['_original', 'thumbnail', 'optimized', 'hd'],
    });

    const pdf = await uploadBytes(
      harness,
      await samplePdf(),
      'pages.pdf',
      'application/pdf',
    );
    assert.equal(pdf.processingState, 'none');
    await assertProgress(harness, pdf.id, {
      state: 'none',
      terminal: true,
      versions: ['_original'],
    });

    const video = await sampleMp4();
    assert.ok(video.byteLength > 32);
    assert.equal(process.env.REDIS_URL, redisBefore);
  } finally {
    await harness.close();
  }
});

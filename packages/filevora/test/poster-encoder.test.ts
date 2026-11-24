import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../dist/diagnostics/doctor.js';
import {
  probeFfmpegEncoders,
  selectPosterEncoder,
} from '../dist/processors/ffmpeg.js';

test('selectPosterEncoder uses libwebp only when the encoder list contains it', () => {
  assert.equal(
    selectPosterEncoder(' V..... libwebp               libwebp WebP\n'),
    'libwebp',
  );
  assert.equal(
    selectPosterEncoder(' V..... libx264              H.264\n A..... aac\n'),
    'sharp',
  );
  const live = probeFfmpegEncoders();
  assert.equal(
    selectPosterEncoder(live),
    live.includes('libwebp') ? 'libwebp' : 'sharp',
  );
});

test('doctor reports Sharp posters when FFmpeg has no libwebp encoder', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-poster-'));
  try {
    const report = await runDoctor({
      env: 'test',
      storage: { root: path.join(dir, 'objects') },
      metadata: { filename: path.join(dir, 'meta.sqlite') },
    });
    const check = report.checks.find((item) => item.id === 'ffmpeg-webp');
    assert.ok(check);
    assert.equal(check?.required, false);
    const encoder = selectPosterEncoder(probeFfmpegEncoders());
    if (encoder === 'libwebp') {
      assert.equal(check?.status, 'pass');
      assert.equal(report.ok, true);
      return;
    }
    assert.equal(encoder, 'sharp');
    assert.equal(check?.status, 'warn');
    assert.match(check?.message ?? '', /Sharp/);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

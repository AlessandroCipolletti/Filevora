# Writing tests on top of Filevora

Import the helpers from `filevora/testing`. They are for tests of application code and of Filevora itself. They are not a production queue.

```ts
import {
  assertProgress,
  createTestFiles,
  sampleMp4,
  samplePdf,
  samplePng,
  uploadBytes,
} from 'filevora/testing';

const harness = createTestFiles();
try {
  const image = await uploadBytes(harness, samplePng(), 'dot.png', 'image/png');
  await assertProgress(harness, image.id, {
    state: 'ready',
    terminal: true,
    versions: ['_original', 'thumbnail', 'optimized', 'hd'],
  });
} finally {
  await harness.close();
}
```

`createTestFiles()` uses a temporary filesystem directory and lite metadata. It does not open Redis, S3, Postgres, or MySQL. `processing.mode` is forced to `sync`: the image, video, or transform job finishes inside `completeUpload` or `transform` before that call returns. The job id is `inline_${assetId}`.

`processing.mode: "inline"` is a different setting. It still queues on BullMQ and only stops the SDK from spawning a worker. Use `sync` when a test must not start Redis. `sync` is rejected unless `env` is `test`.

## Fixtures

- `samplePng()` returns a 1×1 PNG. The image preset still writes thumbnail, optimized, and HD WebP versions.
- `samplePdf()` returns a two-page PDF. PDFs are not sent through the encode preset, so the asset stays `processingState: "none"` with an `_original` version.
- `sampleMp4()` asks the local `ffmpeg` binary for a one-second H.264 clip. It throws if `ffmpeg` is missing. Generating the bytes does not use Redis. Uploading that clip through `createTestFiles` encodes it in process. Progress samples are written only when `REDIS_URL` is already set; otherwise they are skipped.

## Assertions

`assertProgress(harness, assetId, expected)` reads `processingSnapshot` with a test base URL. That is the same payload as the terminal SSE event, including version URLs when the asset is ready. Pass the version names you expect (`_original`, `thumbnail`, and so on).

`uploadBytes` performs one chunked upload as `harness.principal` (`user-test` / `tenant-test`).

Pass `createTestFiles({ storage: { root } })` to keep the directory. The helper deletes the directory it created.

Do not start `redis-memory-server` or a worker in these tests. A test that must exercise BullMQ should keep using `runWorker` and `REDIS_URL`, not this export.

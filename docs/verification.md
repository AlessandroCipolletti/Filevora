# Verification

Commands were run on darwin, Node v26.5.0, from `/Users/cippo/Workspace/Me/Filevora`. GitHub Actions has not been executed here.

## M0

```text
pnpm typecheck
pnpm exec biome check .
pnpm --filter filevora test
```

`pnpm typecheck` built `packages/filevora`, typechecked the package tests, and typechecked `examples/fixture-app`. Exit 0.

`biome check` reported no errors. Exit 0.

`pnpm --filter filevora test` ran 15 tests. 15 passed, 0 failed. The run covered config precedence, secret redaction, managed-provider rejection, production storage guards, the browser bundle, the capability allowlist, the CLI, error notes, and the fixture import.

## M1

```text
pnpm --filter filevora build
pnpm --filter filevora exec node --experimental-strip-types --test --test-reporter=spec test/m1.test.ts
pnpm exec biome check .
pnpm --filter filevora test
```

The M1 file reported 3 tests passed: in-process upload and restart, mime/quota/idempotency failures, and `examples/node-minimal/server.ts` upload followed by a new process reading the same SQLite file. The full suite after that change reported 18 tests passed and 0 failed. Biome reported no errors.

## M2

`test/m2.test.ts` passed 3 tests: a 5-part upload paused after 2 parts and resumed with 3 further part requests, expired and unknown sessions, and two simultaneous files plus an IndexedDB resume record. The full suite then reported 21 tests passed and 0 failed. Biome reported no errors.

## M3

`test/m3.test.ts` passed 2 tests. The supervisor returned the same child pid twice. After `SIGKILL`, a new child finished the same job once (`attempts >= 2`, `result.held === true`). A preset job failed with `PROCESSOR_UNAVAILABLE`. `filevora doctor --json` exited 0 for a valid temp config and 1 for `FILES_PROVIDER=managed`. The full suite then reported 23 tests passed and 0 failed. Biome reported no errors.

## M4

`test/m4.test.ts` passed 2 tests. A 2000×1000 PNG produced WebP widths 320, 1280, and 1920. A 40×20 PNG stayed at or below 40 pixels wide. The original SHA-256 did not change. A 50×50 image with a 100-pixel cap failed `INVALID_RECIPE` and stored no variant. Re-running the preset left three variant rows. The full suite then reported 25 tests passed and 0 failed. Biome reported no errors.

## M5

`test/m5.test.ts` passed 2 tests. A 320×240 one-second clip was transcoded to H.264 by an FFmpeg process whose parent pid was the worker child, not the test process. `files.get` during that encode returned in under one second. The optimized height stayed at or below 240, there was no HD variant, and the poster was `image/webp`. A WAV became `audio/mp4`. A trim recipe from 0 to 0.4 seconds succeeded. A placebo 720p encode was killed by a 700ms timeout (`PROCESSING_TIMEOUT`) and by an abort signal (`CANCELLED`). FFmpeg was not asked to encode WebP. The full suite then reported 27 tests passed and 0 failed. Biome reported no errors.

## M6

`test/m6.test.ts` passed 2 tests. The client PUT went to the emulator origin, the secret string was not in the session JSON or the PUT URL, and the presigned download returned the same PNG bytes. A filesystem upload in the same file still verified. `filevora init --profile local-s3` wrote `docker-compose.yml` containing `minio/minio` and reported `started: false`. The full suite then reported 29 tests passed and 0 failed. Biome reported no errors.

## M7

`test/m7.test.ts` passed 1 test. Two `claimJob` calls against one PGlite database returned the job once. Two variant inserts left `COUNT(*) = 1`. `headObject` on the shared emulator key matched the byte length. No networked Postgres process was started. The full suite then reported 30 tests passed and 0 failed. Biome reported no errors.

## M8

`test/m8.test.ts` passed 1 test covering the text PDF, the no-text PDF, the encrypted PDF, a CSV with one invalid email, and an XLSX sheet with one accepted row. The full suite then reported 31 tests passed and 0 failed. Biome reported no errors.

## M9

`test/m9.test.ts` passed 1 test. Dry-run returned one `max-age` candidate and `files.get` still succeeded. After pinning, eligibility was 0. After unpinning, the sweep deleted 1 file. `planRetention` returned no item for a file with `unusedAfterDays` and a null touch timestamp. The full suite then reported 32 tests passed and 0 failed. Biome reported no errors.

## M10

`test/m10.test.ts` passed 3 tests. The explainer saw a redacted report and could not replace `FFMPEG_NOT_FOUND`. A provider exception left the code unchanged. Webhook verification failed 301 seconds later, and `http://127.0.0.1` plus `https://10.1.1.5` were rejected when loopback was not allowed. `runFfmpeg('definitely-not-a-filevora-ffmpeg')` threw `FFMPEG_NOT_FOUND`. The full suite then reported 35 tests passed and 0 failed. Biome reported no errors.

## M11

`test/m11.test.ts` passed 1 test. Non-PNG bytes declared as `image/png` were rejected. The isolated run printed `benchmark_image_ms=46`. The full suite printed `benchmark_image_ms=81` and reported 36 tests passed and 0 failed. `npm pack --dry-run` reported `filevora@0.1.0`, 118 files, unpacked size 514.4 kB. The tarball was deleted and was not published.

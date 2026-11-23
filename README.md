# Filevora

Headless TypeScript SDK for resumable file upload, storage, processing, and delivery. One package, no Filevora account, no hosted control plane. Your application keeps users, permissions, and business data. Filevora keeps the file lifecycle.

**Use it when** an app needs uploads, private delivery, and background derivatives without rebuilding that stack.

**It replaces** a hand-rolled multipart uploader, local object directory, job table, and worker process. It does not replace your auth, database of business records, or UI.

**Install** (once the package is published; until then, install this repository):

```bash
npm install filevora
```

**Cloud account:** none. `provider: "managed"` fails with `FEATURE_NOT_AVAILABLE`.

**Runs locally:** yes. Filesystem storage, SQLite, the browser upload helper, and the worker are covered by tests.

```ts
import { createFiles } from 'filevora/server';

const files = createFiles({
  storage: { driver: 'filesystem', root: './.files/objects' },
  metadata: { driver: 'sqlite', filename: './.files/metadata.sqlite' },
});
```

Constructing `createFiles` validates configuration and does not spawn a worker. The first upload opens SQLite. `createFilesHandler` from `filevora/http` accepts chunked uploads and returns short-lived download tokens. `createUploadClient` from `filevora/client` uploads in parts, retries, pauses, and resumes from a stored session. `complete()` resolves when the original is stored, not when processing finishes. `filevora doctor --json` checks Node, config, the filesystem, SQLite, FFmpeg, libwebp, and pdftoppm. A queued job starts one child worker. Image presets produce WebP thumbnail, optimized, and HD variants with Sharp and do not enlarge the source. Video presets produce an H.264 MP4 and a WebP poster. FFmpeg encodes that poster only when `ffmpeg -encoders` lists libwebp. FFmpeg 8.1.2 on the local verification machine does not, so Sharp encodes the poster and `doctor` warns. Audio presets produce AAC in an M4A file. S3 uploads in the default tests go to an in-process emulator with presigned part URLs. The secret is absent from those URLs. Set `FILEVORA_S3_ENDPOINT`, `FILEVORA_S3_BUCKET`, `FILEVORA_S3_ACCESS_KEY_ID`, and `FILEVORA_S3_SECRET_ACCESS_KEY` to run the networked S3 test. Docker was unavailable here, so that test was skipped. Postgres queue SQL is tested with PGlite in one process. Set `FILEVORA_POSTGRES_URL` to run the networked Postgres test. `psql` was not installed here, so that test was skipped. `createFiles` still opens SQLite. PDF fixtures return literal text or `OCR_NOT_CONFIGURED`. When `pdftoppm` is on PATH, normalize stores a PNG of page 1. CSV and XLSX return row counts and masked errors. Retention dry-run lists old files without deleting them. Pins are skipped. A file with no touch timestamp is not inactivity-eligible.

| Checked in this repo                 | Result                                             |
| ------------------------------------ | -------------------------------------------------- |
| Node                                 | `>=22.13`, verified locally on darwin Node v26.5.0 |
| Browser entry                        | bundles without Node built-ins                     |
| Filesystem upload and SQLite restart | tested on darwin Node v26.5.0                      |
| Resumable browser upload             | tested with an interrupted 5-part upload           |
| Embedded worker crash recovery       | tested: one child pid, killed job finishes once    |
| Sharp image variants                 | tested: 320, 1280, and 1920 WebP, no upscale       |
| FFmpeg video and audio               | tested: H.264 MP4, AAC M4A, Sharp WebP poster on FFmpeg 8.1.2 |
| S3 multipart upload                  | emulator tested; networked test skipped without `FILEVORA_S3_ENDPOINT` |
| Postgres queue                       | PGlite tested; networked test skipped without `FILEVORA_POSTGRES_URL` |
| PDF text, page-1 PNG, CSV/XLSX       | text and rows tested; page PNG tested with pdftoppm 26.04.0 |
| Retention dry-run and pins           | tested; missing touch evidence is not idle         |
| Managed hosting, billing, accounts   | unsupported                                        |

```bash
npx filevora capabilities --json
npx filevora config validate --json
npx filevora doctor --json
```

**Develop this repository:**

```bash
pnpm install
pnpm dev
pnpm dev:client
pnpm run ci
pnpm test
```

`pnpm dev` is Vite library mode in watch. It rewrites `packages/filevora/dist` as one ES module per source file. `pnpm dev:client` serves the browser client at `http://127.0.0.1:5173` and does not start a Node server. `pnpm build` is that same library build, and it also writes the `.d.ts` files. `tsc` still typechecks the sources. It no longer emits the JavaScript. Public imports stay `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, and `filevora/types`.

Upload tasks emit `progress` with `percentage`, `bytesUploaded`, and `totalBytes`, and accept `onProgress`. Resume after refresh uses the resume store. The host reads `FILEVORA_RESUME_*` and `FILEVORA_PROGRESS_*` from its environment and passes `uploadClientOptionsFromEnv` into the client. Names and defaults are in `.env.example`. `watchProcessing` reads `GET /files/:id/progress` as server-sent events, and polls the same path as JSON if the stream fails. Video and audio jobs include percent and `etaMs`. Image jobs emit one terminal event. `history()` lists this page load, including in-flight items and completed items with short-lived delivery URLs. `pending()` lists interrupted sessions still in the resume store. The upload session's `assetId` (the same value as `fileId`) is the id the host stores. Asset ids and version metadata live in the metadata database. Locally that is SQLite at `FILES_SQLITE_PATH` (default `./.files/metadata.sqlite`). Redis is only the BullMQ processing queue. It is not the asset registry. `GET /assets` lists asset ids for the authenticated tenant. `GET /files/:assetId/versions` returns signed URLs for every ready version. `_original` is included as soon as the upload is verified, including while encoding is queued or after it fails. Object keys are `{tenantHash}/{assetId}_{version}.{ext}`, for example `{assetId}_original.png` and `{assetId}_thumbnail.webp`. Run workers with `REDIS_URL=redis://127.0.0.1:6379 npx filevora worker`. Several machines can share that Redis URL. `processing.concurrency` is the number of jobs one worker process runs at once.

Agent notes: [docs/agents/install.md](docs/agents/install.md), [docs/agents/decision-guide.md](docs/agents/decision-guide.md), [docs/agents/capabilities.json](docs/agents/capabilities.json).

License: MIT.

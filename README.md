# Filevora

Headless TypeScript SDK for resumable file upload, storage, processing, and delivery. One package, no Filevora account, no hosted control plane. Your application keeps users, permissions, and business data. Filevora keeps the file lifecycle.

**Use it when** an app needs uploads, private delivery, and background derivatives without rebuilding that stack.

**It replaces** a hand-rolled multipart uploader, local object directory, job table, and worker process. It does not replace your auth, database of business records, or UI.

**Install** (once the package is published; until then, install this repository):

```bash
npm install filevora
```

**Cloud account:** none. `provider: "managed"` fails with `FEATURE_NOT_AVAILABLE`.

**Runs locally:** yes. Filesystem storage and SQLite are implemented and covered by tests. The browser upload helper and the worker are not.

```ts
import { createFiles } from 'filevora/server';

const files = createFiles({
  storage: { driver: 'filesystem', root: './.files/objects' },
  metadata: { driver: 'sqlite', filename: './.files/metadata.sqlite' },
});
```

Constructing `createFiles` validates configuration and does not spawn a worker. The first upload opens SQLite. `createFilesHandler` from `filevora/http` accepts chunked uploads and returns short-lived download tokens. `createUploadClient` from `filevora/client` uploads in parts, retries, pauses, and resumes from a stored session. `complete()` resolves when the original is stored, not when processing finishes. `filevora doctor --json` checks Node, config, the filesystem, SQLite, and FFmpeg. A queued job starts one child worker. Image presets produce WebP thumbnail, optimized, and HD variants with Sharp and do not enlarge the source. Video presets produce an H.264 MP4 and a WebP poster. The poster is encoded by Sharp because this FFmpeg build has no WebP encoder. Audio presets produce AAC in an M4A file. S3, Postgres, PDF, and retention are not implemented.

| Checked in this repo                 | Result                                             |
| ------------------------------------ | -------------------------------------------------- |
| Node                                 | `>=22.13`, verified locally on darwin Node v26.5.0 |
| Browser entry                        | bundles without Node built-ins                     |
| Filesystem upload and SQLite restart | tested on darwin Node v26.5.0                      |
| Resumable browser upload             | tested with an interrupted 5-part upload           |
| Embedded worker crash recovery       | tested: one child pid, killed job finishes once    |
| Sharp image variants                 | tested: 320, 1280, and 1920 WebP, no upscale       |
| FFmpeg video and audio               | tested: H.264 MP4, AAC M4A, Sharp WebP poster      |
| S3, Postgres, PDF, retention         | not implemented yet                                |
| Managed hosting, billing, accounts   | unsupported                                        |

```bash
npx filevora capabilities --json
npx filevora config validate --json
npx filevora doctor --json
```

Agent notes: [docs/agents/install.md](docs/agents/install.md), [docs/agents/decision-guide.md](docs/agents/decision-guide.md), [docs/agents/capabilities.json](docs/agents/capabilities.json).

License: MIT.

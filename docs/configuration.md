# Configuration

Precedence is explicit options, then `FILES_*` environment variables, then defaults. Filevora does not load `.env` files.

See `.env.example` for the variable names. Secrets stay in the host environment. `redactConfig` is what logs and `filevora config validate --json` print.

Production rules that are already enforced:

- `provider: "managed"`, `provider: "hybrid"`, `storage.driver: "managed"`, and `processing.mode: "cloud"` throw `FEATURE_NOT_AVAILABLE`.
- Filesystem or SQLite in production requires `singleHostAcknowledged: true` or `FILES_SINGLE_HOST_ACK=true`.
- A production filesystem root inside the OS temp directory is rejected.
- `processing.mode: "worker"` with `spawn: "on-demand"` is rejected when the runtime is serverless or edge.
- `visibility: "public"` requires `defaults.allowPublicFiles` or `FILES_ALLOW_PUBLIC_FILES=true`.
- Distributed mode requires S3 and Postgres, and it does not auto-spawn a worker.

`FILES_CLOUD_API_KEY`, `FILES_CLOUD_ENDPOINT`, and `FILES_CLOUD_PROJECT_ID` are reserved. They do not enable a service.

`.env.example` lists the embedded defaults, the commented S3, Postgres, and cloud blocks, and `FILES_SINGLE_HOST_ACK`. Upload size and session lifetime are `FILES_UPLOAD_CHUNK_BYTES` (default 8388608) and `FILES_UPLOAD_SESSION_TTL_SECONDS` (default 86400).

`FILEVORA_RESUME_STRATEGY`, `FILEVORA_RESUME_PERSIST_BLOB`, `FILEVORA_RESUME_MAX_PERSISTED_BYTES`, `FILEVORA_PROGRESS_CHANNEL`, and `FILEVORA_PROGRESS_POLL_MS` are for the host process. Pass them through `uploadClientOptionsFromEnv`. The browser bundle does not read `process.env`.

`POST /files/:assetId/transform` is documented in `docs/agents/transform.md`. A `preset` name expands to those operations. Built-in names, custom presets, and `FILEVORA_PRESETS` are in `docs/presets.md`. `FILES_THUMBNAIL_WIDTH` (or `defaults.thumbnailWidth`) is `320` or `480`. The default is `480`. It sets the web-optimized image thumbnail, the built-in `thumbnail` preset, and the legacy video poster. Any other value fails with `INVALID_CONFIG`.

`FILEVORA_GEMINI_API_KEY` enables asset descriptions. `FILEVORA_DESCRIBE_ASSETS` defaults to false. `FILEVORA_GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. `FILEVORA_DESCRIBE_VIDEO_HEIGHT` defaults to 720. Descriptions require `FILEVORA_DATABASE_URL`. See `docs/descriptions.md`. Semantic search adds `FILEVORA_EMBEDDING_MODEL` (default `gemini-embedding-2`), `FILEVORA_EMBEDDING_DIMENSIONS` (768), `FILEVORA_SEARCH_MIN_SCORE` (0.65, provisional), and `FILEVORA_SEARCH_MAX_RESULTS` (100). See `docs/search.md`. Content is sent to Google only when a description runs. Private downloads use `FILEVORA_SIGNING_SECRET` (comma-separated for key rotation). `FILEVORA_DEFAULT_VISIBILITY` defaults to `private`. See `docs/access-control.md`. Progress responses now include `assetId`, `jobId`, and `phase`. The terminal success event includes `versions`.

`POST /assets/from-url` imports an http or https URL. `FILEVORA_REMOTE_MAX_BYTES`, `FILEVORA_REMOTE_CONNECT_TIMEOUT_MS`, `FILEVORA_REMOTE_TIMEOUT_MS`, `FILEVORA_REMOTE_MAX_REDIRECTS`, and `FILEVORA_REMOTE_ALLOWED_PORTS` set the limits. `FILEVORA_REMOTE_HOST_ALLOW` and `FILEVORA_REMOTE_HOST_DENY` are comma-separated hosts. `FILEVORA_REMOTE_ALLOW_PRIVATE=true` allows a private address on that URL only. Redirects are checked again and cannot target a private address.

S3 settings are `FILES_S3_BUCKET`, `FILES_S3_REGION`, `FILES_S3_ENDPOINT`, `FILES_S3_ACCESS_KEY_ID`, and `FILES_S3_SECRET_ACCESS_KEY`. `FILES_POSTGRES_SCHEMA` (default `filevora`) is the Postgres schema for `filevora_assets` and `filevora_asset_versions`. Omit `FILEVORA_DATABASE_URL` and the SDK runs in lite mode: object storage plus Redis, no database. With `storage.driver: "s3"`, asset bytes and lite cards are objects in the bucket (cards under `.filevora/`). Processing copies an object to a temp file for Sharp or FFmpeg and writes the result back through the storage driver. `GET /health` and `filevora doctor` round-trip a probe object in that bucket. Set `FILEVORA_DATABASE_URL` and it runs in stored mode. The URL scheme selects the driver: `postgres://` or `postgresql://` for PostgreSQL, `mysql://` or `mariadb://` for MySQL or MariaDB, and `sqlite://` or a file path for SQLite. `FILEVORA_METADATA_MODE=stored` without a URL is an error. `FILEVORA_METADATA_MODE` can override that choice. `npx filevora migrate` creates only `filevora_assets` and `filevora_asset_versions`. `FILEVORA_AUTO_MIGRATE` defaults to on. `REDIS_URL` is the BullMQ processing queue. Asset ids are not stored in Redis. Object keys use `{tenantHash}/{assetId}_{version}.{ext}`. Workers: `REDIS_URL=redis://127.0.0.1:6379 npx filevora worker`.

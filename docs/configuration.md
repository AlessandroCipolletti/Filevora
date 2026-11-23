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

`REDIS_URL` is the BullMQ processing queue. Asset ids and version rows are not stored in Redis. They stay in the metadata database, SQLite by default (`FILES_SQLITE_PATH`). Object keys use `{tenantHash}/{assetId}_{version}.{ext}`. `GET /assets` lists ids for the signed-in tenant. Workers: `REDIS_URL=redis://127.0.0.1:6379 npx filevora worker`.

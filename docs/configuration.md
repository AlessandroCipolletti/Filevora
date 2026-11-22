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

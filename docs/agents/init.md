# filevora init

`filevora init` writes a starting point for an application. It does not prompt.

```bash
filevora init --dir . --mode lite --dry-run --json
filevora init --dir . --mode stored --database-url postgres://user:password@127.0.0.1:5432/app --json
filevora init --framework hono --mode lite --force
```

Flags:

- `--framework` is `express`, `fastify`, `hono`, `next`, or `node`. When omitted, the command reads `package.json`. Next is chosen over the others, then Fastify, Hono, Express, and plain Node.
- `--mode` is `lite` (default) or `stored`.
- `--database-url` is written into the stored env template.
- `--dry-run` prints the files and the migration step and writes nothing.
- `--json` prints the plan as JSON.
- `--force` replaces generated files. Without it, an existing file returns `INIT_EXISTS` and exit code 1.

Generated files:

- `filevora/handler.ts` wires `createFilesHandler` for the detected framework, including the health route.
- `filevora/upload-snippet.ts` is a `createUploadClient` example.
- `.env.filevora.example` lists only the settings for the chosen mode: filesystem root and Redis, plus `FILEVORA_DATABASE_URL` in stored mode.

Stored mode prints the migrate command for the detected package manager. Lite mode prints that no migration is required.

`filevora init --profile local-s3` still writes a MinIO Compose file and does not start Docker.

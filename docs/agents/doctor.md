# filevora doctor

`filevora doctor --json` checks the process that would run Filevora. Exit code is 1 when any required check fails.

Each check has `id`, `status` (`pass`, `fail`, or `warn`), `code`, `explanation`, and `fix`.

| Check | What it does |
| --- | --- |
| `config` | Validates the resolved configuration. |
| `mode` | Reports lite or stored, and the database driver in stored mode. |
| `storage` | Writes, reads, and deletes a probe in the filesystem root. |
| `metadata` | In stored mode, connects and reads `filevora_assets`. Lite mode has no database. |
| `redis` | Pings Redis and reads the BullMQ queue when `REDIS_URL` is set. An unset URL is a warning, `DOCTOR_REDIS_UNSET`. |
| `ffmpeg` / `ffprobe` | Looks for both binaries. |
| `scanner` | When `FILEVORA_MALWARE_SCAN=clamav`, opens a TCP connection to clamd. |
| `webhook` | Checks that a configured URL has a secret and passes the URL-import SSRF rules. |

`runDoctor` from `filevora/server` is not a public export. Import it from the package diagnostics through the CLI, or mount the health route:

```ts
const handler = createFilesHandler({
  files,
  health: true,
  authenticate,
  authorize,
  policy,
});
```

`GET /health` returns the same JSON. Pass `{ path: '/ready' }` to move it. The route does not require a principal. A required failure responds with HTTP 503.

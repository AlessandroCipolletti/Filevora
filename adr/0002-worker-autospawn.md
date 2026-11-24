# ADR 0002: Worker auto-spawn

## Status

Accepted

## Problem

Embedded mode should process jobs without a second command, without starting a worker on import or during a build, and without duplicating workers on hot reload.

## Constraints

No shell interpolation. `worker_threads` are not a substitute for a child process. Serverless and edge cannot hold a child. Windows and Unix must share one locking approach.

## Options

1. A lease row in the metadata database plus a pid liveness check, then `spawn` of the Node entry with `shell: false`.
2. A filesystem flock.
3. Always require a separately started worker.

## Decision

Use a supervisor lease in SQLite or Postgres. The parent spawns `process.execPath` on the packaged worker file only after it acquires an expired or missing lease. A live pid with a fresh heartbeat blocks another spawn. Production serverless or edge with on-demand spawn fails with `WORKER_UNSUPPORTED_RUNTIME`. Distributed mode never auto-spawns.

## Rejected alternatives

Flock behavior differs on Windows and on network filesystems. Requiring a manual worker breaks the single-command local path.

## Security and reliability

The child gets configuration through the environment and a mode `0600` file when secrets are required. The parent does not pass arguments through a shell. Crash recovery reclaims expired leases. This does not promise the child survives an OS reboot.

## Migration

Hosts that move from embedded to distributed set `FILES_WORKER_AUTOSPAWN=false` and run `filevora worker`.

## Tests

Added with M3: one dev command, no duplicate spawn, kill and retry.

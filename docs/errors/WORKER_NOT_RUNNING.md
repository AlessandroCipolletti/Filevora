# WORKER_NOT_RUNNING

The processing worker is not running.

Category: `processing`. HTTP 503. Retryable: true.

No live worker heartbeat was found. Embedded mode starts a child on the first job only in a long-running Node process.

- run_worker: Start a worker with npx filevora worker, or enable on-demand spawn in a long-running process. (`npx filevora worker`)

Verify: `npx filevora doctor --json`

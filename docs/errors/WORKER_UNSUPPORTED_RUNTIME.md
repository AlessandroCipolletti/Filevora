# WORKER_UNSUPPORTED_RUNTIME

This runtime cannot host a persistent Filevora worker.

Category: `processing`. HTTP 501. Retryable: false.

Serverless and edge runtimes cannot keep a durable child worker. Use a long-running Node host or distributed workers.

- move_worker: Run the app on a long-running Node server, or set FILES_PROCESSING_MODE=distributed and deploy npx filevora worker separately.

Verify: `npx filevora doctor --json`

# Architecture

Filevora is one npm package with five public entry points.

| Import            | Runs in | Responsibility                                         |
| ----------------- | ------- | ------------------------------------------------------ |
| `filevora/server` | Node    | Configuration and, in later milestones, file lifecycle |
| `filevora/http`   | Node    | Host-authenticated HTTP adapter                        |
| `filevora/client` | Browser | Upload helper. No server secrets                       |
| `filevora/worker` | Node    | Job processor. Not started on import                   |
| `filevora/types`  | Either  | Shared types                                           |

The host application owns identity and business records. Filevora will own bytes, upload sessions, variants, and jobs.

Planned drivers are filesystem and customer-owned S3, with SQLite or customer-owned Postgres. A future managed provider may implement the same storage interface in another repository. This package reserves the config keys and rejects that provider.

Importing or constructing the SDK must not spawn a process. M0 does not open SQLite or create directories.

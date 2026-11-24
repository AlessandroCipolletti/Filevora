# DESCRIPTION_REQUIRES_DATABASE

Descriptions are stored in the database. Lite mode cannot store them.

Category: `config`. HTTP 422. Retryable: false.

Tags and descriptions stay on the host database so asset queries stay fast. They are never written to asset cards or object storage. Set `FILEVORA_DATABASE_URL` to `postgres://` or `postgresql://`, `mysql://` or `mariadb://`, or `sqlite://./filevora.sqlite`, then run `npx filevora migrate`.

- enable_stored_mode: Set `FILEVORA_DATABASE_URL` and run `npx filevora migrate`.

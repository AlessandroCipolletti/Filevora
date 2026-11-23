# FEATURE_REQUIRES_STORED_MODE

Listing, search, retention, and `filevora migrate` need stored metadata mode.

Category: `config`. HTTP 400. Retryable: false.

Lite mode keeps bytes in object storage and the processing queue in Redis. It does not keep an SDK database file.

- set_mode: Set `FILEVORA_METADATA_MODE=stored` and `FILEVORA_DATABASE_URL` to the host database.
- migrate: Run `npx filevora migrate` to create `filevora_assets` and `filevora_asset_versions`.

See [stored mode](../agents/install.md#stored-mode). Verify with `npx filevora doctor --json`.

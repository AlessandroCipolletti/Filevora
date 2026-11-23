# Lite and stored metadata

Filevora has two metadata modes. The processing queue is Redis and BullMQ in both.

Lite (`FILEVORA_METADATA_MODE=lite`, the default) stores bytes in object storage and does not create a database file. Get-by-id probes `{tenantHash}/{assetId}_original.{ext}` and `{assetId}_{version}.{ext}`. List, search, and `filevora migrate` return `FEATURE_REQUIRES_STORED_MODE` with the env vars, migrate command, and doctor check.

Stored mode writes `filevora_assets` and `filevora_asset_versions` only in the database the host names with `FILEVORA_DATABASE_URL`. The SDK does not choose a private SQLite path of its own. A host may point that URL at its own SQLite file or at Postgres.

Non-derivable fields in lite (original filename, owner, checksum, processing status) are JSON cards under the storage root. Version bytes are the objects. Redis is not an asset registry.

# ASSET_NOT_FOUND

No original object was found for this asset id in the caller's tenant.

Category: `storage`. HTTP 404. Retryable: false.

Lite get-by-id probes `{tenantPrefix}/{assetId}_original.{ext}`. Redis is not an asset registry.

- check_id: Use the `assetId` returned when the upload session was created.

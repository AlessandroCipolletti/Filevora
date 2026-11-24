# STORAGE_UNAVAILABLE

Object storage is unavailable.

Category: `storage`. HTTP 503. Retryable: true.

The storage driver could not read or write the object.

- check_storage: Check the filesystem permissions or S3 credentials and endpoint.

Verify: `npx filevora doctor --json`

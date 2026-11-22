# ADR 0004: S3-compatible emulator

## Status

Accepted

## Problem

Direct-to-S3 uploads need a test target. Docker was not available in the implementation environment, and default tests must not require it.

## Constraints

Do not claim every S3 vendor behaves the same. Do not require MinIO for `pnpm test`.

## Options

1. In-process path-style HTTP emulator plus a documented MinIO Compose profile.
2. Require MinIO or LocalStack in Docker.
3. Mock the AWS SDK and skip bytes.

## Decision

Tests talk to a small path-style emulator through `@aws-sdk/client-s3`. The emulator stores parts and checks that the raw secret is not in the URL. `filevora init --profile local-s3` writes a MinIO Compose file for people who want a full server. Capability differences are probed, not assumed. AWS SDK checksum defaults are set to `WHEN_REQUIRED` so presigned browser PUTs do not depend on unsigned checksum headers.

## Rejected alternatives

A mocked client would not show that bytes go to the storage endpoint. Requiring Docker would make the default test run environment-specific.

## Security and reliability

The emulator is a test double. It is not a production object store. Presigned URLs still must not contain the secret key.

## Migration

None for application code. The storage driver stays the same when the endpoint changes from the emulator to AWS, R2, or MinIO.

## Tests

M6. Filesystem tests stay free of Docker.

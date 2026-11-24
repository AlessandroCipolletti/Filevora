# ADR 0008: Storage delivery

## Status

Accepted

## Problem

Private files need a URL the browser can fetch. Filesystem objects have no S3 presigner. S3 presigns cannot be revoked early.

## Constraints

Default visibility is private. Public objects require an explicit flag. URLs are not the stored identifier.

## Options

1. HMAC tokens on an SDK route for filesystem, S3 presigned GET for S3.
2. Proxy every S3 download through the app.
3. Unsigned filesystem paths.

## Decision

Option 1. Filesystem tokens use the persisted signing secret, expire, and are checked against deletion. S3 uses presigned GET. Issuing a URL is recorded as `url-issued` evidence only, never as a view. Applications store file ids.

## Rejected alternatives

Proxying all S3 bytes removes direct delivery. Unsigned paths expose the disk layout.

## Security and reliability

Document that an S3 URL stays valid until it expires even if the app later denies the user. Keep TTLs short (default 900 seconds).

## Migration

Switching drivers changes the URL host. Callers already treat URLs as ephemeral.

## Tests

M4 filesystem tokens, expiry, and deletion. M6 presign contents do not include the secret.

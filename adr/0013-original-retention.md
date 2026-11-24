# ADR 0013: Original retention

## Status

Accepted

## Problem

Processing failures and aggressive retention can destroy the only copy of a file.

## Constraints

Originals stay unless the operator opts out. Retention is off by default.

## Options

1. `preserveOriginal: true` and `retention.enabled: false` by default. Failed processing deletes temp artifacts only.
2. Drop originals after variants exist.

## Decision

Option 1. `keepOriginal: false` or a max-age rule deletes originals only through the retention sweep, which supports dry-run, pins, and grace. Enabling retention without a max age or inactivity TTL is `RETENTION_POLICY_UNSAFE`. Inactivity uses the configured evidence timestamp and does not treat a missing timestamp as idle.

## Rejected alternatives

Deleting the original as soon as a variant exists is surprising and breaks reprocessing.

## Security and reliability

Sweeps are idempotent and audited. Pins and legal hold skip the file.

## Migration

Turning retention on requires a dry-run review.

## Tests

M9.

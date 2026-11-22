# ADR 0014: Commercial portability

## Status

Accepted

## Problem

A later hosted service must not trap metadata in a private format. This repository does not build that service.

## Constraints

Same application API for filesystem and S3. Export must be something the host can read without Filevora's servers.

## Options

1. Versioned JSON metadata export and import. Bytes stay in the configured object store.
2. A binary snapshot format.

## Decision

Option 1. Document version is `METADATA_EXPORT_VERSION`. Ids stay opaque strings (`file_`, `variant_`, `job_`, `upl_`). The export is tenant-scoped. Import refuses another tenant's ids rather than remapping them silently across tenants.

## Rejected alternatives

A private binary format would contradict the portability goal.

## Security and reliability

Export requires the metadata.export operation. It does not include signing secrets or storage credentials.

## Migration

Future cloud workers can read the same job payload schema.

## Tests

M7 or M11 round-trip, plus the M6/M1 assertion that the server API shape is shared by filesystem and S3 once both exist.

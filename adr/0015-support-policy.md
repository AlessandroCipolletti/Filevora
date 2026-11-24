# ADR 0015: Support policy

## Status

Accepted

## Problem

The specification asks for an explicit matrix. Only environments that actually ran tests may be called verified.

## Constraints

Node, not Bun. ESM. No claim of Windows CI until it has run.

## Options

1. Support Node `>=22.13` because of `node:sqlite`, and record the OS and version under test.
2. Support every current Node LTS without checking `node:sqlite`.

## Decision

Engines field is `>=22.13`. Verified locally on darwin, Node v26.5.0. GitHub Actions targets Ubuntu and Node 22 and is not treated as a passed run until CI has executed. Browsers need `fetch`, `File`, `AbortController`, and `IndexedDB` for the client once M2 lands. FFmpeg is "the system binary", not a pinned version, and doctor prints the version it found. S3 vendors are compatible only for the operations the capability probe reports.

## Rejected alternatives

Claiming Windows, AWS, R2, and a Node 20 line without tests would make the manifest false.

## Security and reliability

Unsupported runtimes fail at config time when they cannot host a worker.

## Migration

Raising the engine floor is a major release if it drops a previously tested Node version.

## Tests

M0 records the local runtime. Later milestones append verified processors and drivers.

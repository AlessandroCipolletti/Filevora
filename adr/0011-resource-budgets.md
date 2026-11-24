# ADR 0011: Resource budgets

## Status

Accepted

## Problem

Unbounded uploads and transcodes will exhaust disk and CPU.

## Constraints

Defaults must be safe for a laptop and overridable by the host.

## Options

1. Documented numeric defaults in the config schema.
2. No limits until an operator sets them.

## Decision

Defaults: max file 100 MiB, image 40 million pixels, video duration 600 seconds, output height 1080, worker concurrency 2, job attempts 5, lease 120 seconds, job timeout 3600 seconds, temp budget 2 GiB, upload chunk 8 MiB, multipart threshold 16 MiB, batch size 10, delivery TTL 900 seconds, session TTL 24 hours. S3 parts in production must be at least 5 MiB. Tests may lower filesystem chunk size but not below 64 KiB. Never upscale unless a recipe asks for a size and the guard still caps height at the source when the preset says so.

## Rejected alternatives

Unlimited defaults fail open.

## Security and reliability

Limits are application-level. They are not a cgroup. Documentation says so.

## Migration

Raising a limit is a config change. Lowering it does not delete existing objects.

## Tests

Each processor milestone includes a limit rejection test.

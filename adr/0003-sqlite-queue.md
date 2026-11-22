# ADR 0003: SQLite queue

## Status

Accepted

## Problem

Local mode needs a durable queue without Redis. The same semantics must exist on Postgres later.

## Constraints

At-least-once delivery, leases, heartbeat, backoff, dead-letter, and idempotent jobs. SQLite WAL is single-host only.

## Options

1. A small transactional queue in the metadata database.
2. Graphile Worker (Postgres only).
3. BullMQ (Redis).

## Decision

Custom queue in the metadata database. SQLite uses `BEGIN IMMEDIATE` and `node:sqlite`. Postgres uses `FOR UPDATE SKIP LOCKED`. Jobs carry a schema version and an idempotency key. Unknown failures retry until `maxAttempts`, then move to `dead`.

## Rejected alternatives

Redis violates the zero-extra-infrastructure default. A Postgres-only library leaves SQLite without a queue.

## Security and reliability

Claim is atomic per database. Jobs are not exactly-once. Variant publication must be idempotent. Do not run two writers against copied SQLite files.

## Migration

Moving to Postgres is a metadata driver change, not an application rewrite.

## Tests

M3 covers claim, retry, and crash. M7 covers the Postgres SQL.

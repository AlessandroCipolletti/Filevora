# ADR 0012: Semantic search

## Status

Accepted

## Problem

The specification lists embeddings as a later phase. The interfaces should not block it, and this release must not pretend it exists.

## Constraints

No model calls required for core behavior. No silent upload of private bytes.

## Options

1. Leave an unsupported capability and no runtime adapter.
2. Ship an embedding interface that calls an API when a key is present.

## Decision

Option 1. `semanticSearch` is `unsupported` in the capability manifest. No index is written.

## Rejected alternatives

A half-built embedding call would risk sending file contents to a third party.

## Security and reliability

A future adapter must be opt-in, tenant-scoped, and covered by a redaction test before it is marked tested.

## Migration

None until that phase.

## Tests

The manifest test asserts `semanticSearch` is `unsupported`.

# ADR 0007: API authorization

## Status

Accepted

## Problem

The SDK must not grow an account system, and it must not trust the browser for tenant identity.

## Constraints

Host owns authentication. Every browser-facing operation needs an explicit allow.

## Options

1. Required `authenticate`, `authorize`, and `policy` callbacks. Principal tenant and user ids are the only scope.
2. Optional auth with a development allow-all default.
3. Filevora-issued API keys.

## Decision

Option 1. `createFilesHandler` throws if any callback is missing. Request JSON fields named `ownerId` or `tenantId` are ignored. A server-side `policy.ownerId` is used only when it equals the principal id; otherwise the principal id wins. Cross-tenant reads return `NOT_FOUND`.

## Rejected alternatives

An allow-all default becomes a production hole. API keys would start the hosted control plane, which this repository does not build.

## Security and reliability

Signed download tokens are capabilities for bytes already authorized at issuance time. They are bound to a file id and expiry and are rejected after delete.

## Migration

Applications pass the three callbacks. There is no later compatible default.

## Tests

M0 requires the callbacks. M1 and E2E-06 cover cross-tenant denial.

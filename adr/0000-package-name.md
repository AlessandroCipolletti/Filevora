# ADR 0000: Package name

## Status

Accepted

## Problem

The specification used the placeholder name universal-files and the scope `@universal-files/sdk`. The product name is Filevora.

## Constraints

Unscoped npm name preferred when free. Public imports must be `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, and `filevora/types`. The CLI binary is `filevora`.

## Options

1. Unscoped `filevora`.
2. Scoped `@filevora/sdk` or unscoped `filevora-sdk` if the unscoped name was taken.

## Decision

Use unscoped `filevora`. On 2026-11-22, `npm view filevora` returned HTTP 404, so the name was not registered. `@filevora/sdk` and `filevora-sdk` were also unregistered and were not needed.

## Rejected alternatives

Keeping `@universal-files/sdk` would contradict the product name the maintainer chose.

## Security and reliability

The package must not imply a hosted account. The name does not change the rule that `managed` is unsupported.

## Migration

None. This is the first publishable name. It has not been published.

## Tests

`packages/filevora/package.json` name and the fixture import are asserted in `packages/filevora/test/m0.test.ts`.

## Follow-up for Alessandro

A trademark search was not performed. Publish only after you confirm the name is acceptable to ship.

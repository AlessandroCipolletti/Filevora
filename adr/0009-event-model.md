# ADR 0009: Event model

## Status

Accepted

## Problem

Clients need to know when processing finishes. SSE, webhooks, and polling all have different failure modes.

## Constraints

The baseline must work through ordinary HTTP and a browser `fetch`.

## Options

1. Poll file state. Optional HMAC webhooks. No SSE in this release.
2. SSE first.
3. Require a third-party socket service.

## Decision

Option 1. `waitForProcessing` polls. Webhooks POST a JSON body with `Filevora-Signature: t=<unix>,v1=<hex>` over `t + '.' + body`. Production webhook targets must be HTTPS and must not be loopback, link-local, or private. Development may allow loopback only when `webhooks.allowLoopback` is true.

## Rejected alternatives

SSE needs extra proxy configuration and is easy to claim without retry tests. An external socket service is another account.

## Security and reliability

Receivers reject timestamps outside five minutes. The SDK does not follow redirects to private addresses.

## Migration

SSE can be added later without removing polling.

## Tests

M2 polling via the client. M10 webhook signature and private-target rejection.

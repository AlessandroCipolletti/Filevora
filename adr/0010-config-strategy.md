# ADR 0010: Config strategy

## Status

Accepted

## Problem

Environment variables are easy to mis-set, and a typed object is easier to test. Both are required by the specification.

## Constraints

Do not execute config from uploaded files. Do not load `.env` implicitly. Production must not inherit development defaults silently when that is unsafe.

## Options

1. Zod schema. Explicit options override `FILES_*`, which override defaults.
2. Environment variables only.
3. A `files.config.ts` loader that imports arbitrary user code from a convention path.

## Decision

Option 1. The Postgres schema default is `filevora` (the specification sample used `universal_files`). Unknown top-level option keys fail. `filevora config validate --json` prints the redacted result.

## Rejected alternatives

Env-only configuration hides nested conflicts. Auto-loading a TypeScript file from the working directory would execute untrusted project code during library construction.

## Security and reliability

Validation is the gate for serverless spawn, public visibility, ephemeral roots, and managed providers.

## Migration

New variables need a schema field, a redaction test if secret, and a docs line.

## Tests

M0 precedence, rejection, and redaction tests.

# ADR 0001: Package layout

## Status

Accepted

## Problem

The specification allows an internal monorepo but requires one install.

## Constraints

Browser code must not pull Node, Sharp, or cloud SDKs. One public package.

## Options

1. One package, conditional exports, internal source folders.
2. Many published packages under an npm scope.
3. Optional processor packages that the host must install for core upload.

## Decision

Publish only `packages/filevora`. Examples live in the workspace and are not published. Heavy processors are optional dependencies added in the milestone that uses them. The core install can validate configuration without them.

## Rejected alternatives

A multi-package public API costs extra installs and makes the browser boundary harder to audit.

## Security and reliability

The client export is the only browser entry. A bundle test fails if Node built-ins appear.

## Migration

New public imports require a new export and a bundle or type test.

## Tests

Export map, fixture import, and esbuild browser bundle in M0 tests.

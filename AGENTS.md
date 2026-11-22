# Agents working in this repository

Filevora is the public npm SDK. Do not add billing, accounts, API-key issuance, a customer dashboard, UI components, or a hosted control plane. A separate private project will provide paid hosting later. In this repo, `managed` and `hybrid` providers throw `FEATURE_NOT_AVAILABLE`.

## Commands

From the repository root, with pnpm and Node `>=22.13`:

```bash
pnpm install
pnpm verify
```

`pnpm verify` builds the package, typechecks `src` and tests, typechecks `examples/fixture-app`, runs Biome, and runs `node --test`.

Useful pieces:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
node packages/filevora/bin/filevora.js --help
```

Tests use Node's built-in runner and TypeScript strip types. Do not use Bun.

## Layout

- `packages/filevora` is the only published package. Public imports are `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, and `filevora/types`.
- `src/client` must not import Node built-ins, `sharp`, or cloud SDKs. `packages/filevora/test/m0.test.ts` bundles it with esbuild to enforce that.
- Examples under `examples/` are host-app wiring. The SDK does not ship a UI.
- Architecture choices live in `adr/`. Change a decision with a new ADR, not a silent edit.

## Rules that tests enforce

- Do not mark a feature `tested` in `docs/agents/capabilities.json` unless `packages/filevora/test/m0.test.ts` (or a later test file) allowlists it. Keep `packages/filevora/capabilities.json` identical; the build copies the docs file... currently both files are checked for equality. Update both.
- Do not claim upload, FFmpeg, S3, or Postgres behavior in the README until a test demonstrates it.
- Never log signing secrets, S3 secrets, database URLs, or cloud keys. Use `redactConfig` / `redactValue`.
- Do not trust `ownerId` or `tenantId` from a browser body. The HTTP adapter must take them from the host `authenticate` callback.
- Do not accept arbitrary shell or FFmpeg argument strings from requests.
- Do not download FFmpeg or other binaries on install.

## Milestones

Implement in order: M0 foundations, M1 local storage, M2 resumable client, M3 queue and worker, M4 images, M5 video and audio, M6 S3, M7 Postgres, M8 PDF and tabular, M9 retention, M10 diagnostics, M11 hardening. Each milestone gets one commit after its checks pass.

## Current milestone

M3. The embedded worker is a single child process with lease recovery. Preset jobs fail with `PROCESSOR_UNAVAILABLE` until a processor milestone lands. S3 and Postgres are still unavailable.

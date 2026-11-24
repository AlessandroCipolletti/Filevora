# Agents working in this repository

Filevora is the public npm SDK. Do not add billing, accounts, API-key issuance, a customer dashboard, UI components, or a hosted control plane. A separate private project will provide paid hosting later. In this repo, `managed` and `hybrid` providers throw `FEATURE_NOT_AVAILABLE`.

## Commands

From the repository root, with pnpm and Node `>=22.13`:

```bash
pnpm install
pnpm dev
pnpm dev:client
pnpm run ci
pnpm run verify
```

`pnpm dev` runs Vite in library mode with `--watch`. Each file under `packages/filevora/src` is emitted as its own ES module in `dist/`, which is what the tests, the CLI, and the worker child import. `pnpm dev:client` is the Vite dev server for the browser entry only (`packages/filevora/dev/index.html` on `http://127.0.0.1:5173`). That page is not published.

`pnpm build` is `vite build`. Vite writes the JavaScript and, through `vite-plugin-dts`, the `.d.ts` files. `tsc` still typechecks (`pnpm typecheck` runs `tsc --noEmit` on `src`, `vite.config.ts`, the tests, and the fixture). `tsc` does not emit the JavaScript.

`pnpm run ci` typechecks, runs ESLint and Prettier, runs knip, and runs madge for circular imports. The pre-commit hook runs that script and blocks the commit when it fails. pnpm treats bare `pnpm ci` as its own command, so use `pnpm run ci`.

`pnpm run verify` runs `pnpm run ci` and then the package tests. Do not call bare `pnpm ci`. pnpm reserves that word and does not run the script.

Useful pieces:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm knip
pnpm circular
pnpm test
node packages/filevora/bin/filevora.js --help
```

Tests use Node's built-in runner and TypeScript strip types. Do not use Bun. The browser check bundles both `src/client/index.ts` and `dist/client/index.js` with esbuild and rejects Node built-ins.

## Layout

- `packages/filevora` is the only published package. Public imports are `filevora/server`, `filevora/client`, `filevora/http`, `filevora/worker`, `filevora/types`, `filevora/testing`, and `filevora/manifest`.
- `src/client` must not import Node built-ins, `sharp`, or cloud SDKs. `packages/filevora/test/m0.test.ts` bundles the source and the Vite output with esbuild to enforce that.
- Do not point `new URL('./file.js', import.meta.url)` at a local module. Vite rewrites that into an inlined asset. The worker child path is `path.join(dirname, 'child.js')` so `dist/worker/child.js` stays a real file.
- Processing progress is SSE consumed with `fetch`, so the host `Authorization` header is preserved. Polling is the fallback. Do not store signed URLs in the resume store. `history()` refetches them. See `adr/0017-processing-progress-channel.md` and `adr/0018-upload-history-storage.md`.
- Encoding jobs go to BullMQ on `REDIS_URL`. Do not put the asset registry in Redis. Default metadata mode is `lite`: object storage plus Redis, and no SDK database file. A `FILEVORA_DATABASE_URL` selects stored mode. The URL scheme picks PostgreSQL, MySQL/MariaDB, or SQLite. Migrate creates only `filevora_assets` and `filevora_asset_versions`. Object keys are `{tenantHash}/{assetId}_{version}.{ext}`. `GET /files` works in lite for non-description filters. `GET /assets` and `filevora migrate` return `FEATURE_REQUIRES_STORED_MODE` in lite.
- GitHub Actions runs typecheck, lint, knip, circular, build, and the test jobs as separate nodes. Local `pnpm run ci` and the pre-commit hook stay one script.
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

M0–M11 are in the tree. Follow-up work added GitHub Actions, gated networked S3 and Postgres tests, PDF page previews, and a conditional FFmpeg WebP poster. The package has not been published. Alessandro still needs to confirm the npm name `filevora` before any publish.

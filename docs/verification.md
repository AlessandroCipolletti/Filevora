# Verification

Commands were run on darwin, Node v26.5.0, from `/Users/cippo/Workspace/Me/Filevora`. GitHub Actions has not been executed here.

## M0

```text
pnpm typecheck
pnpm exec biome check .
pnpm --filter filevora test
```

`pnpm typecheck` built `packages/filevora`, typechecked the package tests, and typechecked `examples/fixture-app`. Exit 0.

`biome check` reported no errors. Exit 0.

`pnpm --filter filevora test` ran 15 tests. 15 passed, 0 failed. The run covered config precedence, secret redaction, managed-provider rejection, production storage guards, the browser bundle, the capability allowlist, the CLI, error notes, and the fixture import.

## M1

```text
pnpm --filter filevora build
pnpm --filter filevora exec node --experimental-strip-types --test --test-reporter=spec test/m1.test.ts
pnpm exec biome check .
pnpm --filter filevora test
```

The M1 file reported 3 tests passed: in-process upload and restart, mime/quota/idempotency failures, and `examples/node-minimal/server.ts` upload followed by a new process reading the same SQLite file. The full suite after that change reported 18 tests passed and 0 failed. Biome reported no errors.

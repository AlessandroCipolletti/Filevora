# Verification

Run from the repository root:

```bash
pnpm verify
```

That builds `packages/filevora`, typechecks the package tests and `examples/fixture-app`, runs Biome, and runs the Node test runner.

M0 checks:

- `packages/filevora/test/m0.test.ts` covers config precedence, redaction, managed-provider rejection, serverless rejection, ephemeral production storage, the browser bundle, the capability allowlist, the CLI, and the fixture import.
- A feature in `docs/agents/capabilities.json` may be `tested` only if that test allowlists it.

Record command output in `docs/verification.md` after a real run. Do not paste expected output before the command has run.

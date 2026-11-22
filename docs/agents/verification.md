# Verification

Run from the repository root:

```bash
pnpm verify
```

That runs `pnpm run ci` (typecheck, ESLint, Prettier, knip, and a madge circular-import check) and then the Node test runner. The pre-commit hook runs `pnpm run ci` only.

M0 checks:

- `packages/filevora/test/m0.test.ts` covers config precedence, redaction, managed-provider rejection, serverless rejection, ephemeral production storage, the browser bundle, the capability allowlist, the CLI, and the fixture import.
- A feature in `docs/agents/capabilities.json` may be `tested` only if that test allowlists it.

Record command output in `docs/verification.md` after a real run. Do not paste expected output before the command has run.

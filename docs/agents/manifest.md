# Capability manifest

`docs/agents/capabilities.json` is the machine-readable description of this package. Schema version 2 keeps the feature status list and adds `catalog`.

`catalog` is generated from source:

- public exports, from `package.json` and each entry file
- HTTP routes, from `HTTP_ROUTES`
- config keys, from the Zod options schema
- env variables, from `envSchema`, with the default used when the variable is unset and whether it applies to lite, stored, or both
- error codes, from `ERROR_CATALOG`, including the cause and the first fix
- the progress event fields, from `PROGRESS_EVENT_FIELDS`

Feature status and the prose notes live in `docs/agents/capabilities.hand.json`. Change those there, then run:

```bash
pnpm manifest
```

`pnpm manifest:check` is part of `pnpm run ci` and of the GitHub Actions build job. It fails when the committed copies differ. The package copy and the docs copy are the same bytes.

```bash
npx filevora manifest --json
```

```ts
import { readManifest } from 'filevora/manifest';
```

`npx filevora mcp` speaks MCP on stdin and stdout. It does not add a dependency. Tools:

- `manifest_lookup` with an optional dotted `section`
- `validate_config` with a string `env` map
- `doctor` with an optional string `env` map

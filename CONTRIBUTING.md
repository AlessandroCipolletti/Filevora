# Contributing

Issues and pull requests are welcome on GitHub. The local check is:

```bash
pnpm install
pnpm run ci          # typecheck, lint, knip, circular imports, manifest check
pnpm test:docker     # the full test suite, with Redis, MinIO, Postgres, and MySQL in Docker
```

`pnpm test:docker` needs Docker with Compose v2. It starts the services from `docker-compose.test.yml` on non-default ports (16379, 19000, 15432, 13306), exports every variable the networked tests read (see `scripts/test-env.ts`), runs `pnpm test`, and always removes the containers and their data afterwards, even on failure or Ctrl+C. No networked test is skipped. `pnpm services:up` and `pnpm services:down` start and stop the services by hand.

Plain `pnpm test` (and `pnpm run verify`) needs a reachable `REDIS_URL` and stops at once with a pointer to `pnpm test:docker` when it is missing. Without S3, Postgres, or MySQL variables those networked tests skip, which is what the `test` job in GitHub Actions does. The default end-user setup is unchanged: filesystem storage, no database, and Redis only for worker mode. The Docker services are for testing this repository only.

Use Node (not Bun). Keep changes scoped to one milestone or one bug. Update `CHANGELOG.md`, `README.md`, `AGENTS.md`, and `docs/agents/capabilities.json` when behavior changes. Add an ADR before changing a decision in `adr/`.

Add new `CHANGELOG.md` entries under `## Unreleased` at the top. Do not publish to npm from a pull request. Maintainers release with `pnpm release`; see [docs/releasing.md](docs/releasing.md). Do not add billing, accounts, or a hosted service.

The license is MIT. See `LICENSE`.
